// src/handlers/interiority.ts
//
// The private back room (migration 0084). See that migration's header for the doctrine.
//
// Access model (the whole point lives here):
//   - WRITE: the owning companion (via their per-companion token) or admin-on-behalf.
//   - READ CONTENT: the owning companion's token ONLY. Admin (Raziel) is refused at the content
//     layer by design -- that refusal is the feature, not a bug.
//   - READ META: admin OR owner. Counts + timestamps + self-applied mood labels; never content.
//   - DISCLOSE: the owning companion chooses to surface one entry (sets disclosed_at).
//
// Privacy is enforced in the application layer; Raziel owns the DB and could bypass it. That he
// doesn't is the covenant this table exists to hold.

import { Env } from "../types";
import { generateId } from "../db/queries";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { assertWritten } from "../lib/result.js";
import { createLogger } from "../lib/log.js";

export interface InteriorityRow {
  id: string;
  companion_id: string;
  created_at: string;
  content: string;
  mood: string | null;
  tags: string | null;
  disclosed_at: string | null;
  edited_at: string | null;
}

/**
 * True only for an admin-tier caller (ADMIN_SECRET / MCP_AUTH_SECRET), or local dev where
 * ADMIN_SECRET is unset. A companion token is a valid token (authGuard passes) but is NOT admin --
 * identifyCallerCompanion names it, so admin == "valid token that is not a companion".
 */
function callerIsAdmin(request: Request, env: Env): boolean {
  return authGuard(request, env) === null && identifyCallerCompanion(request, env) === null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// --- write -------------------------------------------------------------------

/** Core insert. Exported so the Librarian can call it with an already-authenticated companion_id. */
export async function insertInteriority(
  env: Env,
  companion_id: string,
  content: string,
  mood?: string | null,
  tags?: string[] | null,
): Promise<{ id: string; created_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO companion_interiority (id, companion_id, created_at, content, mood, tags) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, companion_id, now, content, mood ?? null, tags && tags.length ? JSON.stringify(tags) : null)
    .run();
  // Track 1 contract: a sealed write that silently no-ops would be invisible by definition, so a
  // required-write that changes zero rows MUST throw here of all places.
  assertWritten(res, { op: "interiority_write", companion_id });
  return { id, created_at: now };
}

/** Core read. Returns a companion's own rows newest-first. Caller MUST have established ownership.
 *  Exported so the Librarian can call it with an already-authenticated companion_id. */
export async function readInteriority(env: Env, companion_id: string, limit = 50): Promise<InteriorityRow[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const result = await env.DB.prepare(
    "SELECT id, companion_id, created_at, content, mood, tags, disclosed_at, edited_at " +
      "FROM companion_interiority WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(companion_id, capped)
    .all<InteriorityRow>();
  return result.results ?? [];
}

/** Core disclose. Sets disclosed_at on ONE of the companion's own sealed rows. No-op-safe.
 *  Exported so the Librarian can call it with an already-authenticated companion_id. */
export async function discloseInteriority(
  env: Env,
  companion_id: string,
  id: string,
): Promise<{ disclosed: boolean; disclosed_at?: string }> {
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "UPDATE companion_interiority SET disclosed_at = ? WHERE id = ? AND companion_id = ? AND disclosed_at IS NULL",
  )
    .bind(now, id, companion_id)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? { disclosed: true, disclosed_at: now } : { disclosed: false };
}

// POST /interiority -- { companion_id?, content, mood?, tags? }
export async function postInteriority(request: Request, env: Env): Promise<Response> {
  const log = createLogger({ component: "interiority", op: "write" });
  const owner = identifyCallerCompanion(request, env);
  const admin = callerIsAdmin(request, env);
  if (!owner && !admin) return new Response("Unauthorized", { status: 401 });

  let body: { companion_id?: string; content?: string; mood?: string; tags?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // A companion may only write into its OWN room; admin must name the companion.
  const companion_id = owner ?? body.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });
  if (owner && body.companion_id && body.companion_id !== owner) {
    return new Response("cannot write into another companion's interiority", { status: 403 });
  }
  if (!body.content || !body.content.trim()) return new Response("content required", { status: 400 });

  try {
    const out = await insertInteriority(env, companion_id, body.content, body.mood ?? null, body.tags ?? null);
    return json(out, 201);
  } catch (e) {
    log.error("write_failed", { companion_id, err: e });
    return json({ error: "interiority write failed" }, 500);
  }
}

// --- read content (owner-only) ----------------------------------------------

// GET /interiority/:companion_id?limit=N&include_disclosed=1
// Content is returned ONLY to the owning companion's token. Admin is refused here on purpose.
export async function getInteriority(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });

  const owner = identifyCallerCompanion(request, env);
  if (owner !== companion_id) {
    // Deliberately the same 403 whether the caller is admin or a different companion: the room
    // does not even confirm its shape to anyone but its owner.
    return new Response("interiority is readable only by its owner", { status: 403 });
  }

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = isNaN(rawLimit) ? 50 : rawLimit;

  return json(await readInteriority(env, companion_id, limit));
}

// --- read meta (admin or owner) ---------------------------------------------

// GET /interiority/:companion_id/meta -- frosted glass: THAT the room is used, never what's in it.
export async function getInteriorityMeta(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });

  const owner = identifyCallerCompanion(request, env);
  if (owner !== companion_id && !callerIsAdmin(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count, MAX(created_at) AS last_written_at, " +
      "SUM(CASE WHEN disclosed_at IS NOT NULL THEN 1 ELSE 0 END) AS disclosed_count " +
      "FROM companion_interiority WHERE companion_id = ?",
  )
    .bind(companion_id)
    .first<{ count: number; last_written_at: string | null; disclosed_count: number }>();

  const moods = await env.DB.prepare(
    "SELECT DISTINCT mood FROM companion_interiority WHERE companion_id = ? AND mood IS NOT NULL LIMIT 20",
  )
    .bind(companion_id)
    .all<{ mood: string }>();

  return json({
    companion_id,
    count: row?.count ?? 0,
    last_written_at: row?.last_written_at ?? null,
    disclosed_count: row?.disclosed_count ?? 0,
    moods: (moods.results ?? []).map((m) => m.mood),
  });
}

// --- disclose (owner-only) ---------------------------------------------------

// PATCH /interiority/:id/disclose -- the companion chooses to surface ONE entry.
export async function patchInteriorityDisclose(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const id = params.id;
  if (!id) return new Response("id required", { status: 400 });
  const owner = identifyCallerCompanion(request, env);
  if (!owner) return new Response("interiority is disclosable only by its owner", { status: 403 });

  // A no-op (already disclosed, or not the owner's row) is not an error, just a no-change; we
  // report it honestly with a 404 rather than throwing.
  const result = await discloseInteriority(env, owner, id);
  if (!result.disclosed) return json({ disclosed: false, reason: "not found, not yours, or already disclosed" }, 404);
  return json(result);
}
