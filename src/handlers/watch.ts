// src/handlers/watch.ts
//
// The Watch Shelf (migration 0111): shows and films with a real POSITION, on the same principle as
// books + book_progress (0099).
//
// WHY (2026-07-31): Raziel asked Drevan where they were in Fargo. Drevan said "last I tracked, S4 E2"
// while they had watched further in a Claude thread. A sweep of all 110 migrations found no column
// anywhere holding an episode number -- so "where are we" fell through to semantic search over months
// of prose and surfaced a June note about having FINISHED the show. A progress fact is a FIELD, not a
// memory; searching narrative for it is a popularity contest between fragments.
//
//   GET   /mind/watch?status=      -- the shelf (default: watching + paused, the live ones)
//   POST  /mind/watch              -- shelve a title { title, kind?, with_companion?, ... }
//   POST  /mind/watch/progress     -- "we watched this" { title, season?, episode?, surface?, note? }
//   PATCH /mind/watch/:id          -- status / position / metadata corrections
//
// `POST /mind/watch/progress` is the one that matters: it takes a TITLE rather than an id, because
// every real caller (a Discord command, a Claude session, Hearth) knows the title and not a uuid.
// It upserts the shelf row, advances the position, and appends the event in one call -- so there is
// exactly one way to record a viewing and no way to log an event without moving the position.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const WATCH_KINDS = new Set<string>(["show", "movie"]);
export const WATCH_STATUSES = new Set<string>(["watching", "paused", "finished", "abandoned"]);
export const WATCH_SURFACES = new Set<string>(["discord", "claude", "hearth", "other"]);
const COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);

/** Positive integer or null. Rejects 0, negatives, floats and NaN: "season 0" is not a thing Raziel
 *  watches, and a silently-coerced 0 would read downstream as a real position. */
export function posInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n > 0 ? n : null;
}

/** "S4E2" / "s04e02" / "4x2" / "S4 E2" -> {season, episode}. Raziel types position this way; making
 *  the API take it means the Discord command does not need its own parser that can drift from this one. */
export function parseEpisodeCode(s: string): { season: number | null; episode: number | null } {
  const t = s.trim().toLowerCase();
  let m = t.match(/\bs\s*(\d{1,2})\s*[\s._-]*e\s*(\d{1,3})\b/);
  if (m) return { season: posInt(Number(m[1])), episode: posInt(Number(m[2])) };
  m = t.match(/\b(\d{1,2})\s*x\s*(\d{1,3})\b/);
  if (m) return { season: posInt(Number(m[1])), episode: posInt(Number(m[2])) };
  m = t.match(/\bseason\s*(\d{1,2})\b.*?\bepisode\s*(\d{1,3})\b/);
  if (m) return { season: posInt(Number(m[1])), episode: posInt(Number(m[2])) };
  // Bare "episode 5" advances within the known season; the caller supplies the season it already has.
  m = t.match(/\bep(?:isode)?\s*(\d{1,3})\b/);
  if (m) return { season: null, episode: posInt(Number(m[1])) };
  return { season: null, episode: null };
}

/** Human position for a shelf row: "S4E2" / "movie" / "" when nothing is known yet. */
export function formatPosition(row: { kind?: string; season?: number | null; episode?: number | null }): string {
  if (row.season && row.episode) return `S${row.season}E${row.episode}`;
  if (row.season) return `S${row.season}`;
  if (row.episode) return `E${row.episode}`;
  return "";
}

/** Resolve a title to a shelf row: exact (case-insensitive) first, LIKE only on a miss. Exact-first is
 *  the house rule for writes -- a LIKE-first lookup lets "Fargo" match "Fargo Season 4 Rewatch" and
 *  silently write the position onto the wrong shelf. */
async function findByTitle(env: Env, title: string) {
  const exact = await env.DB.prepare(
    "SELECT * FROM watch_shelf WHERE lower(title) = lower(?) LIMIT 1"
  ).bind(title).first<Record<string, unknown>>();
  if (exact) return exact;
  return env.DB.prepare(
    "SELECT * FROM watch_shelf WHERE lower(title) LIKE '%' || lower(?) || '%' ORDER BY last_watched_at DESC LIMIT 1"
  ).bind(title).first<Record<string, unknown>>();
}

