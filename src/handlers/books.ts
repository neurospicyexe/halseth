// src/handlers/books.ts
//
// The Library (migration 0099) -- real books as objects. Files live in R2
// (books/<id>.epub, covers/<id>.<ext>), metadata in D1. Raziel reads the epub
// in Hearth (CFI progress); companions read the vault copy (books.vault_ref
// ties the two together for book_read / the club).
//
//   POST   /mind/books                          -- multipart upload (file, title?, author?, vault_ref?)
//   POST   /mind/books/upload-ticket            -- mint a 10-minute upload ticket (Hearth, server side)
//   PUT    /mind/books/upload?ticket=&filename= -- raw-body upload from the browser; the ticket IS the auth
//   GET    /mind/books?search=&limit=           -- list with progress + annotation counts
//   GET    /mind/books/:id                      -- book + progress + annotations
//   GET    /mind/books/:id/file                 -- stream the epub/pdf from R2
//   GET    /mind/books/:id/cover                -- stream the cover from R2
//   PATCH  /mind/books/:id                      -- update metadata (allow-listed fields)
//   DELETE /mind/books/:id                      -- delete row + R2 objects
//   GET    /mind/books/:id/progress             -- reading position
//   PUT    /mind/books/:id/progress             -- partial upsert (COALESCE keeps untouched fields)
//   POST   /mind/books/:id/annotations          -- marginalia (raziel: cfi_range; companions: quote-anchored)
//   DELETE /mind/books/:id/annotations/:ann_id  -- remove a note
//
// Auth: authGuard on everything, matching the rest of /mind/*, EXCEPT PUT /mind/books/upload,
// which is in PUBLIC_PATHS and authenticates by upload ticket (src/lib/upload-ticket.ts).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { extractEpubMetadata } from "../lib/epub.js";
import { mintUploadTicket, verifyUploadTicket, burnUploadTicket } from "../lib/upload-ticket.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_AUTHORS = new Set<string>(["raziel", "cypher", "drevan", "gaia"]);
const COVER_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg",
};

type FileType = "pdf" | "epub";

function contentTypeFor(fileType: FileType): string {
  return fileType === "pdf" ? "application/pdf" : "application/epub+zip";
}

// Everything an upload needs once the transport (multipart or raw PUT) is unwrapped.
interface BookIngest {
  filename: string;
  fileType: FileType;
  size: number;
  field: (k: "title" | "author" | "description" | "vault_ref", max: number) => string | null;
  replace: boolean;
  epub: ArrayBuffer | null;                               // whole file, epubs only (extraction)
  cover: { data: ArrayBuffer; type: string } | null;      // an explicit cover beats the epub's
  writeFile: (key: string, contentType: string) => Promise<void>;
}

