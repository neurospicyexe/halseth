// Tests for the Library handlers (migration 0099): upload with dedupe (409, never
// silent delete), metadata extraction fallback to filename, progress partial upsert,
// annotation validation, delete cleaning R2. Fake-D1 keyed by SQL + Map-backed R2.

import { describe, it, expect } from "vitest";
import {
  postBook, getBooks, getBook, patchBook, deleteBook,
  putBookProgress, postBookAnnotation, deleteBookAnnotation,
} from "../handlers/books.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }
interface Store { books: Row[]; progress: Row[]; annotations: Row[] }

class FakeStatement {
  constructor(private sql: string, private store: Store, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.store, args); }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO books")) {
      const [id, title, author, description, language, file_key, file_type, file_size, cover_key, vault_ref] = this.bound;
      this.store.books.push({ id, title, author, description, language, file_key, file_type, file_size, cover_key, vault_ref, added_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE books SET title = ?, author = ?, description = COALESCE")) {
      const id = this.bound[this.bound.length - 1];
      const row = this.store.books.find(b => b["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      row["title"] = this.bound[0];
      row["author"] = this.bound[1];
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE books SET")) {
      const id = this.bound[this.bound.length - 1];
      const row = this.store.books.find(b => b["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      // dynamic SET list: pair fields with binds in order
      const fields = [...this.sql.matchAll(/(\w+) = \?/g)].map(m => m[1]!);
      fields.forEach((f, i) => { row[f] = this.bound[i]; });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM books")) {
      const before = this.store.books.length;
      this.store.books = this.store.books.filter(b => b["id"] !== this.bound[0]);
      return { meta: { changes: before - this.store.books.length } };
    }
    if (this.sql.startsWith("INSERT INTO book_progress")) {
      const [book_id, cfi, chapter, percentInsert, finished, percentUpdate] = this.bound;
      const existing = this.store.progress.find(p => p["book_id"] === book_id);
      if (existing) {
        existing["current_cfi"] = cfi ?? existing["current_cfi"];
        existing["current_chapter"] = chapter ?? existing["current_chapter"];
        existing["progress_percent"] = percentUpdate ?? existing["progress_percent"];
        existing["finished_at"] = finished ?? existing["finished_at"];
      } else {
        this.store.progress.push({ book_id, current_cfi: cfi, current_chapter: chapter, progress_percent: percentInsert ?? 0, finished_at: finished });
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO book_annotations")) {
      const [id, book_id, author, cfi_range, selected_text, comment, color] = this.bound;
      this.store.annotations.push({ id, book_id, author, cfi_range, selected_text, comment, color });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM book_annotations")) {
      const [id, book_id] = this.bound;
      const before = this.store.annotations.length;
      this.store.annotations = this.store.annotations.filter(a => !(a["id"] === id && a["book_id"] === book_id));
      return { meta: { changes: before - this.store.annotations.length } };
    }
    return { meta: { changes: 0 } };
  }

  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("FROM books b")) return { results: [...this.store.books] };
    if (this.sql.includes("FROM book_annotations")) {
      return { results: this.store.annotations.filter(a => a["book_id"] === this.bound[0]) };
    }
    return { results: [] };
  }

  async first(): Promise<Row | null> {
    if (this.sql.includes("FROM books WHERE lower(title)")) {
      const [title, author] = this.bound as [string, string | null];
      return this.store.books.find(b =>
        String(b["title"]).toLowerCase() === title.toLowerCase() &&
        String(b["author"] ?? "").toLowerCase() === String(author ?? "").toLowerCase()
      ) ?? null;
    }
    if (this.sql.includes("FROM books WHERE id = ?")) {
      return this.store.books.find(b => b["id"] === this.bound[0]) ?? null;
    }
    if (this.sql.includes("FROM book_progress WHERE book_id = ?")) {
      return this.store.progress.find(p => p["book_id"] === this.bound[0]) ?? null;
    }
    return null;
  }
}

const ADMIN_SECRET = "test-admin-secret";
const AUTH_HEADERS = { Authorization: `Bearer ${ADMIN_SECRET}` };

function makeEnv(store: Store, bucket: Map<string, unknown>): Env {
  return {
    DB: { prepare: (sql: string) => new FakeStatement(sql, store) },
    BUCKET: {
      put: async (key: string, value: unknown) => { bucket.set(key, value); },
      get: async (key: string) => bucket.get(key) ?? null,
      delete: async (key: string) => { bucket.delete(key); },
    },
    ADMIN_SECRET,
  } as unknown as Env;
}

function emptyStore(): Store { return { books: [], progress: [], annotations: [] }; }

function uploadReq(filename: string, fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], filename));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://x/mind/books", { method: "POST", headers: AUTH_HEADERS, body: form });
}

