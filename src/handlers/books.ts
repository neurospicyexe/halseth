// src/handlers/books.ts
//
// The Library (migration 0099) -- real books as objects. Files live in R2
// (books/<id>.epub, covers/<id>.<ext>), metadata in D1. Raziel reads the epub
// in Hearth (CFI progress); companions read the vault copy (books.vault_ref
// ties the two together for book_read / the club).
//
//   POST   /mind/books                          -- multipart upload (file, title?, author?, vault_ref?)
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
// Auth: authGuard on everything, matching the rest of /mind/*.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { extractEpubMetadata } from "../lib/epub.js";

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

// POST /mind/books  (multipart/form-data: file, title?, author?, description?, vault_ref?, replace?)
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
  const fileType = /\.pdf$/i.test(filename) ? "pdf" : "epub";

  try {
    const buf = await blob.arrayBuffer();

    // Server-side epub metadata + cover; form fields override extraction.
    const extracted = fileType === "epub"
      ? await extractEpubMetadata(buf)
      : { title: null, author: null, description: null, language: null, cover: null };
    const fieldStr = (k: string, max: number) => {
      const v = form.get(k);
      return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
    };
    const title = fieldStr("title", 300)
      ?? extracted.title?.slice(0, 300)
      ?? filename.replace(/\.(epub|pdf)$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 300);
    const author = fieldStr("author", 200) ?? extracted.author?.slice(0, 200) ?? null;

    // Same book twice is a re-upload mistake, not a second book -- but never
    // silently delete (Catalouge auto-deleted; that's data loss). 409 unless
    // the caller explicitly says replace.
    const existing = await env.DB.prepare(
      "SELECT id FROM books WHERE lower(title) = lower(?) AND lower(COALESCE(author, '')) = lower(COALESCE(?, ''))"
    ).bind(title, author).first<{ id: string }>();
    if (existing && form.get("replace") !== "true") {
      return json({ error: "book already in the library", existing_id: existing.id, hint: "pass replace=true to overwrite" }, 409);
    }

    const id = existing?.id ?? crypto.randomUUID().replace(/-/g, "");
    const fileKey = `books/${id}.${fileType}`;
    let coverKey: string | null = null;

    await env.BUCKET.put(fileKey, buf, {
      httpMetadata: { contentType: fileType === "pdf" ? "application/pdf" : "application/epub+zip" },
    });

    // Cover: an uploaded cover field wins; else whatever the epub carried.
    const coverField = form.get("cover");
    if (coverField && typeof coverField !== "string") {
      const coverBlob = coverField as { arrayBuffer(): Promise<ArrayBuffer>; type: string };
      const ext = COVER_EXT[coverBlob.type] ?? "jpg";
      coverKey = `covers/${id}.${ext}`;
      await env.BUCKET.put(coverKey, await coverBlob.arrayBuffer(), {
        httpMetadata: { contentType: coverBlob.type || "image/jpeg" },
      });
    } else if (extracted.cover) {
      const ext = COVER_EXT[extracted.cover.mediaType] ?? "jpg";
      coverKey = `covers/${id}.${ext}`;
      await env.BUCKET.put(coverKey, extracted.cover.data, {
        httpMetadata: { contentType: extracted.cover.mediaType },
      });
    }

    if (existing) {
      await env.DB.prepare(
        "UPDATE books SET title = ?, author = ?, description = COALESCE(?, description), language = COALESCE(?, language), file_key = ?, file_type = ?, file_size = ?, cover_key = COALESCE(?, cover_key), vault_ref = COALESCE(?, vault_ref), updated_at = datetime('now') WHERE id = ?"
      ).bind(
        title, author,
        fieldStr("description", 2000) ?? extracted.description?.slice(0, 2000) ?? null,
        extracted.language, fileKey, fileType, blob.size ?? buf.byteLength,
        coverKey, fieldStr("vault_ref", 200), id,
      ).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO books (id, title, author, description, language, file_key, file_type, file_size, cover_key, vault_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        id, title, author,
        fieldStr("description", 2000) ?? extracted.description?.slice(0, 2000) ?? null,
        extracted.language ?? "en", fileKey, fileType, blob.size ?? buf.byteLength,
        coverKey, fieldStr("vault_ref", 200),
      ).run();
    }
    return json({ book: { id, title, author, file_type: fileType, cover_key: coverKey, replaced: !!existing } }, 201);
  } catch (err) {
    console.error("[mind/books] upload error", { error: String(err) });
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