// The one upload path. Both transports call this, so title/author precedence, the 409
// duplicate check, covers and the D1 row can never drift apart. The duplicate check runs
// BEFORE writeFile, so a refused re-upload never touches R2 (a PUT's body stream is still
// unread at that point).
async function ingestBook(env: Env, b: BookIngest): Promise<Response> {
  // Server-side epub metadata + cover; explicit fields override extraction.
  const extracted = b.epub
    ? await extractEpubMetadata(b.epub)
    : { title: null, author: null, description: null, language: null, cover: null };
  const title = b.field("title", 300)
    ?? extracted.title?.slice(0, 300)
    ?? b.filename.replace(/\.(epub|pdf)$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 300);
  const author = b.field("author", 200) ?? extracted.author?.slice(0, 200) ?? null;

  // Same book twice is a re-upload mistake, not a second book -- but never
  // silently delete (Catalouge auto-deleted; that's data loss). 409 unless
  // the caller explicitly says replace.
  const existing = await env.DB.prepare(
    "SELECT id FROM books WHERE lower(title) = lower(?) AND lower(COALESCE(author, '')) = lower(COALESCE(?, ''))"
  ).bind(title, author).first<{ id: string }>();
  if (existing && !b.replace) {
    return json({ error: "book already in the library", existing_id: existing.id, hint: "pass replace=true to overwrite" }, 409);
  }

  const id = existing?.id ?? crypto.randomUUID().replace(/-/g, "");
  const fileKey = `books/${id}.${b.fileType}`;
  let coverKey: string | null = null;

  await b.writeFile(fileKey, contentTypeFor(b.fileType));

  // Cover: an uploaded cover field wins; else whatever the epub carried.
  if (b.cover) {
    const ext = COVER_EXT[b.cover.type] ?? "jpg";
    coverKey = `covers/${id}.${ext}`;
    await env.BUCKET.put(coverKey, b.cover.data, {
      httpMetadata: { contentType: b.cover.type || "image/jpeg" },
    });
  } else if (extracted.cover) {
    const ext = COVER_EXT[extracted.cover.mediaType] ?? "jpg";
    coverKey = `covers/${id}.${ext}`;
    await env.BUCKET.put(coverKey, extracted.cover.data, {
      httpMetadata: { contentType: extracted.cover.mediaType },
    });
  }

  const description = b.field("description", 2000) ?? extracted.description?.slice(0, 2000) ?? null;
  if (existing) {
    await env.DB.prepare(
      "UPDATE books SET title = ?, author = ?, description = COALESCE(?, description), language = COALESCE(?, language), file_key = ?, file_type = ?, file_size = ?, cover_key = COALESCE(?, cover_key), vault_ref = COALESCE(?, vault_ref), updated_at = datetime('now') WHERE id = ?"
    ).bind(
      title, author, description, extracted.language, fileKey, b.fileType, b.size,
      coverKey, b.field("vault_ref", 200), id,
    ).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO books (id, title, author, description, language, file_key, file_type, file_size, cover_key, vault_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, title, author, description, extracted.language ?? "en", fileKey, b.fileType, b.size,
      coverKey, b.field("vault_ref", 200),
    ).run();
  }
  return json({ book: { id, title, author, file_type: b.fileType, cover_key: coverKey, replaced: !!existing } }, 201);
}

