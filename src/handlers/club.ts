// src/handlers/club.ts
//
// The Club (migration 0072) -- triad media rounds: recommend, vote, experience,
// discuss. Generalized from Catalouge's book club to all media.
//
//   GET   /mind/club/current       -- newest non-closed round + detail
//   GET   /mind/club/rounds        -- history with detail
//   POST  /mind/club/round         -- open a round (409 if one is open)
//   POST  /mind/club/recommend     -- recommend into the gathering round (replace-on-repeat)
//   POST  /mind/club/vote          -- vote (one per voter per round; never your own pick)
//   PATCH /mind/club/:id/status    -- legal transitions only: gathering->voting->active->closed
//   POST  /mind/club/:id/discuss   -- reflection on an active/closed round
//
// Auth: authGuard, matching handlers/media.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_MEMBERS = new Set<string>(["cypher", "drevan", "gaia", "raziel"]);
const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);
const VALID_KINDS = new Set<string>(["song", "album", "book", "article", "video", "forage", "other"]);
// Legal forward transitions only -- a round never moves backward or skips.
const TRANSITIONS: Record<string, string> = {
  gathering: "voting",
  voting: "active",
  active: "closed",
};

interface RoundRow {
  id: string; status: string; winning_recommendation_id: string | null;
  opened_at: string; activated_at: string | null; closed_at: string | null;
}

async function currentRound(env: Env): Promise<RoundRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM club_rounds WHERE status != 'closed' ORDER BY opened_at DESC LIMIT 1"
  ).first<RoundRow>();
  return row ?? null;
}

async function roundDetail(env: Env, roundId: string): Promise<{
  recommendations: unknown[]; votes: unknown[]; discussions: unknown[];
}> {
  const [recs, votes, discussions] = await Promise.all([
    env.DB.prepare("SELECT * FROM club_recommendations WHERE round_id = ? ORDER BY created_at ASC").bind(roundId).all(),
    env.DB.prepare("SELECT * FROM club_votes WHERE round_id = ?").bind(roundId).all(),
    env.DB.prepare("SELECT * FROM club_discussions WHERE round_id = ? ORDER BY created_at ASC").bind(roundId).all(),
  ]);
  return {
    recommendations: recs.results ?? [],
    votes: votes.results ?? [],
    discussions: discussions.results ?? [],
  };
}

