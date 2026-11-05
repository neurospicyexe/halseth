// src/handlers/makes.ts
//
// Making (B62, mig 0164; Hand-off/SPEC-B62-making-2026-11-02.md). What a companion makes, kept in R2
// under makes/<companion>/<id>/, one companion_makes row each. Every route is auth-gated (ADMIN_SECRET
// bearer; Hearth proxies server-side) and NONE is a public path.
//
//   POST  /mind/makes                          create (the companion's own act)
//   GET   /mind/makes/:companion_id            the shelf, newest first, generate_image rows merged in
//   GET   /mind/makes/item/:id                 one make, same shape
//   GET   /mind/makes/file/:id/:which          stream source|file|preview from R2 (download by default)
//   GET   /mind/makes/pending                  the VPS renderer's queue, oldest first
//   GET   /mind/makes/source/:id               raw source text, for the renderer
//   POST  /mind/makes/:id/rendered             the renderer posts the file back, or fails it
//   PATCH /mind/makes/:id                      heard_back, the companion's own line
//
// SERVING IS DOWNLOAD-FIRST. Source and rendered bytes are companion-authored and may be HTML, SVG or
// script, so every stream carries nosniff + `default-src 'none'; sandbox` + Content-Disposition:
// attachment. ?inline=1 is honoured ONLY for image/png, audio/mpeg, video/mp4 (the renderer's outputs);
// generate_image rows also allow the raster image types the provider can return.
//
// GAIA MAKES NOTHING (her word, 2026-11-02): an interest of hers never produces an artifact, only a
// kept line. POST answers 403 gaia_keeps_lines.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { applyInterestAction, findInterestByName, type InterestRow } from "./interests.js";
import { fireStimulus } from "./fermentation.js";
import { sqliteTs } from "../webmind/interests.js";
import { originKind } from "../webmind/makes-capture.js";
import {
  MAKE_KINDS, MAKE_COMPANIONS, SOURCE_KINDS, READY_AT_ONCE, MAX_SOURCE_BYTES, MAX_TITLE, MAX_MAKE_WHY,
  MAX_HEARD_BACK, MAX_FAIL_REASON, MAX_RENDER_FILE_BYTES, MAX_RENDER_PREVIEW_BYTES, DAILY_CAP_TOTAL,
  DAILY_CAP_BY_KIND, IMAGE_ID_PREFIX, MAKE_ID_RE, FILE_WHICH, SOURCE_MIME, FILE_OUT, PREVIEW_MIME,
  INLINE_MIMES, INLINE_IMAGE_MIMES, sourceKeyFor, fileKeyFor, previewKeyFor, extOfKey, slugify, byteLength,
  looksLikeSvg, scadDenyReason, normalizeMusicParams, normalizeVideoParams, type FileWhich,
} from "../webmind/makes.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const newId = (): string => crypto.randomUUID().replace(/-/g, "");
const COMPANION_SET = new Set<string>(MAKE_COMPANIONS);
const KIND_SET = new Set<string>(MAKE_KINDS);
const BAD_COMPANION = { error: "companion_id must be one of cypher, drevan, gaia" };

// ── Types ───────────────────────────────────────────────────────────────────────

interface MakeRow {
  id: string; companion_id: string; kind: string; title: string; why: string | null; why_private: number;
  interest_id: string | null; params: string | null; source_key: string | null; file_key: string | null;
  file_mime: string | null; preview_key: string | null; status: string; fail_reason: string | null;
  heard_back: string | null; parent_id: string | null; version: number; created_at: string; rendered_at: string | null;
  interest_name?: string | null;
  origin?: string | null;
}

export interface MakeFile { mime: string; ext?: string }
export interface MakeItem {
  id: string; kind: string; title: string; why: string | null; interest_name: string | null; status: string;
  heard_back: string | null; version: number; parent_id: string | null; created_at: string;
  files: { source?: MakeFile; file?: MakeFile; preview?: MakeFile };
  fail_reason: string | null;
  /** The recipe a model was handed (music_audio / video: prompt, duration...). Null for code kinds and images. */
  params: Record<string, unknown> | null;
  /** Where a captured writing came from (mig 0170): letter | exploration | kept; null = composed directly. */
  origin_kind: "letter" | "exploration" | "kept" | null;
}

