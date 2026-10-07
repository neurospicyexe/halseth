// src/handlers/media.ts
//
// HTTP route handlers for media_experiences (migration 0071, shared-experience
// Phase 1 "Ears").
//   POST  /mind/media              -- record a listen (bot pipeline writes here)
//   GET   /mind/media/recent       -- recent listens, newest first
//   PATCH /mind/media/:id/react    -- merge one companion's reaction (json_set)
//
// Auth: authGuard, matching handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { bumpSparkle } from "./collection.js";
import { mediaKey, collapseRepeatListens, MEDIA_REPEAT_WINDOW_HOURS } from "../lib/media-key.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);
const VALID_MEDIA_TYPES = new Set<string>(["song", "video", "other"]);

interface MediaPostBody {
  media_type?: string;
  url?: string | null;
  title?: string;
  artist?: string | null;
  duration_sec?: number | null;
  shared_by?: string;
  front_state?: string | null;
  requested_companion?: string | null;
  analysis_json?: unknown;
  lyrics?: string | null;
}

// POST /mind/media
export async function postMediaExperience(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: MediaPostBody;
  try {
    body = await request.json() as MediaPostBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const title = body.title?.trim();
  if (!title) return json({ error: "title is required" }, 400);

  const mediaType = body.media_type ?? "song";
  if (!VALID_MEDIA_TYPES.has(mediaType)) {
    return json({ error: "media_type must be one of song, video, other" }, 400);
  }
  const requested = body.requested_companion ?? null;
  if (requested !== null && !VALID_COMPANIONS.has(requested)) {
    return json({ error: "requested_companion must be one of cypher, drevan, gaia, or null" }, 400);
  }
  const durationSec = typeof body.duration_sec === "number" && Number.isFinite(body.duration_sec)
    ? body.duration_sec : null;
  const analysisJson = body.analysis_json === undefined || body.analysis_json === null
    ? null : JSON.stringify(body.analysis_json).slice(0, 20_000);

  // REPEAT GUARD (2026-10-07). The same Night Vale track landed twice, 19 minutes apart, with URLs
  // that differed only in YouTube's per-share `?is=` param -- and both rows filled the orient's two
  // [Recent listens] slots. Inside the window, a post of the same media (lib/media-key.ts: YouTube
  // video id, else URL minus tracking params, else title+artist) returns the EXISTING row with 200,
  // so the bot's follow-up reaction PATCH lands on the row that already exists. A genuine re-listen
  // after the window still records. Fails open: a lookup error never blocks the write.
  const key = mediaKey({ url: body.url, title, artist: body.artist });
  try {
    const recent = await env.DB.prepare(
      "SELECT id, url, title, artist FROM media_experiences WHERE created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 50"
    ).bind(`-${MEDIA_REPEAT_WINDOW_HOURS} hours`).all<{ id: string; url: string | null; title: string; artist: string | null }>();
    const hit = (recent.results ?? []).find(r => mediaKey(r) === key);
    if (hit) {
      return json({ experience: { id: hit.id, title: hit.title, artist: hit.artist }, deduped: true }, 200);
    }
  } catch (err) {
    console.warn("[mind/media] repeat lookup failed -- recording anyway", { error: String(err) });
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO media_experiences (id, media_type, url, title, artist, duration_sec, shared_by, front_state, requested_companion, analysis_json, lyrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, mediaType, body.url?.trim() || null, title.slice(0, 300),
      body.artist?.trim()?.slice(0, 200) || null, durationSec,
      (body.shared_by?.trim() || "raziel").slice(0, 100),
      body.front_state?.trim()?.slice(0, 100) || null,
      requested, analysisJson, body.lyrics?.slice(0, 12_000) ?? null,
    ).run();
  } catch (err) {
    console.error("[mind/media] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }

  return json({ experience: { id, title, artist: body.artist ?? null } }, 201);
}

// GET /mind/media/recent?limit=5
export async function getRecentMedia(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 1), 25);

  try {
    const rows = await env.DB.prepare(
      "SELECT id, media_type, url, title, artist, duration_sec, shared_by, front_state, requested_companion, lyrics IS NOT NULL AS has_lyrics, reactions_json, created_at FROM media_experiences ORDER BY created_at DESC LIMIT ?"
    ).bind(Math.min(limit * 2, 50)).all();
    // Over-fetch and collapse repeats (lib/media-key.ts), same rule as the orient loader, so the
    // autonomous worker's "recent listens" cannot list one double-posted track twice.
    const collapsed = collapseRepeatListens((rows.results ?? []) as Array<Record<string, unknown> & { url?: string | null; title?: string | null; artist?: string | null }>).slice(0, limit);
    const experiences = collapsed.map(r => {
      let reactions: Record<string, string> = {};
      try { reactions = JSON.parse(String((r as Record<string, unknown>)["reactions_json"] ?? "{}")) as Record<string, string>; } catch { /* malformed -> empty */ }
      const { reactions_json: _drop, ...rest } = r as Record<string, unknown>;
      return { ...rest, reactions };
    });
    return json({ experiences });
  } catch (err) {
    console.error("[mind/media] recent error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/media/:id/react
export async function reactToMedia(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { companion_id?: string; reaction?: string };
  try {
    body = await request.json() as { companion_id?: string; reaction?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companion = body.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companion)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const reaction = body.reaction?.trim();
  if (!reaction) return json({ error: "reaction is required" }, 400);

  // SQL-level json_set (covenant: never JS read-modify-write on JSON columns).
  // companion is validated against a closed set above, so the '$.' path is safe.
  try {
    const result = await env.DB.prepare(
      "UPDATE media_experiences SET reactions_json = json_set(COALESCE(reactions_json, '{}'), '$.' || ?, ?) WHERE id = ?"
    ).bind(companion, reaction.slice(0, 2000), id).run();
    if ((result.meta?.changes ?? 0) === 0) return json({ error: "experience not found" }, 404);
    // Take 13: a listen that earned a reaction gains sparkle in the collection.
    // Best-effort -- never fail the react on a sparkle write.
    await bumpSparkle(env, "media_experiences", id, "react").catch(() => {});
    return json({ reacted: true });
  } catch (err) {
    console.error("[mind/media] react error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