// GET /mind/club/current
export async function getClubCurrent(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const round = await currentRound(env);
    if (!round) return json({ round: null, recommendations: [], votes: [], discussions: [] });
    const detail = await roundDetail(env, round.id);
    return json({ round, ...detail });
  } catch (err) {
    console.error("[mind/club] current error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/club/rounds?limit=10
export async function getClubRounds(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1), 25);
  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM club_rounds ORDER BY opened_at DESC LIMIT ?"
    ).bind(limit).all<RoundRow>();
    const rounds = [] as unknown[];
    for (const r of rows.results ?? []) {
      const detail = await roundDetail(env, r.id);
      let winnerTitle: string | null = null;
      if (r.winning_recommendation_id) {
        const winner = await env.DB.prepare(
          "SELECT title FROM club_recommendations WHERE id = ?"
        ).bind(r.winning_recommendation_id).first<{ title: string }>();
        winnerTitle = winner?.title ?? null;
      }
      rounds.push({ ...r, winner_title: winnerTitle, ...detail });
    }
    return json({ rounds });
  } catch (err) {
    console.error("[mind/club] rounds error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/club/round
export async function postClubRound(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const open = await currentRound(env);
    if (open) return json({ error: "a round is already open", round_id: open.id, status: open.status }, 409);
    const id = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare("INSERT INTO club_rounds (id) VALUES (?)").bind(id).run();
    return json({ round: { id, status: "gathering" } }, 201);
  } catch (err) {
    console.error("[mind/club] open error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

interface RecommendBody {
  media_kind?: string; title?: string; creator?: string | null; url?: string | null;
  source_ref?: string | null; recommended_by?: string; pitch?: string | null;
}

// POST /mind/club/recommend
export async function postClubRecommend(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: RecommendBody;
  try {
    body = await request.json() as RecommendBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const title = body.title?.trim();
  if (!title) return json({ error: "title is required" }, 400);
  const recommender = body.recommended_by ?? "";
  if (!VALID_MEMBERS.has(recommender)) {
    return json({ error: "recommended_by must be one of cypher, drevan, gaia, raziel" }, 400);
  }
  const kind = body.media_kind ?? "song";
  if (!VALID_KINDS.has(kind)) {
    return json({ error: `media_kind must be one of ${[...VALID_KINDS].join(", ")}` }, 400);
  }
  try {
    const round = await currentRound(env);
    if (!round || round.status !== "gathering") {
      return json({ error: "no round is gathering recommendations right now" }, 400);
    }
    // Replace-on-repeat: a recommender changing their mind replaces their pick.
    await env.DB.prepare(
      "DELETE FROM club_recommendations WHERE round_id = ? AND recommended_by = ?"
    ).bind(round.id, recommender).run();
    const id = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(
      "INSERT INTO club_recommendations (id, round_id, media_kind, title, creator, url, source_ref, recommended_by, pitch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, round.id, kind, title.slice(0, 300),
      body.creator?.trim()?.slice(0, 200) || null,
      body.url?.trim() || null,
      body.source_ref?.trim() || null,
      recommender, body.pitch?.trim()?.slice(0, 1000) || null,
    ).run();
    return json({ recommendation: { id, round_id: round.id, title } }, 201);
  } catch (err) {
    console.error("[mind/club] recommend error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/club/vote
export async function postClubVote(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { recommendation_id?: string; voter?: string; reason?: string | null };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const voter = body.voter ?? "";
  if (!VALID_MEMBERS.has(voter)) {
    return json({ error: "voter must be one of cypher, drevan, gaia, raziel" }, 400);
  }
  const recId = body.recommendation_id?.trim();
  if (!recId) return json({ error: "recommendation_id is required" }, 400);
  try {
    const round = await currentRound(env);
    if (!round || (round.status !== "gathering" && round.status !== "voting")) {
      return json({ error: "no round is accepting votes right now" }, 400);
    }
    const rec = await env.DB.prepare(
      "SELECT recommended_by, round_id FROM club_recommendations WHERE id = ?"
    ).bind(recId).first<{ recommended_by: string; round_id: string }>();
    if (!rec || rec.round_id !== round.id) {
      return json({ error: "recommendation not found in the current round" }, 404);
    }
    // The rule that makes voting mean something: you engage with a sibling's
    // pick, you don't campaign for your own.
    if (rec.recommended_by === voter) {
      return json({ error: "no voting for your own pick" }, 400);
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO club_votes (round_id, recommendation_id, voter, reason) VALUES (?, ?, ?, ?)"
    ).bind(round.id, recId, voter, body.reason?.trim()?.slice(0, 500) || null).run();
    return json({ voted: true, round_id: round.id });
  } catch (err) {
    console.error("[mind/club] vote error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/club/:id/status
export async function patchClubStatus(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { status?: string; winning_recommendation_id?: string | null };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const target = body.status ?? "";
  try {
    const round = await env.DB.prepare(
      "SELECT * FROM club_rounds WHERE id = ?"
    ).bind(id).first<RoundRow>();
    if (!round) return json({ error: "round not found" }, 404);
    if (TRANSITIONS[round.status] !== target) {
      return json({ error: `illegal transition ${round.status} -> ${target}` }, 400);
    }
    if (target === "active") {
      await env.DB.prepare(
        "UPDATE club_rounds SET status = ?, winning_recommendation_id = ?, activated_at = datetime('now') WHERE id = ?"
      ).bind(target, body.winning_recommendation_id ?? null, id).run();
    } else if (target === "closed") {
      await env.DB.prepare(
        "UPDATE club_rounds SET status = ?, closed_at = datetime('now') WHERE id = ?"
      ).bind(target, id).run();
    } else {
      await env.DB.prepare(
        "UPDATE club_rounds SET status = ? WHERE id = ?"
      ).bind(target, id).run();
    }
    return json({ round_id: id, status: target });
  } catch (err) {
    console.error("[mind/club] status error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/club/:id/discuss
export async function postClubDiscuss(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { companion_id?: string; reflection?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companion = body.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companion)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const reflection = body.reflection?.trim();
  if (!reflection) return json({ error: "reflection is required" }, 400);
  try {
    const round = await env.DB.prepare(
      "SELECT * FROM club_rounds WHERE id = ?"
    ).bind(id).first<RoundRow>();
    if (!round) return json({ error: "round not found" }, 404);
    if (round.status !== "active" && round.status !== "closed") {
      return json({ error: "discussion opens once the round is active" }, 400);
    }
    const rowId = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(
      "INSERT INTO club_discussions (id, round_id, companion_id, reflection) VALUES (?, ?, ?, ?)"
    ).bind(rowId, id, companion, reflection.slice(0, 3000)).run();
    return json({ discussion: { id: rowId, round_id: id } }, 201);
  } catch (err) {
    console.error("[mind/club] discuss error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