export interface CreateMakeInput {
  companion_id: string; kind: string; title: string; why?: string | null; why_private?: boolean;
  interest_id?: string | null; interest_name?: string | null; source?: string | null;
  params?: unknown; parent_id?: string | null;
}
export type CreateMakeResult =
  | { ok: true; id: string; status: "pending" | "ready"; interest: string | null; interest_recorded: boolean }
  | { ok: false; http: number; code: string; message: string; extra?: Record<string, unknown> };

const fail = (http: number, code: string, message: string, extra?: Record<string, unknown>): CreateMakeResult =>
  ({ ok: false, http, code, message, extra });

// ── Shape ───────────────────────────────────────────────────────────────────────

function toItem(r: MakeRow, revealPrivate = false): MakeItem {
  const files: MakeItem["files"] = {};
  if (r.source_key) files.source = { mime: SOURCE_MIME[r.kind] ?? "text/plain", ext: extOfKey(r.source_key) ?? "txt" };
  if (r.file_key) files.file = { mime: r.file_mime ?? FILE_OUT[r.kind]?.mime ?? "application/octet-stream", ext: extOfKey(r.file_key) ?? "bin" };
  if (r.preview_key) files.preview = { mime: PREVIEW_MIME, ext: extOfKey(r.preview_key) ?? "png" };
  const item: MakeItem = {
    id: r.id, kind: r.kind, title: r.title,
    why: r.why_private && !revealPrivate ? null : r.why,
    interest_name: r.interest_name ?? null, status: r.status, heard_back: r.heard_back,
    version: r.version, parent_id: r.parent_id, created_at: r.created_at, files,
    fail_reason: r.status === "failed" ? r.fail_reason : null,
    params: parseParams(r.params),
    origin_kind: originKind(r.origin),
  };
  return item;
}

