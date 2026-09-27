// Tests for ticketed library uploads (2026-09-27): Hearth mints a ticket server side, the
// browser PUTs the raw file straight to Halseth, so Vercel's ~4.5 MB function body cap never
// sees a book. Covers every refusal the handoff names (expired, forged, missing, over
// max_bytes, another origin, no secret configured, replayed), the happy PDF + epub paths,
// the 409 -> replace flow through the new transport, CORS on every response, and the
// locked preflight. Fake D1 keyed by SQL, Map-backed R2 and KV.

import { describe, it, expect } from "vitest";
import {
  postBook, postUploadTicket, putBookUpload, optionsBookUpload,
} from "../handlers/books.js";
import { mintUploadTicket, verifyUploadTicket, TICKET_TTL_SECONDS } from "../lib/upload-ticket.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private books: Row[], private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.books, args); }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO books")) {
      const [id, title, author, description, language, file_key, file_type, file_size, cover_key] = this.bound;
      this.books.push({ id, title, author, description, language, file_key, file_type, file_size, cover_key });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE books SET title = ?")) {
      const row = this.books.find(b => b["id"] === this.bound[this.bound.length - 1]);
      if (!row) return { meta: { changes: 0 } };
      row["title"] = this.bound[0];
      row["file_size"] = this.bound[6];
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first(): Promise<Row | null> {
    if (this.sql.includes("FROM books WHERE lower(title)")) {
      const [title, author] = this.bound as [string, string | null];
      return this.books.find(b =>
        String(b["title"]).toLowerCase() === title.toLowerCase() &&
        String(b["author"] ?? "").toLowerCase() === String(author ?? "").toLowerCase()
      ) ?? null;
    }
    return null;
  }
}

const ADMIN_SECRET = "test-admin-secret";
const TICKET_SECRET = "test-ticket-secret";
const HEARTH = "https://hearth.example";
const BASE = "https://halseth.example";

interface Harness { env: Env; books: Row[]; bucket: Map<string, unknown>; kv: Map<string, string> }

function harness(overrides: Partial<Record<"UPLOAD_TICKET_SECRET" | "HEARTH_ORIGIN", string | undefined>> = {}): Harness {
  const books: Row[] = [];
  const bucket = new Map<string, unknown>();
  const kv = new Map<string, string>();
  const env = {
    DB: { prepare: (sql: string) => new FakeStatement(sql, books) },
    BUCKET: {
      put: async (key: string, value: unknown) => {
        // A stream must be consumed the way R2 would; store the bytes so tests can read them.
        if (value instanceof ReadableStream) value = await new Response(value).arrayBuffer();
        bucket.set(key, value);
      },
      get: async (key: string) => bucket.get(key) ?? null,
      delete: async (key: string) => { bucket.delete(key); },
    },
    LIBRARIAN_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
    ADMIN_SECRET,
    UPLOAD_TICKET_SECRET: TICKET_SECRET,
    HEARTH_ORIGIN: HEARTH,
    ...overrides,
  } as unknown as Env;
  return { env, books, bucket, kv };
}

async function ticketFor(env: Env, nowMs?: number): Promise<string> {
  const minted = await mintUploadTicket(env, nowMs);
  if (!minted) throw new Error("mint failed");
  return minted.ticket;
}

function putReq(
  ticket: string | null,
  body: Uint8Array | ArrayBuffer,
  opts: { params?: Record<string, string>; origin?: string | null; length?: string | null; type?: string } = {},
): Request {
  const url = new URL(`${BASE}/mind/books/upload`);
  if (ticket !== null) url.searchParams.set("ticket", ticket);
  for (const [k, v] of Object.entries(opts.params ?? { filename: "book.pdf" })) url.searchParams.set(k, v);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const headers: Record<string, string> = { "Content-Type": opts.type ?? "application/pdf" };
  if (opts.origin !== null) headers["Origin"] = opts.origin ?? HEARTH;
  const req = new Request(url, { method: "PUT", headers, body: bytes });
  // Node's Request drops a hand-set Content-Length; fake the header the Workers runtime delivers.
  const length = opts.length === undefined ? String(bytes.byteLength) : opts.length;
  const realGet = req.headers.get.bind(req.headers);
  Object.defineProperty(req.headers, "get", {
    value: (name: string) => name.toLowerCase() === "content-length" ? length : realGet(name),
  });
  return req;
}