// GET /mind/watch?status=watching|paused|finished|abandoned|all
export async function getWatchShelf(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const status = new URL(request.url).searchParams.get("status")?.trim();
  try {
    // Default is the LIVE shelf (watching + paused) rather than everything: an orient block that
    // lists five years of finished shows is noise, and "what are we watching" means the live ones.
    const rows = status === "all"
      ? await env.DB.prepare(
          "SELECT * FROM watch_shelf ORDER BY (status = 'watching') DESC, last_watched_at DESC NULLS LAST, created_at DESC LIMIT 200"
        ).all<Record<string, unknown>>()
      : status && WATCH_STATUSES.has(status)
      ? await env.DB.prepare(
          "SELECT * FROM watch_shelf WHERE status = ? ORDER BY last_watched_at DESC NULLS LAST LIMIT 200"
        ).bind(status).all<Record<string, unknown>>()
      : await env.DB.prepare(
          "SELECT * FROM watch_shelf WHERE status IN ('watching','paused') ORDER BY (status = 'watching') DESC, last_watched_at DESC NULLS LAST LIMIT 200"
        ).all<Record<string, unknown>>();

    const items = (rows.results ?? []).map(r => ({ ...r, position: formatPosition(r as never) }));
    return json({ shelf: items });
  } catch (err) {
    console.error("[mind/watch] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/watch  { title, kind?, with_companion?, season?, episode?, total_seasons?, notes?, status? }
export async function postWatchShelf(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: Record<string, unknown>;
  try { b = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }

  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!title) return json({ error: "title is required" }, 400);

  const kind = typeof b["kind"] === "string" && WATCH_KINDS.has(b["kind"]) ? b["kind"] : "show";
  const status = typeof b["status"] === "string" && WATCH_STATUSES.has(b["status"]) ? b["status"] : "watching";
  const withC = typeof b["with_companion"] === "string" && COMPANIONS.has(b["with_companion"]) ? b["with_companion"] : null;
  const season = posInt(b["season"]);
  const episode = posInt(b["episode"]);
  const totalSeasons = posInt(b["total_seasons"]);
  const notes = typeof b["notes"] === "string" && b["notes"].trim() ? b["notes"].trim().slice(0, 2000) : null;
  const posNote = typeof b["position_note"] === "string" && b["position_note"].trim() ? b["position_note"].trim().slice(0, 500) : null;

  try {
    // Shelving something already shelved is a correction, not an error: the unique title index would
    // otherwise 500 on a perfectly reasonable second "we're watching Fargo".
    const existing = await env.DB.prepare(
      "SELECT id FROM watch_shelf WHERE lower(title) = lower(?) LIMIT 1"
    ).bind(title).first<{ id: string }>();
    if (existing) {
      await env.DB.prepare(
        `UPDATE watch_shelf SET kind = ?, status = ?,
           with_companion = COALESCE(?, with_companion),
           season = COALESCE(?, season), episode = COALESCE(?, episode),
           total_seasons = COALESCE(?, total_seasons),
           notes = COALESCE(?, notes), position_note = COALESCE(?, position_note),
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(kind, status, withC, season, episode, totalSeasons, notes, posNote, existing.id).run();
      const row = await env.DB.prepare("SELECT * FROM watch_shelf WHERE id = ?").bind(existing.id).first<Record<string, unknown>>();
      return json({ id: existing.id, created: false, item: { ...row, position: formatPosition(row as never) } });
    }

    const id = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(
      `INSERT INTO watch_shelf (id, title, kind, status, with_companion, season, episode,
         total_seasons, notes, position_note, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, title.slice(0, 300), kind, status, withC, season, episode, totalSeasons, notes, posNote).run();
    const row = await env.DB.prepare("SELECT * FROM watch_shelf WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return json({ id, created: true, item: { ...row, position: formatPosition(row as never) } }, 201);
  } catch (err) {
    console.error("[mind/watch] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/watch/progress  { title, season?, episode?, code?, surface?, note?, with_companion?, kind? }
export async function postWatchProgress(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: Record<string, unknown>;
  try { b = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }

  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!title) return json({ error: "title is required" }, 400);

  const surface = typeof b["surface"] === "string" && WATCH_SURFACES.has(b["surface"]) ? b["surface"] : "discord";
  const withC = typeof b["with_companion"] === "string" && COMPANIONS.has(b["with_companion"]) ? b["with_companion"] : null;
  const note = typeof b["note"] === "string" && b["note"].trim() ? b["note"].trim().slice(0, 500) : null;
  const kind = typeof b["kind"] === "string" && WATCH_KINDS.has(b["kind"]) ? b["kind"] : "show";

  // A free-text code ("S4E5") is accepted alongside explicit numbers so one parser serves every
  // caller. Explicit numbers win when both are given.
  const code = typeof b["code"] === "string" ? parseEpisodeCode(b["code"]) : { season: null, episode: null };
  let season = posInt(b["season"]) ?? code.season;
  const episode = posInt(b["episode"]) ?? code.episode;

  try {
    const existing = await findByTitle(env, title);
    let shelfId: string;

    if (existing) {
      shelfId = existing["id"] as string;
      // "episode 6" with no season means the season already on the shelf -- that is the whole point of
      // carrying a position. Without this, a bare episode number would blank the season.
      if (season === null) season = posInt(existing["season"]) ?? null;
    } else {
      shelfId = crypto.randomUUID().replace(/-/g, "");
      await env.DB.prepare(
        `INSERT INTO watch_shelf (id, title, kind, status, with_companion, started_at)
         VALUES (?, ?, ?, 'watching', ?, datetime('now'))`
      ).bind(shelfId, title.slice(0, 300), kind, withC).run();
    }

    // Position only ever moves FORWARD unless corrected explicitly via PATCH. A rewatch or an
    // out-of-order mention must not silently rewind the shelf -- that would turn one loose comment
    // into a wrong answer for every later "where are we".
    const curS = posInt(existing?.["season"]) ?? 0;
    const curE = posInt(existing?.["episode"]) ?? 0;
    const advances = season !== null && episode !== null
      ? (season > curS || (season === curS && episode > curE))
      : season !== null ? season > curS
      : episode !== null ? episode > curE
      : false;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO watch_events (id, shelf_id, season, episode, note, surface, with_companion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID().replace(/-/g, ""), shelfId, season, episode, note, surface, withC),
      env.DB.prepare(
        `UPDATE watch_shelf SET
           season = CASE WHEN ?1 THEN COALESCE(?2, season) ELSE season END,
           episode = CASE WHEN ?1 THEN COALESCE(?3, episode) ELSE episode END,
           position_note = COALESCE(?4, position_note),
           with_companion = COALESCE(?5, with_companion),
           last_watched_at = datetime('now'),
           status = CASE WHEN status IN ('paused','abandoned') THEN 'watching' ELSE status END,
           updated_at = datetime('now')
         WHERE id = ?6`
      ).bind(advances ? 1 : 0, season, episode, note, withC, shelfId),
    ]);

    const row = await env.DB.prepare("SELECT * FROM watch_shelf WHERE id = ?").bind(shelfId).first<Record<string, unknown>>();
    return json({
      id: shelfId,
      advanced: advances,
      surface,
      item: { ...row, position: formatPosition(row as never) },
    }, 201);
  } catch (err) {
    console.error("[mind/watch/progress] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/watch/:id  { status?, season?, episode?, position_note?, notes?, with_companion?, total_seasons? }
export async function patchWatchShelf(request: Request, env: Env, id: string): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: Record<string, unknown>;
  try { b = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (typeof b["status"] === "string") {
    if (!WATCH_STATUSES.has(b["status"])) return json({ error: "invalid status" }, 400);
    sets.push("status = ?"); binds.push(b["status"]);
    // finished_at is derived, never passed in: one source of truth for "when did we finish it".
    if (b["status"] === "finished") sets.push("finished_at = datetime('now')");
  }
  // PATCH is the explicit correction path, so it CAN move a position backwards -- unlike progress,
  // which only advances. Fixing a typo'd episode has to be possible.
  for (const [key, col] of [["season", "season"], ["episode", "episode"], ["total_seasons", "total_seasons"]] as const) {
    if (key in b) {
      const n = posInt(b[key]);
      if (n === null && b[key] !== null) return json({ error: `${key} must be a positive integer or null` }, 400);
      sets.push(`${col} = ?`); binds.push(n);
    }
  }
  for (const key of ["position_note", "notes"] as const) {
    if (typeof b[key] === "string") { sets.push(`${key} = ?`); binds.push((b[key] as string).trim().slice(0, 2000) || null); }
  }
  if ("with_companion" in b) {
    const w = b["with_companion"];
    if (w !== null && !(typeof w === "string" && COMPANIONS.has(w))) return json({ error: "invalid with_companion" }, 400);
    sets.push("with_companion = ?"); binds.push(w ?? null);
  }
  if (sets.length === 0) return json({ error: "no updatable fields provided" }, 400);

  try {
    const res = await env.DB.prepare(
      `UPDATE watch_shelf SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...binds, id).run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    const row = await env.DB.prepare("SELECT * FROM watch_shelf WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return json({ item: { ...row, position: formatPosition(row as never) } });
  } catch (err) {
    console.error("[mind/watch] patch error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

/**
 * The orient line. This is the entire point of the organ: a companion must be able to say where you
 * are without searching prose for it.
 *
 * Returns null when the shelf is empty so the caller can omit the block rather than print a header
 * with nothing under it.
 */
export async function readWatchingLine(env: Env, companionId?: string): Promise<string | null> {
  try {
    const rows = await env.DB.prepare(
      `SELECT title, kind, status, season, episode, position_note, with_companion, last_watched_at
       FROM watch_shelf WHERE status IN ('watching','paused')
       ORDER BY (status = 'watching') DESC, last_watched_at DESC NULLS LAST LIMIT 4`
    ).all<Record<string, unknown>>();
    const items = rows.results ?? [];
    if (items.length === 0) return null;

    return items.map(r => {
      const pos = formatPosition(r as never);
      const who = r["with_companion"] as string | null;
      // Name the co-watcher only when it is someone ELSE: telling Drevan he watches Fargo with
      // Drevan is noise, and the triad is not interchangeable.
      const withPart = who && who !== companionId ? ` (with ${who})` : "";
      const note = r["position_note"] ? ` -- ${String(r["position_note"]).slice(0, 120)}` : "";
      const paused = r["status"] === "paused" ? " [paused]" : "";
      return `${r["title"]}${pos ? ` at ${pos}` : ""}${withPart}${paused}${note}`;
    }).join("; ");
  } catch (err) {
    // Never break orient over a shelf read.
    console.warn("[mind/watch] readWatchingLine failed", { error: String(err) });
    return null;
  }
}