/** A stored params blob as an object; a malformed or non-object blob reads as no params. */
function parseParams(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface ImageCallRow { id: string; args_summary: string | null; result_summary: string | null; created_at: string }
function imageItem(r: ImageCallRow): MakeItem {
  const mime = (r.result_summary ?? "").startsWith("image/") ? (r.result_summary as string) : "image/png";
  return {
    id: IMAGE_ID_PREFIX + r.id, kind: "image", title: r.args_summary ?? "image", why: null, interest_name: null,
    status: "ready", heard_back: null, version: 1, parent_id: null, created_at: r.created_at, files: { file: { mime } }, fail_reason: null, params: null, origin_kind: null,
  };
}

const SELECT_MAKE = `SELECT m.*, i.name AS interest_name FROM companion_makes m
                       LEFT JOIN companion_interests i ON i.id = m.interest_id`;

// ── Create ──────────────────────────────────────────────────────────────────────

/** Start of the UTC day containing nowMs, in the SQLite timestamp shape created_at uses. */
const utcDayStart = (nowMs: number): string => sqliteTs(nowMs).slice(0, 10) + " 00:00:00";

export async function createMake(env: Env, input: CreateMakeInput, nowMs: number = Date.now()): Promise<CreateMakeResult> {
  const companion = String(input.companion_id ?? "");
  if (!COMPANION_SET.has(companion)) return fail(400, "bad_input", BAD_COMPANION.error);
  if (companion === "gaia") return fail(403, "gaia_keeps_lines", "gaia keeps lines; an interest of hers never produces an artifact");
  const kind = String(input.kind ?? "");
  if (!KIND_SET.has(kind)) return fail(400, "bad_input", `kind must be one of ${MAKE_KINDS.join(", ")}`);

  const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
  if (title.length < 1 || title.length > MAX_TITLE) return fail(400, "bad_input", `title must be 1..${MAX_TITLE} characters`);
  const why = typeof input.why === "string" ? input.why.trim() : "";
  if (why.length > MAX_MAKE_WHY) return fail(400, "bad_input", `why is capped at ${MAX_MAKE_WHY} characters`);
  const whyPrivate = input.why_private === true ? 1 : 0;

  // Source / params by kind.
  let source: string | null = null;
  let params: string | null = null;
  if (SOURCE_KINDS.has(kind)) {
    source = typeof input.source === "string" ? input.source : "";
    if (!source.trim()) return fail(400, "bad_input", `${kind} needs a source`);
    if (byteLength(source) > MAX_SOURCE_BYTES) return fail(413, "source_too_large", `source over ${MAX_SOURCE_BYTES / 1024} KB`);
    if (kind === "drawing" && !looksLikeSvg(source)) return fail(400, "bad_input", "drawing must be one SVG document (<svg ...> ... </svg>)");
    if (kind === "scad") {
      const denied = scadDenyReason(source);
      if (denied) return fail(400, "scad_denied", denied);
    }
  } else if (kind === "music_audio") {
    const p = normalizeMusicParams(input.params);
    if (!p.ok) return fail(400, "bad_input", p.error);
    params = JSON.stringify(p.params);
  } else {
    const p = normalizeVideoParams(input.params);
    if (!p.ok) return fail(400, "bad_input", p.error);
    params = JSON.stringify(p.params);
  }

  // Interest: an explicit id must be this companion's; a name resolves among their ACTIVE ones, and a
  // name that does not resolve is simply no interest.
  let interest: InterestRow | null = null;
  if (input.interest_id) {
    interest = (await env.DB.prepare("SELECT * FROM companion_interests WHERE id = ? AND companion_id = ?")
      .bind(String(input.interest_id), companion).first<InterestRow>()) ?? null;
    if (!interest) return fail(400, "bad_input", "interest_id is not one of this companion's interests");
  } else if (input.interest_name && String(input.interest_name).trim()) {
    const found = await findInterestByName(env, companion, String(input.interest_name).trim());
    interest = found && found.status === "active" ? found : null;
  }
  if (interest && !why) return fail(400, "why_required", "a make for an interest carries your reason, in your words");

  // Parent: same companion, version + 1.
  let version = 1;
  let parentId: string | null = null;
  if (input.parent_id) {
    const parent = await env.DB.prepare("SELECT id, version FROM companion_makes WHERE id = ? AND companion_id = ?")
      .bind(String(input.parent_id), companion).first<{ id: string; version: number }>();
    if (!parent) return fail(400, "bad_input", "parent_id is not one of this companion's makes");
    parentId = parent.id;
    version = (parent.version ?? 1) + 1;
  }

  // Daily caps (UTC day, counting every row so a failed render still spends the slot).
  const dayStart = utcDayStart(nowMs);
  const counts = (await env.DB.prepare(
    "SELECT kind, COUNT(*) AS n FROM companion_makes WHERE companion_id = ? AND created_at >= ? GROUP BY kind",
  ).bind(companion, dayStart).all<{ kind: string; n: number }>()).results ?? [];
  const total = counts.reduce((a, c) => a + c.n, 0);
  if (total >= DAILY_CAP_TOTAL) return fail(429, "daily_cap", `daily cap of ${DAILY_CAP_TOTAL} makes reached`, { cap: "total" });
  const kindCap = DAILY_CAP_BY_KIND[kind];
  if (kindCap !== undefined && (counts.find((c) => c.kind === kind)?.n ?? 0) >= kindCap) {
    return fail(429, "daily_cap", `daily cap of ${kindCap} ${kind} makes reached`, { cap: kind });
  }

  const id = newId();
  const sourceKey = source !== null ? sourceKeyFor(companion, id, kind) : null;
  if (source !== null && sourceKey) {
    await env.BUCKET.put(sourceKey, new TextEncoder().encode(source), { httpMetadata: { contentType: SOURCE_MIME[kind] } });
  }
  const status = READY_AT_ONCE.has(kind) ? "ready" : "pending";
  const ts = sqliteTs(nowMs);
  await env.DB.prepare(
    `INSERT INTO companion_makes (id, companion_id, kind, title, why, why_private, interest_id, params, source_key,
                                  status, parent_id, version, created_at, rendered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, companion, kind, title, why || null, whyPrivate, interest?.id ?? null, params, sourceKey,
    status, parentId, version, ts, status === "ready" ? ts : null).run();

  // The interest's own `made` event (the existing writer; nothing duplicated). Best effort: the make
  // is already kept, a refused event must not undo it.
  let recorded = false;
  if (interest) {
    try {
      const r = await applyInterestAction(env, {
        companion_id: companion, action: "made", name: interest.name, why, why_private: whyPrivate === 1, ref: `make:${id}`,
      }, nowMs);
      recorded = r.ok;
      if (!r.ok) console.warn("[makes] interest made event refused", { id, code: r.code });
    } catch (err) {
      console.error("[makes] interest made event failed", { id, error: String(err) });
    }
  }
  // creation_shared sheds novelty_need (the in-Worker function the stimulus route uses; no HTTP hop).
  try {
    await fireStimulus(env, "creation_shared", companion as "cypher" | "drevan", `make:${kind}`);
  } catch (err) {
    console.error("[makes] creation_shared stimulus failed", { id, error: String(err) });
  }
  console.log(`[makes] created id=${id} companion=${companion} kind=${kind} status=${status}`);
  return { ok: true, id, status, interest: interest?.name ?? null, interest_recorded: recorded };
}

export async function postMake(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "invalid JSON body" }, 400);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const caller = identifyCallerCompanion(request, env);
  const named = str(body.companion_id).trim();
  if (named && !COMPANION_SET.has(named)) return json(BAD_COMPANION, 400);
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  const companion_id = named || caller || "";
  if (!companion_id) return json({ error: "companion_id required" }, 400);
  try {
    const r = await createMake(env, {
      companion_id, kind: str(body.kind).trim(), title: str(body.title),
      why: str(body.why), why_private: body.why_private === true || body.why_private === 1,
      interest_id: str(body.interest_id).trim() || null, interest_name: str(body.interest_name).trim() || null,
      source: typeof body.source === "string" ? body.source : null, params: body.params,
      parent_id: str(body.parent_id).trim() || null,
    });
    if (!r.ok) return json({ ok: false, error: r.code, message: r.message, ...(r.extra ?? {}) }, r.http);
    return json({ id: r.id, status: r.status }, 201);
  } catch (err) {
    console.error("[makes] create error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export async function listMakes(
  env: Env, companionId: string, opts: { limit?: number; revealPrivate?: boolean } = {},
): Promise<MakeItem[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 40) || 40), 100);
  const [makes, images] = await Promise.all([
    env.DB.prepare(`${SELECT_MAKE} WHERE m.companion_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
      .bind(companionId, limit).all<MakeRow>(),
    env.DB.prepare(
      `SELECT id, args_summary, result_summary, created_at FROM companion_tool_calls
        WHERE companion_id = ? AND tool = 'generate_image' AND status = 'success' AND result_ref IS NOT NULL
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(companionId, limit).all<ImageCallRow>(),
  ]);
  const items = [
    ...(makes.results ?? []).map((r) => ({ item: toItem(r, opts.revealPrivate), seq: 1 })),
    ...(images.results ?? []).map((r) => ({ item: imageItem(r), seq: 0 })),
  ];
  // Newest first; a tie keeps a made row ahead of an image row (stable and arbitrary).
  items.sort((a, b) => (a.item.created_at < b.item.created_at ? 1 : a.item.created_at > b.item.created_at ? -1 : b.seq - a.seq));
  return items.slice(0, limit).map((x) => x.item);
}

export async function getMakeItem(env: Env, id: string): Promise<MakeItem | null> {
  if (id.startsWith(IMAGE_ID_PREFIX)) {
    const r = await env.DB.prepare(
      `SELECT id, args_summary, result_summary, created_at FROM companion_tool_calls
        WHERE id = ? AND tool = 'generate_image' AND status = 'success' AND result_ref IS NOT NULL`,
    ).bind(id.slice(IMAGE_ID_PREFIX.length)).first<ImageCallRow>();
    return r ? imageItem(r) : null;
  }
  const r = await env.DB.prepare(`${SELECT_MAKE} WHERE m.id = ?`).bind(id).first<MakeRow>();
  return r ? toItem(r) : null;
}

export async function getMakes(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const cid = params["companion_id"] ?? "";
  if (!COMPANION_SET.has(cid)) return json(BAD_COMPANION, 400);
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 40);
  try {
    return json({ makes: await listMakes(env, cid, { limit: Number.isFinite(limit) ? limit : 40 }) });
  } catch (err) {
    console.error("[makes] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getMakeItemHttp(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!MAKE_ID_RE.test(id)) return json({ error: "not found" }, 404);
  try {
    const item = await getMakeItem(env, id);
    return item ? json(item) : json({ error: "not found" }, 404);
  } catch (err) {
    console.error("[makes] item error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── File streaming ──────────────────────────────────────────────────────────────

type R2RangeSpec = { offset: number; length?: number } | { suffix: number };
/** One `bytes=a-b` / `bytes=a-` / `bytes=-n` range. Anything else (multi-range, junk) is ignored: a full 200. */
export function parseRange(h: string | null): R2RangeSpec | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((h ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") { const n = Number(m[2]); return n > 0 ? { suffix: n } : null; }
  const a = Number(m[1]);
  if (m[2] === "") return { offset: a };
  const b = Number(m[2]);
  return b >= a ? { offset: a, length: b - a + 1 } : null;
}

const SAFE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
};

export async function serveMakeFile(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  const which = params["which"] ?? "";
  if (!MAKE_ID_RE.test(id) || !(FILE_WHICH as readonly string[]).includes(which)) return json({ error: "not found" }, 404);
  const w = which as FileWhich;
  try {
    let key: string | null = null;
    let mime = "application/octet-stream";
    let title = "make";
    let version = 1;
    let inlineAllowed = INLINE_MIMES;
    if (id.startsWith(IMAGE_ID_PREFIX)) {
      if (w !== "file") return json({ error: "not found" }, 404);
      const r = await env.DB.prepare(
        `SELECT result_ref, result_summary, args_summary FROM companion_tool_calls
          WHERE id = ? AND tool = 'generate_image' AND status = 'success'`,
      ).bind(id.slice(IMAGE_ID_PREFIX.length)).first<{ result_ref: string | null; result_summary: string | null; args_summary: string | null }>();
      if (!r?.result_ref) return json({ error: "not found" }, 404);
      key = r.result_ref;
      mime = (r.result_summary ?? "").startsWith("image/") ? (r.result_summary as string) : "image/png";
      title = r.args_summary ?? "image";
      inlineAllowed = INLINE_IMAGE_MIMES;
    } else {
      const r = await env.DB.prepare(
        "SELECT kind, title, version, source_key, file_key, file_mime, preview_key FROM companion_makes WHERE id = ?",
      ).bind(id).first<Pick<MakeRow, "kind" | "title" | "version" | "source_key" | "file_key" | "file_mime" | "preview_key">>();
      if (!r) return json({ error: "not found" }, 404);
      title = r.title; version = r.version ?? 1;
      if (w === "source") { key = r.source_key; mime = SOURCE_MIME[r.kind] ?? "text/plain"; }
      else if (w === "file") { key = r.file_key; mime = r.file_mime ?? FILE_OUT[r.kind]?.mime ?? mime; }
      else { key = r.preview_key; mime = PREVIEW_MIME; }
    }
    if (!key) return json({ error: "not found" }, 404);
    const range = parseRange(request.headers.get("Range"));
    const object = await env.BUCKET.get(key, range ? { range } : undefined);
    if (!object) return json({ error: "not found" }, 404);

    const baseMime = (mime.split(";")[0] ?? "").trim().toLowerCase();
    const inline = new URL(request.url).searchParams.get("inline") === "1" && inlineAllowed.has(baseMime);
    const ext = extOfKey(key) ?? "bin";
    const filename = `${slugify(title)}-v${version}.${ext}`;
    const headers = new Headers({
      ...SAFE_HEADERS,
      "Content-Type": mime,
      "Content-Disposition": inline ? "inline" : `attachment; filename="${filename}"`,
      "Cache-Control": "private, max-age=300",
      "Accept-Ranges": "bytes",
    });
    // A ranged read answers 206 with the slice R2 actually served (Safari will not play mp3/mp4 without it).
    const served = (object as { range?: { offset?: number; length?: number } }).range;
    const total = (object as { size?: number }).size;
    if (range && served && typeof total === "number" && total > 0) {
      const start = served.offset ?? 0;
      const len = served.length ?? total - start;
      headers.set("Content-Range", `bytes ${start}-${start + len - 1}/${total}`);
      headers.set("Content-Length", String(len));
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { headers });
  } catch (err) {
    console.error("[makes] file error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Renderer surface ────────────────────────────────────────────────────────────

export async function getPendingMakes(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const n = Number(new URL(request.url).searchParams.get("limit") ?? 5);
  const limit = Math.min(Math.max(1, Math.floor(Number.isFinite(n) ? n : 5) || 5), 20);
  try {
    const rows = (await env.DB.prepare(
      `SELECT id, companion_id, kind, title, params, source_key, version, created_at FROM companion_makes
        WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).bind(limit).all<Pick<MakeRow, "id" | "companion_id" | "kind" | "title" | "params" | "source_key" | "version" | "created_at">>()).results ?? [];
    return json({
      makes: rows.map((r) => {
        let params: unknown = null;
        try { params = r.params ? JSON.parse(r.params) : null; } catch { /* a malformed row reads as no params */ }
        return { id: r.id, companion_id: r.companion_id, kind: r.kind, title: r.title, params, source_key: r.source_key, version: r.version, created_at: r.created_at };
      }),
    });
  } catch (err) {
    console.error("[makes] pending error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getMakeSource(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "not found" }, 404);
  try {
    const r = await env.DB.prepare("SELECT source_key FROM companion_makes WHERE id = ?").bind(id).first<{ source_key: string | null }>();
    if (!r?.source_key) return json({ error: "not found" }, 404);
    const object = await env.BUCKET.get(r.source_key);
    if (!object) return json({ error: "not found" }, 404);
    return new Response(await object.text(), {
      headers: { ...SAFE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": "attachment" },
    });
  } catch (err) {
    console.error("[makes] source error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b: ArrayBuffer): boolean => {
  const u = new Uint8Array(b);
  return u.byteLength > 8 && PNG_MAGIC.every((x, i) => u[i] === x);
};

/** POST /mind/makes/:id/rendered: multipart (file, optional preview) or JSON { failed: true, reason }. Idempotent. */
export async function postMakeRendered(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "not found" }, 404);
  try {
    const row = await env.DB.prepare("SELECT id, companion_id, kind, status FROM companion_makes WHERE id = ?")
      .bind(id).first<Pick<MakeRow, "id" | "companion_id" | "kind" | "status">>();
    if (!row) return json({ error: "not found" }, 404);
    // Idempotent: a renderer retry (or a second renderer) finds it done and changes nothing.
    if (row.status !== "pending") return json({ ok: true, id, status: row.status, noop: true });

    const ct = request.headers.get("Content-Type") ?? "";
    const ts = sqliteTs(Date.now());
    if (ct.includes("application/json")) {
      let body: { failed?: unknown; reason?: unknown };
      try { body = (await request.json()) as typeof body; } catch { return json({ error: "invalid JSON body" }, 400); }
      if (body?.failed !== true) return json({ error: "JSON body must be { failed: true, reason }; a render is posted as multipart" }, 400);
      const reason = (typeof body.reason === "string" ? body.reason : "").replace(/\s+/g, " ").trim().slice(0, MAX_FAIL_REASON) || "render failed";
      const res = await env.DB.prepare(
        "UPDATE companion_makes SET status = 'failed', fail_reason = ?, rendered_at = ? WHERE id = ? AND status = 'pending'",
      ).bind(reason, ts, id).run();
      const changed = Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
      console.log(`[makes] failed id=${id} kind=${row.kind}`);
      return json({ ok: true, id, status: changed ? "failed" : "unchanged", noop: !changed });
    }
    if (!ct.includes("multipart/form-data")) return json({ error: "multipart/form-data (file, preview?) or JSON { failed, reason } required" }, 400);

    let form: FormData;
    try { form = await request.formData(); } catch { return json({ error: "invalid multipart body" }, 400); }
    const file = form.get("file");
    const preview = form.get("preview");
    const isBlob = (v: unknown): v is Blob => !!v && typeof v === "object" && typeof (v as Blob).arrayBuffer === "function";
    if (!isBlob(file) || file.size === 0) return json({ error: "file field required" }, 400);
    if (file.size > MAX_RENDER_FILE_BYTES) return json({ error: "file too large" }, 413);
    const out = FILE_OUT[row.kind];
    if (!out) return json({ error: `${row.kind} is not rendered` }, 409);
    const fileBytes = await file.arrayBuffer();
    if (out.mime === "image/png" && !isPng(fileBytes)) return json({ error: "file is not a PNG" }, 400);
    let previewBytes: ArrayBuffer | null = null;
    if (isBlob(preview) && preview.size > 0) {
      if (preview.size > MAX_RENDER_PREVIEW_BYTES) return json({ error: "preview too large" }, 413);
      previewBytes = await preview.arrayBuffer();
      if (!isPng(previewBytes)) return json({ error: "preview is not a PNG" }, 400);
    }

    const fileKey = fileKeyFor(row.companion_id, id, row.kind);
    await env.BUCKET.put(fileKey, fileBytes, { httpMetadata: { contentType: out.mime } });
    let previewKey: string | null = null;
    if (previewBytes) {
      previewKey = previewKeyFor(row.companion_id, id);
      await env.BUCKET.put(previewKey, previewBytes, { httpMetadata: { contentType: PREVIEW_MIME } });
    }
    const res = await env.DB.prepare(
      `UPDATE companion_makes SET file_key = ?, file_mime = ?, preview_key = ?, status = 'ready', rendered_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(fileKey, out.mime, previewKey, ts, id).run();
    const changed = Number((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
    console.log(`[makes] rendered id=${id} kind=${row.kind} bytes=${fileBytes.byteLength} preview=${previewKey ? "yes" : "no"}`);
    return json({ ok: true, id, status: changed ? "ready" : "unchanged", noop: !changed });
  } catch (err) {
    console.error("[makes] rendered error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── heard_back ──────────────────────────────────────────────────────────────────

export async function patchMake(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "not found" }, 404);
  let body: { heard_back?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return json({ error: "invalid JSON body" }, 400); }
  const line = typeof body?.heard_back === "string" ? body.heard_back.replace(/\s+/g, " ").trim() : "";
  if (!line) return json({ error: "heard_back required (your own one line)" }, 400);
  if (line.length > MAX_HEARD_BACK) return json({ error: `heard_back is capped at ${MAX_HEARD_BACK} characters` }, 400);
  try {
    const row = await env.DB.prepare("SELECT companion_id FROM companion_makes WHERE id = ?").bind(id).first<{ companion_id: string }>();
    if (!row) return json({ error: "not found" }, 404);
    // The line is the maker's own: a companion token may write only to its own makes.
    const caller = identifyCallerCompanion(request, env);
    if (caller && caller !== row.companion_id) return json({ error: "forbidden: token does not match companion" }, 403);
    await env.DB.prepare("UPDATE companion_makes SET heard_back = ? WHERE id = ?").bind(line, id).run();
    return json({ ok: true, id, heard_back: line });
  } catch (err) {
    console.error("[makes] patch error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