// ── minimal epub (stored zip entries), same construction as epub.test.ts ─────────────────
function u16(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }
function buildEpub(): Uint8Array {
  const enc = new TextEncoder();
  const entries = [
    { name: "META-INF/container.xml", data: enc.encode(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: "OEBPS/content.opf", data: enc.encode(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Overstory</dc:title><dc:creator>Richard Powers</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="ci" href="cover.png" properties="cover-image" media-type="image/png"/></manifest></package>`) },
    { name: "OEBPS/cover.png", data: new Uint8Array(2048).fill(0x42) },
  ];
  const chunks: number[] = [];
  const central: number[] = [];
  for (const e of entries) {
    const name = [...enc.encode(e.name)];
    const off = chunks.length;
    chunks.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...name, ...e.data);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.data.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...name);
  }
  const cd = chunks.length;
  chunks.push(...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(cd), ...u16(0));
  return new Uint8Array(chunks);
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]); // "%PDF" + bytes

describe("POST /mind/books/upload-ticket", () => {
  it("requires admin auth", async () => {
    const { env } = harness();
    const res = await postUploadTicket(new Request(`${BASE}/mind/books/upload-ticket`, { method: "POST" }), env);
    expect(res.status).toBe(401);
  });

  it("returns a ticket, the upload URL on this worker's origin, and the expiry", async () => {
    const { env } = harness();
    const res = await postUploadTicket(new Request(`${BASE}/mind/books/upload-ticket`, {
      method: "POST", headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { ticket: string; upload_url: string; expires_at: string; max_bytes: number };
    expect(body.upload_url).toBe(`${BASE}/mind/books/upload`);
    expect(body.ticket.split(".")).toHaveLength(2);
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan((TICKET_TTL_SECONDS - 5) * 1000);
    expect((await verifyUploadTicket(env, body.ticket)).ok).toBe(true);
  });

  it("fails closed with 503 when UPLOAD_TICKET_SECRET is unset", async () => {
    const { env } = harness({ UPLOAD_TICKET_SECRET: undefined });
    const res = await postUploadTicket(new Request(`${BASE}/mind/books/upload-ticket`, {
      method: "POST", headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    }), env);
    expect(res.status).toBe(503);
  });
});

describe("PUT /mind/books/upload: refusals", () => {
  it("refuses a missing ticket", async () => {
    const { env, bucket } = harness();
    const res = await putBookUpload(putReq(null, PDF), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("missing");
    expect(bucket.size).toBe(0);
  });

  it("refuses an expired ticket", async () => {
    const { env } = harness();
    const stale = await ticketFor(env, Date.now() - (TICKET_TTL_SECONDS + 1) * 1000);
    const res = await putBookUpload(putReq(stale, PDF), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("expired");
  });

  it("refuses a ticket signed with another key", async () => {
    const { env } = harness();
    const forged = await ticketFor(harness({ UPLOAD_TICKET_SECRET: "attacker-key" }).env);
    const res = await putBookUpload(putReq(forged, PDF), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("bad_signature");
  });

  it("refuses a real ticket whose payload was edited (bigger max_bytes)", async () => {
    const { env } = harness();
    const [body, sig] = (await ticketFor(env)).split(".") as [string, string];
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    payload["max_bytes"] = 10 ** 12;
    const edited = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await putBookUpload(putReq(`${edited}.${sig}`, PDF), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("bad_signature");
  });

  it("refuses garbage", async () => {
    const { env } = harness();
    for (const t of ["not-a-ticket", "a.b.c", "."]) {
      const res = await putBookUpload(putReq(t, PDF), env);
      expect(res.status).toBe(401);
    }
  });

  it("refuses everything when UPLOAD_TICKET_SECRET is unset, even a ticket that was once valid", async () => {
    const valid = await ticketFor(harness().env);
    const { env } = harness({ UPLOAD_TICKET_SECRET: undefined });
    const res = await putBookUpload(putReq(valid, PDF), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("not_configured");
  });

  it("refuses a body over the ticket's max_bytes with 413, and does not spend the ticket", async () => {
    const { env, bucket, kv } = harness();
    const ticket = await ticketFor(env);
    const res = await putBookUpload(putReq(ticket, PDF, { length: String(100_000_001) }), env);
    expect(res.status).toBe(413);
    expect(bucket.size).toBe(0);
    expect(kv.size).toBe(0);
  });

  it("refuses a request with no Content-Length (411)", async () => {
    const { env } = harness();
    const res = await putBookUpload(putReq(await ticketFor(env), PDF, { length: null }), env);
    expect(res.status).toBe(411);
  });

  it("refuses a request from another origin", async () => {
    const { env, bucket } = harness();
    const res = await putBookUpload(putReq(await ticketFor(env), PDF, { origin: "https://evil.example" }), env);
    expect(res.status).toBe(403);
    expect(bucket.size).toBe(0);
  });

  it("refuses every browser origin when HEARTH_ORIGIN is unset", async () => {
    const { env } = harness({ HEARTH_ORIGIN: undefined });
    const res = await putBookUpload(putReq(await ticketFor(env), PDF), env);
    expect(res.status).toBe(403);
  });

  it("refuses a replayed ticket", async () => {
    const { env } = harness();
    const ticket = await ticketFor(env);
    expect((await putBookUpload(putReq(ticket, PDF), env)).status).toBe(201);
    const again = await putBookUpload(putReq(ticket, PDF, { params: { filename: "other.pdf" } }), env);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { reason: string }).reason).toBe("used");
  });
});

describe("PUT /mind/books/upload: uploads", () => {
  it("streams a PDF to R2 and writes the row (title from filename)", async () => {
    const { env, books, bucket } = harness();
    const res = await putBookUpload(putReq(await ticketFor(env), PDF, { params: { filename: "The_Dispossessed.pdf" } }), env);
    expect(res.status).toBe(201);
    const { book } = await res.json() as { book: { id: string; title: string; file_type: string } };
    expect(book.title).toBe("The Dispossessed");
    expect(book.file_type).toBe("pdf");
    expect(new Uint8Array(bucket.get(`books/${book.id}.pdf`) as ArrayBuffer)).toEqual(PDF);
    expect(books[0]!["file_size"]).toBe(PDF.byteLength);
  });

  it("extracts an epub's metadata and cover", async () => {
    const { env, books, bucket } = harness();
    const epub = buildEpub();
    const res = await putBookUpload(putReq(await ticketFor(env), epub, {
      params: { filename: "whatever.epub" }, type: "application/epub+zip",
    }), env);
    expect(res.status).toBe(201);
    const { book } = await res.json() as { book: { id: string; title: string; author: string; cover_key: string } };
    expect(book.title).toBe("The Overstory");
    expect(book.author).toBe("Richard Powers");
    expect(book.cover_key).toBe(`covers/${book.id}.png`);
    expect(bucket.has(`books/${book.id}.epub`)).toBe(true);
    expect(bucket.has(book.cover_key)).toBe(true);
    expect(books[0]!["file_size"]).toBe(epub.byteLength);
  });

  it("query metadata overrides extraction", async () => {
    const { env } = harness();
    const res = await putBookUpload(putReq(await ticketFor(env), buildEpub(), {
      params: { filename: "x.epub", title: "Overstory (annotated)", author: "R. Powers" }, type: "application/epub+zip",
    }), env);
    const { book } = await res.json() as { book: { title: string; author: string } };
    expect(book).toMatchObject({ title: "Overstory (annotated)", author: "R. Powers" });
  });

  it("a duplicate is 409 without touching R2, and replace=true overwrites the same id", async () => {
    const { env, books, bucket } = harness();
    const first = await putBookUpload(putReq(await ticketFor(env), buildEpub(), {
      params: { filename: "a.epub" }, type: "application/epub+zip",
    }), env);
    const { book } = await first.json() as { book: { id: string } };
    const objectsAfterFirst = bucket.size;

    const dup = await putBookUpload(putReq(await ticketFor(env), buildEpub(), {
      params: { filename: "b.epub" }, type: "application/epub+zip",
    }), env);
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { existing_id: string }).existing_id).toBe(book.id);
    expect(bucket.size).toBe(objectsAfterFirst);

    const rep = await putBookUpload(putReq(await ticketFor(env), buildEpub(), {
      params: { filename: "b.epub", replace: "true" }, type: "application/epub+zip",
    }), env);
    expect(rep.status).toBe(201);
    expect(((await rep.json()) as { book: { id: string; replaced: boolean } }).book).toMatchObject({ id: book.id, replaced: true });
    expect(books).toHaveLength(1);
  });

  it("a PDF duplicate is refused before its body is streamed", async () => {
    const { env, bucket } = harness();
    await putBookUpload(putReq(await ticketFor(env), PDF, { params: { filename: "Same.pdf" } }), env);
    const puts = bucket.size;
    const dup = await putBookUpload(putReq(await ticketFor(env), PDF, { params: { filename: "Same.pdf" } }), env);
    expect(dup.status).toBe(409);
    expect(bucket.size).toBe(puts);
  });

  it("with no Origin (curl, ops) the ticket alone decides", async () => {
    const { env } = harness();
    const res = await putBookUpload(putReq(await ticketFor(env), PDF, { origin: null }), env);
    expect(res.status).toBe(201);
  });
});

describe("CORS on the upload route", () => {
  it("every response carries the locked origin, errors included, never a wildcard", async () => {
    const { env } = harness();
    const ok = await putBookUpload(putReq(await ticketFor(env), PDF), env);
    const refused = await putBookUpload(putReq(null, PDF), env);
    const dup = await putBookUpload(putReq(await ticketFor(env), PDF), env);
    expect(dup.status).toBe(409);
    for (const res of [ok, refused, dup]) {
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(HEARTH);
      expect(res.headers.get("Vary")).toBe("Origin");
    }
  });

  it("preflight answers Hearth with PUT allowed, and 403s any other origin", async () => {
    const { env } = harness();
    const pre = (origin: string) => optionsBookUpload(new Request(`${BASE}/mind/books/upload`, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
    }), env);
    const good = pre(HEARTH);
    expect(good.status).toBe(204);
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe(HEARTH);
    expect(good.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    const bad = pre("https://evil.example");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("POST /mind/books (multipart) still works through the shared ingest", () => {
  it("uploads, and 409s the same book through the other transport", async () => {
    const { env } = harness();
    const form = new FormData();
    form.set("file", new File([PDF], "Shared_Path.pdf"));
    const res = await postBook(new Request(`${BASE}/mind/books`, {
      method: "POST", headers: { Authorization: `Bearer ${ADMIN_SECRET}` }, body: form,
    }), env);
    expect(res.status).toBe(201);
    const dup = await putBookUpload(putReq(await ticketFor(env), PDF, { params: { filename: "Shared Path.pdf" } }), env);
    expect(dup.status).toBe(409);
  });
});