function jsonReq(method: string, body: unknown): Request {
  return new Request("https://x/mind/books", {
    method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
  });
}

function authReq(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { ...(init.headers ?? {}), ...AUTH_HEADERS } });
}

describe("postBook", () => {
  it("uploads a book, falling back to a cleaned filename for the title", async () => {
    const store = emptyStore();
    const bucket = new Map<string, unknown>();
    const res = await postBook(uploadReq("the_left_hand-of_darkness.epub"), makeEnv(store, bucket));
    expect(res.status).toBe(201);
    expect(store.books).toHaveLength(1);
    expect(store.books[0]!["title"]).toBe("the left hand of darkness");
    expect(store.books[0]!["file_type"]).toBe("epub");
    expect([...bucket.keys()].some(k => k.startsWith("books/") && k.endsWith(".epub"))).toBe(true);
  });

  it("form title overrides extraction/filename", async () => {
    const store = emptyStore();
    const res = await postBook(uploadReq("x.epub", { title: "The Left Hand of Darkness", author: "Ursula K. Le Guin" }), makeEnv(store, new Map()));
    expect(res.status).toBe(201);
    expect(store.books[0]!["title"]).toBe("The Left Hand of Darkness");
    expect(store.books[0]!["author"]).toBe("Ursula K. Le Guin");
  });

  it("409s on duplicate title+author instead of silently deleting (anti-Catalouge)", async () => {
    const store = emptyStore();
    const bucket = new Map<string, unknown>();
    await postBook(uploadReq("a.epub", { title: "Dune", author: "Frank Herbert" }), makeEnv(store, bucket));
    const res = await postBook(uploadReq("b.epub", { title: "dune", author: "FRANK HERBERT" }), makeEnv(store, bucket));
    expect(res.status).toBe(409);
    expect(store.books).toHaveLength(1);
  });

  it("replace=true overwrites in place, keeping the id", async () => {
    const store = emptyStore();
    const bucket = new Map<string, unknown>();
    await postBook(uploadReq("a.epub", { title: "Dune", author: "Frank Herbert" }), makeEnv(store, bucket));
    const originalId = store.books[0]!["id"];
    const res = await postBook(uploadReq("a2.epub", { title: "Dune", author: "Frank Herbert", replace: "true" }), makeEnv(store, bucket));
    expect(res.status).toBe(201);
    expect(store.books).toHaveLength(1);
    expect(store.books[0]!["id"]).toBe(originalId);
  });

  it("detects pdf by extension", async () => {
    const store = emptyStore();
    await postBook(uploadReq("paper.PDF"), makeEnv(store, new Map()));
    expect(store.books[0]!["file_type"]).toBe("pdf");
  });
});