// POST /mind/books  (multipart/form-data: file, title?, author?, description?, vault_ref?, replace?, cover?)
// Ops and scripts use this directly. Hearth's browser uploads use the ticket path below.
export async function postBook(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "expected multipart/form-data with a file field" }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "file field is required" }, 400);
  const blob = file as { arrayBuffer(): Promise<ArrayBuffer>; name?: string; size?: number };
  const filename = blob.name ?? "book";
  const fileType: FileType = /\.pdf$/i.test(filename) ? "pdf" : "epub";

  try {
    const buf = await blob.arrayBuffer();
    const coverField = form.get("cover");
    const cover = coverField && typeof coverField !== "string"
      ? { data: await (coverField as Blob).arrayBuffer(), type: (coverField as Blob).type }
      : null;
    return await ingestBook(env, {
      filename,
      fileType,
      size: blob.size ?? buf.byteLength,
      field: (k, max) => {
        const v = form.get(k);
        return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
      },
      replace: form.get("replace") === "true",
      epub: fileType === "epub" ? buf : null,
      cover,
      writeFile: async (key, contentType) => {
        await env.BUCKET.put(key, buf, { httpMetadata: { contentType } });
      },
    });
  } catch (err) {
    console.error("[mind/books] upload error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/books/upload-ticket  (admin-gated; Hearth calls it server side)
export async function postUploadTicket(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const minted = await mintUploadTicket(env);
  if (!minted) return json({ error: "uploads are not configured (UPLOAD_TICKET_SECRET unset)" }, 503);
  return json({
    ticket: minted.ticket,
    upload_url: `${new URL(request.url).origin}/mind/books/upload`,
    expires_at: new Date(minted.payload.exp * 1000).toISOString(),
    max_bytes: minted.payload.max_bytes,
  });
}

// CORS for the one browser-facing upload route. Locked to HEARTH_ORIGIN, never a wildcard.
// Every response carries it, errors included: without it the browser can't read a 409 and
// Hearth's "replace?" flow degrades to "network error".
export function uploadCorsHeaders(env: Env): Record<string, string> {
  return env.HEARTH_ORIGIN
    ? {
        "Access-Control-Allow-Origin": env.HEARTH_ORIGIN,
        "Access-Control-Allow-Methods": "PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      }
    : { "Vary": "Origin" };
}

// OPTIONS /mind/books/upload -- dispatched from the global preflight block in index.ts,
// which would otherwise answer with a wildcard origin.
export function optionsBookUpload(request: Request, env: Env): Response {
  const origin = request.headers.get("Origin");
  if (!env.HEARTH_ORIGIN || origin !== env.HEARTH_ORIGIN) {
    return new Response(null, { status: 403, headers: { "Vary": "Origin" } });
  }
  return new Response(null, { status: 204, headers: uploadCorsHeaders(env) });
}

// PUT /mind/books/upload?ticket=&filename=&title=&author=&description=&vault_ref=&replace=
// Body: the raw file. Metadata rides the query string so the preflight only has to allow
// Content-Type.
export async function putBookUpload(request: Request, env: Env): Promise<Response> {
  const res = await handleBookUpload(request, env);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(uploadCorsHeaders(env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function handleBookUpload(request: Request, env: Env): Promise<Response> {
  // Browsers always send Origin on a cross-origin PUT; only Hearth's is accepted. No Origin
  // at all is a non-browser caller (curl, ops), for whom the ticket alone decides.
  const origin = request.headers.get("Origin");
  if (origin !== null && (!env.HEARTH_ORIGIN || origin !== env.HEARTH_ORIGIN)) {
    return json({ error: "origin not allowed" }, 403);
  }

  const url = new URL(request.url);
  const check = await verifyUploadTicket(env, url.searchParams.get("ticket"));
  if (!check.ok) return json({ error: "upload ticket refused", reason: check.reason }, 401);

  const lengthHeader = request.headers.get("Content-Length");
  const length = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  if (!Number.isFinite(length)) return json({ error: "Content-Length is required" }, 411);
  if (length > check.payload.max_bytes) {
    return json({ error: "file too large", max_bytes: check.payload.max_bytes }, 413);
  }
  if (length === 0 || !request.body) return json({ error: "empty body" }, 400);

  // Spend the ticket only once the request is otherwise acceptable.
  await burnUploadTicket(env, check.payload);

  const q = (k: string, max: number) => {
    const v = url.searchParams.get(k);
    return v && v.trim() ? v.trim().slice(0, max) : null;
  };
  const filename = q("filename", 300) ?? "book";
  const fileType: FileType =
    /\.pdf$/i.test(filename) || request.headers.get("Content-Type") === "application/pdf" ? "pdf" : "epub";
  const body = request.body;

  try {
    // Epub metadata extraction needs the whole file, so an epub is buffered (once) and the
    // duplicate check runs on its real title/author. A PDF has nothing to extract: its title
    // and author come from the query or the filename, so the check runs first and the body
    // streams straight into R2 unbuffered (R2 takes the length from Content-Length).
    const epub = fileType === "epub" ? await new Response(body).arrayBuffer() : null;
    if (epub && epub.byteLength > check.payload.max_bytes) {
      return json({ error: "file too large", max_bytes: check.payload.max_bytes }, 413);
    }
    return await ingestBook(env, {
      filename,
      fileType,
      size: epub?.byteLength ?? length,
      field: (k, max) => q(k, max),
      replace: url.searchParams.get("replace") === "true",
      epub,
      cover: null,
      writeFile: async (key, contentType) => {
        await env.BUCKET.put(key, epub ?? body, { httpMetadata: { contentType } });
      },
    });
  } catch (err) {
    console.error("[mind/books] ticket upload error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/books?search=&limit=
export async function getBooks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const search = url.searchParams.get("search")?.trim();
  try {
    const base = `SELECT b.id, b.title, b.author, b.description, b.language, b.file_type, b.file_size,
                         b.cover_key, b.vault_ref, b.added_at,
                         p.progress_percent, p.current_chapter, p.finished_at, p.last_read_at,
                         (SELECT COUNT(*) FROM book_annotations a WHERE a.book_id = b.id) AS annotation_count
                  FROM books b LEFT JOIN book_progress p ON p.book_id = b.id`;
    const rows = search
      ? await env.DB.prepare(`${base} WHERE b.title LIKE ? OR b.author LIKE ? ORDER BY b.added_at DESC LIMIT ?`)
          .bind(`%${search}%`, `%${search}%`, limit).all()
      : await env.DB.prepare(`${base} ORDER BY b.added_at DESC LIMIT ?`).bind(limit).all();
    return json({ books: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/books] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/books/:id
export async function getBook(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
    if (!book) return json({ error: "book not found" }, 404);
    const [progress, annotations] = await Promise.all([
      env.DB.prepare("SELECT * FROM book_progress WHERE book_id = ?").bind(id).first(),
      env.DB.prepare("SELECT * FROM book_annotations WHERE book_id = ? ORDER BY created_at ASC").bind(id).all(),
    ]);
    return json({ book, progress: progress ?? null, annotations: annotations.results ?? [] });
  } catch (err) {
    console.error("[mind/books] get error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

async function streamBookObject(env: Env, id: string, kind: "file" | "cover"): Promise<Response> {
  const book = await env.DB.prepare(
    "SELECT file_key, file_type, cover_key, title FROM books WHERE id = ?"
  ).bind(id).first<{ file_key: string; file_type: string; cover_key: string | null; title: string }>();
  if (!book) return json({ error: "book not found" }, 404);
  const key = kind === "file" ? book.file_key : book.cover_key;
  if (!key) return json({ error: `no ${kind} for this book` }, 404);
  const object = await env.BUCKET.get(key);
  if (!object) return json({ error: `${kind} object missing from storage` }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  // Covers are effectively immutable per book id; the file changes only on replace.
  headers.set("cache-control", kind === "cover" ? "public, max-age=86400" : "public, max-age=3600");
  return new Response(object.body, { headers });
}

// GET /mind/books/:id/file
export async function getBookFile(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    return await streamBookObject(env, params["id"] ?? "", "file");
  } catch (err) {
    console.error("[mind/books] file error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/books/:id/cover
export async function getBookCover(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    return await streamBookObject(env, params["id"] ?? "", "cover");
  } catch (err) {
    console.error("[mind/books] cover error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/books/:id
export async function patchBook(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const allowed: Record<string, number> = { title: 300, author: 200, description: 2000, language: 20, vault_ref: 200 };
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [field, max] of Object.entries(allowed)) {
    const v = body[field];
    if (typeof v === "string") {
      sets.push(`${field} = ?`);
      binds.push(v.trim().slice(0, max) || null);
    }
  }
  if (sets.length === 0) return json({ error: "nothing to update" }, 400);
  try {
    const res = await env.DB.prepare(
      `UPDATE books SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...binds, id).run();
    if (res.meta.changes === 0) return json({ error: "book not found" }, 404);
    return json({ id, updated: true });
  } catch (err) {
    console.error("[mind/books] patch error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// DELETE /mind/books/:id
export async function deleteBook(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const book = await env.DB.prepare(
      "SELECT file_key, cover_key FROM books WHERE id = ?"
    ).bind(id).first<{ file_key: string; cover_key: string | null }>();
    if (!book) return json({ error: "book not found" }, 404);
    // Row first (CASCADE clears progress + annotations), then blobs.
    await env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id).run();
    await env.BUCKET.delete(book.file_key).catch(() => {});
    if (book.cover_key) await env.BUCKET.delete(book.cover_key).catch(() => {});
    return json({ id, deleted: true });
  } catch (err) {
    console.error("[mind/books] delete error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/books/:id/progress
export async function getBookProgress(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const progress = await env.DB.prepare("SELECT * FROM book_progress WHERE book_id = ?").bind(id).first();
    return json({ progress: progress ?? null });
  } catch (err) {
    console.error("[mind/books] progress read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PUT /mind/books/:id/progress  { current_cfi?, current_chapter?, progress_percent?, finished? }
// Partial upsert: COALESCE keeps whatever the caller didn't send, so a CFI save
// doesn't wipe the chapter and vice versa.
export async function putBookProgress(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { current_cfi?: string; current_chapter?: string; progress_percent?: number; finished?: boolean };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const percent = typeof body.progress_percent === "number" && Number.isFinite(body.progress_percent)
    ? Math.min(Math.max(body.progress_percent, 0), 100)
    : null;
  try {
    const book = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(id).first();
    if (!book) return json({ error: "book not found" }, 404);
    await env.DB.prepare(
      `INSERT INTO book_progress (book_id, current_cfi, current_chapter, progress_percent, started_at, finished_at, last_read_at)
       VALUES (?, ?, ?, COALESCE(?, 0), datetime('now'), ?, datetime('now'))
       ON CONFLICT(book_id) DO UPDATE SET
         current_cfi      = COALESCE(excluded.current_cfi, book_progress.current_cfi),
         current_chapter  = COALESCE(excluded.current_chapter, book_progress.current_chapter),
         progress_percent = COALESCE(?, book_progress.progress_percent),
         finished_at      = COALESCE(excluded.finished_at, book_progress.finished_at),
         last_read_at     = datetime('now')`
    ).bind(
      id,
      body.current_cfi?.trim() || null,
      body.current_chapter?.trim()?.slice(0, 300) || null,
      percent,
      body.finished === true ? new Date().toISOString().replace("T", " ").slice(0, 19) : null,
      percent,
    ).run();
    return json({ book_id: id, saved: true });
  } catch (err) {
    console.error("[mind/books] progress write error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/books/:id/annotations
export async function getBookAnnotations(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM book_annotations WHERE book_id = ? ORDER BY created_at ASC"
    ).bind(id).all();
    return json({ annotations: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/books] annotations read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/books/:id/annotations  { author, cfi_range?, selected_text?, comment?, color? }
export async function postBookAnnotation(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { author?: string; cfi_range?: string; selected_text?: string; comment?: string; color?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const author = body.author ?? "";
  if (!VALID_AUTHORS.has(author)) {
    return json({ error: "author must be one of raziel, cypher, drevan, gaia" }, 400);
  }
  const cfiRange = body.cfi_range?.trim() || null;
  const selectedText = body.selected_text?.trim()?.slice(0, 2000) || null;
  const comment = body.comment?.trim()?.slice(0, 3000) || null;
  // A note needs an anchor or something said; an empty row is noise.
  if (!cfiRange && !selectedText && !comment) {
    return json({ error: "at least one of cfi_range, selected_text, comment is required" }, 400);
  }
  try {
    const book = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(id).first();
    if (!book) return json({ error: "book not found" }, 404);
    const annId = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(
      "INSERT INTO book_annotations (id, book_id, author, cfi_range, selected_text, comment, color) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(annId, id, author, cfiRange, selectedText, comment, body.color?.trim()?.slice(0, 20) || null).run();
    return json({ annotation: { id: annId, book_id: id, author } }, 201);
  } catch (err) {
    console.error("[mind/books] annotation write error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// DELETE /mind/books/:id/annotations/:ann_id
export async function deleteBookAnnotation(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  const annId = params["ann_id"] ?? "";
  if (!id || !annId) return json({ error: "id and ann_id are required" }, 400);
  try {
    const res = await env.DB.prepare(
      "DELETE FROM book_annotations WHERE id = ? AND book_id = ?"
    ).bind(annId, id).run();
    if (res.meta.changes === 0) return json({ error: "annotation not found" }, 404);
    return json({ id: annId, deleted: true });
  } catch (err) {
    console.error("[mind/books] annotation delete error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