describe("putBookProgress", () => {
  it("upserts and partial-updates without wiping untouched fields", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune" });
    const env = makeEnv(store, new Map());
    await putBookProgress(jsonReq("PUT", { current_cfi: "epubcfi(/6/4!/4/2)", progress_percent: 12 }), env, { id: "b1" });
    expect(store.progress[0]!["current_cfi"]).toBe("epubcfi(/6/4!/4/2)");
    // chapter-only save must keep the CFI
    await putBookProgress(jsonReq("PUT", { current_chapter: "Chapter 3" }), env, { id: "b1" });
    expect(store.progress[0]!["current_cfi"]).toBe("epubcfi(/6/4!/4/2)");
    expect(store.progress[0]!["current_chapter"]).toBe("Chapter 3");
    expect(store.progress).toHaveLength(1);
  });

  it("404s on unknown book", async () => {
    const res = await putBookProgress(jsonReq("PUT", { progress_percent: 5 }), makeEnv(emptyStore(), new Map()), { id: "ghost" });
    expect(res.status).toBe(404);
  });

  it("clamps percent into 0..100", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune" });
    await putBookProgress(jsonReq("PUT", { progress_percent: 250 }), makeEnv(store, new Map()), { id: "b1" });
    expect(store.progress[0]!["progress_percent"]).toBe(100);
  });
});

describe("annotations", () => {
  it("accepts companion marginalia anchored by quote (no CFI)", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune" });
    const res = await postBookAnnotation(
      jsonReq("POST", { author: "drevan", selected_text: "the sleeper must awaken", comment: "this is the vow shape" }),
      makeEnv(store, new Map()), { id: "b1" },
    );
    expect(res.status).toBe(201);
    expect(store.annotations[0]!["author"]).toBe("drevan");
    expect(store.annotations[0]!["cfi_range"]).toBeNull();
  });

  it("rejects an empty annotation and an unknown author", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune" });
    const env = makeEnv(store, new Map());
    expect((await postBookAnnotation(jsonReq("POST", { author: "drevan" }), env, { id: "b1" })).status).toBe(400);
    expect((await postBookAnnotation(jsonReq("POST", { author: "mallory", comment: "hi" }), env, { id: "b1" })).status).toBe(400);
  });

  it("deletes only within the right book", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune" });
    store.annotations.push({ id: "a1", book_id: "b1", author: "raziel" });
    const env = makeEnv(store, new Map());
    expect((await deleteBookAnnotation(authReq("https://x", { method: "DELETE" }), env, { id: "b2", ann_id: "a1" })).status).toBe(404);
    expect((await deleteBookAnnotation(authReq("https://x", { method: "DELETE" }), env, { id: "b1", ann_id: "a1" })).status).toBe(200);
    expect(store.annotations).toHaveLength(0);
  });
});

describe("deleteBook", () => {
  it("removes the row and both R2 objects", async () => {
    const store = emptyStore();
    const bucket = new Map<string, unknown>();
    store.books.push({ id: "b1", title: "Dune", file_key: "books/b1.epub", cover_key: "covers/b1.jpg" });
    bucket.set("books/b1.epub", "bytes");
    bucket.set("covers/b1.jpg", "bytes");
    const res = await deleteBook(authReq("https://x", { method: "DELETE" }), makeEnv(store, bucket), { id: "b1" });
    expect(res.status).toBe(200);
    expect(store.books).toHaveLength(0);
    expect(bucket.size).toBe(0);
  });
});

describe("getBooks / getBook / patchBook", () => {
  it("lists and fetches detail", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune", file_key: "books/b1.epub" });
    const env = makeEnv(store, new Map());
    const list = await (await getBooks(authReq("https://x/mind/books"), env)).json() as { books: Row[] };
    expect(list.books).toHaveLength(1);
    const detail = await (await getBook(authReq("https://x"), env, { id: "b1" })).json() as { book: Row };
    expect(detail.book["title"]).toBe("Dune");
  });

  it("patch updates allow-listed fields only", async () => {
    const store = emptyStore();
    store.books.push({ id: "b1", title: "Dune", file_key: "books/b1.epub" });
    const env = makeEnv(store, new Map());
    const res = await patchBook(jsonReq("PATCH", { vault_ref: "Dune", file_key: "evil" }), env, { id: "b1" });
    expect(res.status).toBe(200);
    expect(store.books[0]!["vault_ref"]).toBe("Dune");
    expect(store.books[0]!["file_key"]).toBe("books/b1.epub");
  });
});
