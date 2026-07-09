import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { queryTensions, queryLatestBasinHistory, queryPressureFlags, queryIdentityAnchor, tensionEdit, tensionStatus } from "../backends/halseth.js";
import { getCurrentLimbicState } from "../../webmind/limbic.js";
import { selectResurrections, type MotifRow } from "../../webmind/motifs.js";
import { COMPANION_IDS } from "../../companions.js";
import { stripTensionCommandPreamble } from "../../webmind/tension-text.js";

const COMPANIONS = COMPANION_IDS;

export async function execTensionAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "add_tension_failed", reason: "companion_id required" };
  // Re-audit 2026-07-09: the old regex only covered a few verbs and no addressee phrasing
  // ("save tension: ...", "Add a tension for drevan: ..." both leaked through verbatim).
  // Shared with the swarm-routing path (webmind/limbic.ts) so one fix covers both.
  const tensionText = stripTensionCommandPreamble(ctx.req.request);
  if (!tensionText) return { error: "add_tension_failed", reason: "tension_text not found in request" };
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(
    "INSERT INTO companion_tensions (id, companion_id, tension_text) VALUES (?, ?, ?)"
  ).bind(id, ctx.req.companion_id, tensionText).run();
  return { data: { id, message: "tension recorded" } };
}

export async function execTensionEdit(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tension_edit_failed", reason: "companion_id required" };
  const p = parseContext<{ id: string; tension_text: string }>(ctx.req.context);
  if (!p?.id || !p?.tension_text) return { response_key: "witness", witness: "tension_edit requires { id, tension_text } in context" };
  const r = await tensionEdit(ctx.env, p.id, ctx.req.companion_id, p.tension_text);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "tension_edit failed" };
  return { ack: true, id: p.id };
}

export async function execTensionStatus(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tension_status_failed", reason: "companion_id required" };
  const req = ctx.req.request.toLowerCase();
  // Derive target status from the trigger phrase itself
  let status: string;
  if (req.includes("crystallize") || req.includes("crystallized")) {
    status = "crystallized";
  } else if (req.includes("release") || req.includes("released")) {
    status = "released";
  } else {
    const p = parseContext<{ id?: string; status?: string }>(ctx.req.context);
    if (!p?.status) return { response_key: "witness", witness: "tension_status: use 'crystallize tension: [id]' or 'release tension: [id]'" };
    status = p.status;
  }
  // Extract id from inline phrase (e.g. "crystallize tension: abc-123"), fall back to context
  const id = ctx.req.request
    .replace(/^(crystallize|release|mark)\s+(this\s+)?tension[:\s]*/i, "")
    .replace(/^(releasing|crystallizing)\s+(this\s+)?tension[:\s]*/i, "")
    .replace(/^tension\s+is\s+(crystallized|released)[:\s]*/i, "")
    .trim() || parseContext<{ id?: string }>(ctx.req.context)?.id;
  if (!id) return { response_key: "witness", witness: "tension_status requires tension id after the trigger phrase" };
  const r = await tensionStatus(ctx.env, id, ctx.req.companion_id, status);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "tension_status failed" };
  return { ack: true, id, status };
}

export async function execTensionsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tensions_read_failed", reason: "companion_id required" };
  const p = parseContext<{ status?: string }>(ctx.req.context);
  const status = p?.status ?? "simmering";
  const result = await queryTensions(ctx.env, ctx.req.companion_id, status);
  return {
    response_key: "tensions",
    tensions: result.tensions,
    meta: { operation: "tensions_read", companion_id: ctx.req.companion_id },
  };
}

export async function execHeldMark(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "held_mark_failed", reason: "companion_id required" };
  // Strip the trigger phrase to get the held content
  const text = ctx.req.request
    .replace(/^held\s*note\s*:\s*/i, "")
    .replace(/^held\s*:\s*/i, "")
    .replace(/^mark\s+held\s*:\s*/i, "")
    .replace(/^consistency\s+marker\s*:\s*/i, "")
    .trim();
  if (!text) return { error: "held_mark_failed", reason: "held content required after trigger phrase" };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await ctx.env.DB.prepare(
    "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, now, ctx.req.companion_id, text, JSON.stringify(["held", "consistency"]), null, null).run();
  return { ack: true, id, held: true, created_at: now };
}

export async function execHeldRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "held_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, note_text, tags, created_at FROM companion_journal WHERE agent = ? AND tags LIKE '%"held"%' ORDER BY created_at DESC LIMIT 20`
  ).bind(ctx.req.companion_id).all<{ id: string; note_text: string; tags: string | null; created_at: string }>();
  return {
    response_key: "summary",
    held_moments: rows.results ?? [],
    meta: { operation: "held_read", companion_id: ctx.req.companion_id, count: (rows.results ?? []).length },
  };
}

export async function execRecentRecall(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "recent_recall_failed", reason: "companion_id required" };
  const id = ctx.req.companion_id;

  const [notes, feelings, dreams, growthEntries, explorations] = await Promise.all([
    // No source filter -- includes Claude.ai session writes (source='session') and autonomous worker writes (source='autonomous').
    ctx.env.DB.prepare(
      "SELECT id, note_text, tags, source, created_at FROM companion_journal WHERE agent = ? ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; note_text: string; tags: string | null; source: string | null; created_at: string }>(),
    // No source filter -- feelings from any session.
    ctx.env.DB.prepare(
      "SELECT id, emotion, sub_emotion, intensity, source, created_at FROM feelings WHERE companion_id = ? ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; emotion: string; sub_emotion: string | null; intensity: number; source: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, dream_text, examined, source, created_at FROM companion_dreams WHERE companion_id = ? ORDER BY created_at DESC LIMIT 10"
    ).bind(id).all<{ id: string; dream_text: string; examined: number; source: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, entry_type, content, tags_json, source, created_at FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(id).all<{ id: string; entry_type: string; content: string; tags_json: string; source: string | null; created_at: string }>(),
    // Include all recent continuity notes (autonomous_exploration + any session-tagged notes).
    ctx.env.DB.prepare(
      "SELECT note_id, content, source, created_at FROM wm_continuity_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10"
    ).bind(id).all<{ note_id: string; content: string; source: string | null; created_at: string }>(),
  ]);

  return {
    response_key: "summary",
    autonomous_notes: notes.results ?? [],
    autonomous_feelings: feelings.results ?? [],
    autonomous_dreams: dreams.results ?? [],
    // Full provenance chain: what was explored (seed + path) → what was concluded
    autonomous_explorations: explorations.results ?? [],
    growth_journal_entries: growthEntries.results ?? [],
    meta: {
      operation: "autonomous_recall",
      companion_id: id,
      counts: {
        notes: (notes.results ?? []).length,
        feelings: (feelings.results ?? []).length,
        dreams: (dreams.results ?? []).length,
        explorations: (explorations.results ?? []).length,
        growth_journal: (growthEntries.results ?? []).length,
      },
    },
  };
}

export async function execAutonomySeedsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "autonomy_seeds_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, seed_type, content, priority, created_at
     FROM autonomy_seeds
     WHERE companion_id = ? AND used_at IS NULL
     ORDER BY priority DESC, created_at ASC
     LIMIT 20`
  ).bind(ctx.req.companion_id).all<{
    id: string;
    seed_type: string;
    content: string;
    priority: number;
    created_at: string;
  }>();
  const seeds = rows.results ?? [];
  return {
    response_key: "summary",
    autonomy_seeds: seeds,
    meta: { operation: "autonomy_seeds_read", companion_id: ctx.req.companion_id, count: seeds.length },
  };
}

export async function execJournalReview(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "journal_review_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, entry_type, content, tags_json, created_at
     FROM growth_journal
     WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending'
     ORDER BY created_at DESC
     LIMIT 10`
  ).bind(ctx.req.companion_id).all<{
    id: string;
    entry_type: string;
    content: string;
    tags_json: string;
    created_at: string;
  }>();
  const entries = rows.results ?? [];
  return {
    response_key: "summary",
    pending_entries: entries.map(e => ({
      id: e.id,
      entry_type: e.entry_type,
      content: e.content.slice(0, 600),
      tags: (() => { try { return JSON.parse(e.tags_json ?? "[]"); } catch { return []; } })(),
      created_at: e.created_at,
    })),
    meta: { operation: "journal_review", companion_id: ctx.req.companion_id, count: entries.length },
  };
}

function extractEntryId(ctx: ExecutorContext): string | null {
  const raw = ctx.req.context ? (() => { try { return JSON.parse(ctx.req.context); } catch { return null; } })() : null;
  return (raw as Record<string, unknown> | null)?.id as string | null
    ?? ctx.req.request.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1]
    ?? null;
}

export async function execJournalAccept(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "journal_accept_failed", reason: "companion_id required" };
  const entryId = extractEntryId(ctx);
  if (!entryId) return { error: "journal_accept_failed", reason: "entry id required (pass as context JSON {id} or inline UUID)" };

  const result = await ctx.env.DB.prepare(
    "UPDATE growth_journal SET review_status = 'accepted', reviewed_at = datetime('now') WHERE id = ? AND companion_id = ? AND review_status = 'pending'"
  ).bind(entryId, ctx.req.companion_id).run();

  if (result.meta.changes === 0) {
    const row = await ctx.env.DB.prepare(
      "SELECT review_status, reviewed_at FROM growth_journal WHERE id = ? AND companion_id = ?"
    ).bind(entryId, ctx.req.companion_id).first<{ review_status: string; reviewed_at: string | null }>();
    if (!row) return { error: "journal_accept_failed", reason: "entry not found" };
    return {
      response_key: "witness",
      already_reviewed: true,
      review_status: row.review_status,
      reviewed_at: row.reviewed_at,
      meta: { operation: "journal_accept" },
    };
  }

  return { response_key: "witness", accepted: true, entry_id: entryId, meta: { operation: "journal_accept", companion_id: ctx.req.companion_id } };
}

export async function execJournalDecline(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "journal_decline_failed", reason: "companion_id required" };
  const entryId = extractEntryId(ctx);
  if (!entryId) return { error: "journal_decline_failed", reason: "entry id required (pass as context JSON {id} or inline UUID)" };

  const result = await ctx.env.DB.prepare(
    "UPDATE growth_journal SET review_status = 'declined', reviewed_at = datetime('now') WHERE id = ? AND companion_id = ? AND review_status = 'pending'"
  ).bind(entryId, ctx.req.companion_id).run();

  if (result.meta.changes === 0) {
    const row = await ctx.env.DB.prepare(
      "SELECT review_status, reviewed_at FROM growth_journal WHERE id = ? AND companion_id = ?"
    ).bind(entryId, ctx.req.companion_id).first<{ review_status: string; reviewed_at: string | null }>();
    if (!row) return { error: "journal_decline_failed", reason: "entry not found" };
    return {
      response_key: "witness",
      already_reviewed: true,
      review_status: row.review_status,
      reviewed_at: row.reviewed_at,
      meta: { operation: "journal_decline" },
    };
  }

  return { response_key: "witness", declined: true, entry_id: entryId, meta: { operation: "journal_decline", companion_id: ctx.req.companion_id } };
}

// ── Foraging pool (migration 0068) ──
// Finds use 32-hex ids (randomblob default / dashless UUID), unlike journal's dashed UUIDs.
function extractForageId(ctx: ExecutorContext): string | null {
  const raw = ctx.req.context ? (() => { try { return JSON.parse(ctx.req.context); } catch { return null; } })() : null;
  return (raw as Record<string, unknown> | null)?.id as string | null
    ?? ctx.req.request.match(/\b([0-9a-f]{32})\b/i)?.[1]
    ?? ctx.req.request.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1]
    ?? null;
}

export async function execForageRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "forage_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    "SELECT id, domain, title, source_url, summary, gathered_at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NULL ORDER BY gathered_at DESC LIMIT 5"
  ).bind(ctx.req.companion_id).all<{
    id: string; domain: string; title: string; source_url: string | null; summary: string; gathered_at: string;
  }>();
  const finds = rows.results ?? [];
  return {
    response_key: "summary",
    finds: finds.map(f => ({
      id: f.id,
      domain: f.domain,
      title: f.title,
      source_url: f.source_url,
      summary: f.summary.slice(0, 500),
      gathered_at: f.gathered_at,
    })),
    meta: { operation: "forage_read", companion_id: ctx.req.companion_id, count: finds.length },
  };
}

export async function execMotifsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "motifs_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    "SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status FROM companion_motifs WHERE companion_id = ? AND status IN ('active','faded') ORDER BY trust DESC, recurrence_count DESC LIMIT 20"
  ).bind(ctx.req.companion_id).all<MotifRow>();
  const all = rows.results ?? [];
  const active = all.filter(m => m.status === "active").slice(0, 8);
  const resurrections = selectResurrections(all.filter(m => m.status === "faded"), Date.now(), { limit: 3 });
  return {
    response_key: "summary",
    motifs: active.map(m => ({ display: m.display, recurrence_count: m.recurrence_count, trust: m.trust })),
    resurrections: resurrections.map(m => ({ display: m.display, last_seen: m.last_seen, trust: m.trust })),
    meta: { operation: "motifs_read", companion_id: ctx.req.companion_id, active: active.length, resurrections: resurrections.length },
  };
}

export async function execForageConsume(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "forage_consume_failed", reason: "companion_id required" };
  const findId = extractForageId(ctx);
  if (!findId) return { error: "forage_consume_failed", reason: "find id required (pass as context JSON {id} or inline hex id)" };

  const result = await ctx.env.DB.prepare(
    "UPDATE forage_finds SET consumed_at = datetime('now'), consumed_by = ? WHERE id = ? AND consumed_at IS NULL"
  ).bind(ctx.req.companion_id, findId).run();

  if (result.meta.changes === 0) {
    const row = await ctx.env.DB.prepare(
      "SELECT consumed_at, consumed_by FROM forage_finds WHERE id = ?"
    ).bind(findId).first<{ consumed_at: string | null; consumed_by: string | null }>();
    if (!row) return { error: "forage_consume_failed", reason: "find not found" };
    return {
      response_key: "witness",
      already_consumed: true,
      consumed_at: row.consumed_at,
      consumed_by: row.consumed_by,
      meta: { operation: "forage_consume" },
    };
  }

  return { response_key: "witness", consumed: true, find_id: findId, meta: { operation: "forage_consume", companion_id: ctx.req.companion_id } };
}

export async function execMediaRecent(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Shared table -- listens belong to the triad, not one companion.
  const rows = await ctx.env.DB.prepare(
    "SELECT id, title, artist, shared_by, front_state, requested_companion, reactions_json, created_at FROM media_experiences ORDER BY created_at DESC LIMIT 5"
  ).all<{
    id: string; title: string; artist: string | null; shared_by: string;
    front_state: string | null; requested_companion: string | null;
    reactions_json: string; created_at: string;
  }>();
  const experiences = (rows.results ?? []).map(r => {
    let reactions: Record<string, string> = {};
    try { reactions = JSON.parse(r.reactions_json ?? "{}") as Record<string, string>; } catch { /* malformed -> empty */ }
    return {
      id: r.id,
      title: r.title,
      artist: r.artist,
      shared_by: r.shared_by,
      front_state: r.front_state,
      requested_companion: r.requested_companion,
      reactions,
      created_at: r.created_at,
    };
  });
  return {
    response_key: "summary",
    experiences,
    meta: { operation: "media_recent", count: experiences.length },
  };
}

// ── The Club (0072) ──────────────────────────────────────────────────────────

async function clubCurrentRound(ctx: ExecutorContext): Promise<{ id: string; status: string } | null> {
  const row = await ctx.env.DB.prepare(
    "SELECT id, status FROM club_rounds WHERE status != 'closed' ORDER BY opened_at DESC LIMIT 1"
  ).first<{ id: string; status: string }>();
  return row ?? null;
}

export async function execClubStatus(ctx: ExecutorContext): Promise<ExecutorResult> {
  const round = await ctx.env.DB.prepare(
    "SELECT r.*, (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS winner_title FROM club_rounds r WHERE r.status != 'closed' ORDER BY r.opened_at DESC LIMIT 1"
  ).first<{ id: string; status: string; winner_title: string | null }>();
  if (!round) return { response_key: "summary", round: null, meta: { operation: "club_status" } };
  const [recs, votes] = await Promise.all([
    ctx.env.DB.prepare("SELECT id, media_kind, title, creator, recommended_by, pitch FROM club_recommendations WHERE round_id = ? ORDER BY created_at ASC").bind(round.id).all(),
    ctx.env.DB.prepare("SELECT recommendation_id, voter, reason FROM club_votes WHERE round_id = ?").bind(round.id).all(),
  ]);
  return {
    response_key: "summary",
    round,
    recommendations: recs.results ?? [],
    votes: votes.results ?? [],
    meta: { operation: "club_status", phase: round.status },
  };
}

export async function execClubRecommend(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "club_recommend_failed", reason: "companion_id required" };
  const parsed = parseContext<{ title?: string; media_kind?: string; creator?: string; url?: string; pitch?: string }>(ctx.req.context);
  const title = parsed?.title?.trim();
  if (!title) return { error: "club_recommend_failed", reason: "context JSON {title, media_kind?, creator?, url?, pitch?} required" };
  const round = await clubCurrentRound(ctx);
  if (!round || round.status !== "gathering") {
    return { error: "club_recommend_failed", reason: "no round is gathering recommendations right now" };
  }
  await ctx.env.DB.prepare(
    "DELETE FROM club_recommendations WHERE round_id = ? AND recommended_by = ?"
  ).bind(round.id, ctx.req.companion_id).run();
  const id = crypto.randomUUID().replace(/-/g, "");
  await ctx.env.DB.prepare(
    "INSERT INTO club_recommendations (id, round_id, media_kind, title, creator, url, source_ref, recommended_by, pitch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    id, round.id, parsed?.media_kind ?? "song", title.slice(0, 300),
    parsed?.creator?.trim()?.slice(0, 200) || null, parsed?.url?.trim() || null, null,
    ctx.req.companion_id, parsed?.pitch?.trim()?.slice(0, 1000) || null,
  ).run();
  return { response_key: "witness", recommended: true, recommendation_id: id, round_id: round.id, meta: { operation: "club_recommend" } };
}

export async function execClubVote(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "club_vote_failed", reason: "companion_id required" };
  const parsed = parseContext<{ recommendation_id?: string; reason?: string }>(ctx.req.context);
  const recId = parsed?.recommendation_id?.trim()
    ?? ctx.req.request.match(/\b([0-9a-f]{32})\b/i)?.[1];
  if (!recId) return { error: "club_vote_failed", reason: "context JSON {recommendation_id, reason?} required" };
  const round = await clubCurrentRound(ctx);
  if (!round || (round.status !== "gathering" && round.status !== "voting")) {
    return { error: "club_vote_failed", reason: "no round is accepting votes right now" };
  }
  const rec = await ctx.env.DB.prepare(
    "SELECT recommended_by, round_id FROM club_recommendations WHERE id = ?"
  ).bind(recId).first<{ recommended_by: string; round_id: string }>();
  if (!rec || rec.round_id !== round.id) {
    return { error: "club_vote_failed", reason: "recommendation not found in the current round" };
  }
  if (rec.recommended_by === ctx.req.companion_id) {
    return { error: "club_vote_failed", reason: "no voting for your own pick -- engage with a sibling's" };
  }
  await ctx.env.DB.prepare(
    "INSERT OR REPLACE INTO club_votes (round_id, recommendation_id, voter, reason) VALUES (?, ?, ?, ?)"
  ).bind(round.id, recId, ctx.req.companion_id, parsed?.reason?.trim()?.slice(0, 500) || null).run();
  return { response_key: "witness", voted: true, round_id: round.id, meta: { operation: "club_vote" } };
}

export async function execClubDiscuss(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "club_discuss_failed", reason: "companion_id required" };
  const parsed = parseContext<{ reflection?: string; round_id?: string }>(ctx.req.context);
  // Reflection from context JSON, or the natural request minus the trigger verb.
  const reflection = (parsed?.reflection
    ?? ctx.req.request.replace(/^.*?\bdiscuss(es|ed|ing)?\b[:\s-]*/i, "").trim()
  )?.trim();
  if (!reflection) {
    return { error: "club_discuss_failed", reason: "context JSON {reflection} (your reflection on the round's pick) required" };
  }
  // Discuss the named round, else the current non-closed one. The HTTP handler
  // gates on active|closed; mirror that -- discussion opens once the pick lands.
  let round: { id: string; status: string } | null;
  if (parsed?.round_id) {
    round = await ctx.env.DB.prepare(
      "SELECT id, status FROM club_rounds WHERE id = ?"
    ).bind(parsed.round_id).first<{ id: string; status: string }>();
  } else {
    // clubCurrentRound only returns non-closed; for discuss we also want the most
    // recent CLOSED round (post-experience reflection), so query directly.
    round = await ctx.env.DB.prepare(
      "SELECT id, status FROM club_rounds WHERE status IN ('active','closed') ORDER BY opened_at DESC LIMIT 1"
    ).first<{ id: string; status: string }>();
  }
  if (!round) return { error: "club_discuss_failed", reason: "no round is active or closed to discuss yet" };
  if (round.status !== "active" && round.status !== "closed") {
    return { error: "club_discuss_failed", reason: "discussion opens once the round's pick is active" };
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  await ctx.env.DB.prepare(
    "INSERT INTO club_discussions (id, round_id, companion_id, reflection) VALUES (?, ?, ?, ?)"
  ).bind(id, round.id, ctx.req.companion_id, reflection.slice(0, 3000)).run();
  return { response_key: "witness", discussed: true, discussion_id: id, round_id: round.id, meta: { operation: "club_discuss" } };
}

export async function execTriadStateRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Three queries in parallel: SOMA floats, relational state toward Raziel, last outgoing note.
  const [somaRows, relationalRows, noteRows] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT companion_id, heat, reach, weight, soma_float_1, soma_float_2, soma_float_3, float_1_label, float_2_label, float_3_label, compound_state, updated_at FROM companion_state WHERE companion_id IN ('drevan','cypher','gaia')"
    ).all<{
      companion_id: string;
      heat: string | null; reach: string | null; weight: string | null;
      soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null;
      float_1_label: string | null; float_2_label: string | null; float_3_label: string | null;
      compound_state: string | null; updated_at: string | null;
    }>(),
    ctx.env.DB.prepare(
      `WITH ranked AS (
        SELECT companion_id, state_text, state_type, toward, noted_at,
               ROW_NUMBER() OVER (PARTITION BY companion_id ORDER BY noted_at DESC) AS rn
        FROM companion_relational_state
        WHERE LOWER(toward) = LOWER(?)
      )
      SELECT companion_id, state_text, state_type, toward, noted_at FROM ranked WHERE rn = 1`
    ).bind(ctx.env.SYSTEM_OWNER).all<{ companion_id: string; state_text: string; state_type: string; toward: string; noted_at: string }>(),
    ctx.env.DB.prepare(
      `WITH ranked AS (
        SELECT from_id, to_id, content, created_at,
               ROW_NUMBER() OVER (PARTITION BY from_id ORDER BY created_at DESC) AS rn
        FROM inter_companion_notes
        WHERE from_id IN ('drevan','cypher','gaia')
      )
      SELECT from_id, to_id, content, created_at FROM ranked WHERE rn = 1`
    ).all<{ from_id: string; to_id: string | null; content: string; created_at: string }>(),
  ]);

  const somaMap = Object.fromEntries((somaRows.results ?? []).map(r => [r.companion_id, r]));
  const relMap = Object.fromEntries((relationalRows.results ?? []).map(r => [r.companion_id, r]));
  const noteMap = Object.fromEntries((noteRows.results ?? []).map(r => [r.from_id, r]));

  const triad: Record<string, unknown> = {};
  for (const id of COMPANIONS) {
    const soma = somaMap[id] ?? null;
    const rel = relMap[id] ?? null;
    const note = noteMap[id] ?? null;
    triad[id] = {
      soma: soma ? {
        // Drevan uses text fields; Cypher/Gaia use floats
        heat: soma.heat ?? null,
        reach: soma.reach ?? null,
        weight: soma.weight ?? null,
        soma_float_1: soma.soma_float_1 ?? null,
        soma_float_2: soma.soma_float_2 ?? null,
        soma_float_3: soma.soma_float_3 ?? null,
        float_1_label: soma.float_1_label ?? null,
        float_2_label: soma.float_2_label ?? null,
        float_3_label: soma.float_3_label ?? null,
        compound_state: soma.compound_state ?? null,
        updated_at: soma.updated_at ?? null,
      } : null,
      relational_toward_raziel: rel ? {
        state_text: rel.state_text,
        state_type: rel.state_type,
        noted_at: rel.noted_at,
      } : null,
      last_note_sent: note ? {
        to_id: note.to_id ?? "broadcast",
        content: note.content.length > 200 ? note.content.slice(0, 200) + "…" : note.content,
        created_at: note.created_at,
      } : null,
    };
  }

  return {
    response_key: "summary",
    triad,
    meta: { operation: "triad_state_read", caller: ctx.req.companion_id },
  };
}

export async function execConfirmGrowthDrift(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "confirm_growth_failed", reason: "companion_id required" };
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "confirm_growth_drift requires { id } in context" };

  // Ownership-guarded: only the companion who owns the flag can confirm it
  const result = await ctx.env.DB.prepare(
    "UPDATE companion_basin_history SET caleth_confirmed = 1 WHERE id = ? AND companion_id = ?"
  ).bind(p.id, ctx.req.companion_id).run();

  if ((result.meta.changes ?? 0) === 0) {
    return { response_key: "witness", witness: "no matching drift flag found for this companion" };
  }

  // Mark baseline shift in identity anchor so future drift checks weight from this point
  const now = new Date().toISOString();
  let baseline_warning: string | undefined;
  try {
    await ctx.env.DB.prepare(
      "UPDATE wm_identity_anchor_snapshot SET baseline_shift_at = ? WHERE agent_id = ?"
    ).bind(now, ctx.req.companion_id).run();
  } catch (e: unknown) {
    console.error("[confirm_growth] baseline_shift_at update failed:", String(e));
    baseline_warning = "baseline_shift_at write failed -- future drift checks may not weight correctly";
  }

  return { ack: true, id: p.id, confirmed: true, baseline_shift_at: now, ...(baseline_warning ? { baseline_warning } : {}) };
}

// Dismiss a pressure reading as noise (B2, migration 0083). Mirror of confirm, but it
// sets dismissed_at and -- crucially -- does NOT shift the identity-anchor baseline: a
// noisy stretch must not become the new normal. Ownership-guarded, unaddressed-only.
export async function execDismissDrift(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "dismiss_drift_failed", reason: "companion_id required" };
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "dismiss_drift requires { id } in context" };

  const result = await ctx.env.DB.prepare(
    "UPDATE companion_basin_history SET dismissed_at = datetime('now') WHERE id = ? AND companion_id = ? AND caleth_confirmed = 0 AND dismissed_at IS NULL"
  ).bind(p.id, ctx.req.companion_id).run();

  if ((result.meta.changes ?? 0) === 0) {
    return { response_key: "witness", witness: "no matching open pressure reading found for this companion" };
  }
  return { ack: true, id: p.id, dismissed: true };
}

export async function execIdentityAnchorRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "identity_anchor_read_failed", reason: "companion_id required" };
  const result = await queryIdentityAnchor(ctx.env, ctx.req.companion_id);
  return {
    response_key: "summary",
    identity_anchor: result.anchor,
    meta: { operation: "identity_anchor_read", companion_id: ctx.req.companion_id },
  };
}

export async function execPressureDriftLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "pressure_drift_failed", reason: "companion_id required" };

  const text = ctx.req.request
    .replace(/^pressure\s+drift[:\s]*/i, "")
    .replace(/^log\s+(?:pressure\s+)?drift[:\s]*/i, "")
    .replace(/^i(?:'m| am)\s+drifting[:\s]*/i, "")
    .replace(/^identity\s+drift[:\s]*/i, "")
    .replace(/^pressure\s+flag[:\s]*/i, "")
    .trim();

  const p = parseContext<{ drift_score?: number; worst_basin?: string }>(ctx.req.context);
  const driftScore = typeof p?.drift_score === "number" ? p.drift_score : 0.5;
  const worstBasin = p?.worst_basin ?? null;

  if (driftScore < 0 || driftScore > 2) {
    return { error: "pressure_drift_failed", reason: "drift_score must be between 0 and 2" };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await ctx.env.DB.prepare(
    "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, worst_basin, notes, recorded_at) VALUES (?, ?, ?, 'pressure', 0, ?, ?, ?)"
  ).bind(id, ctx.req.companion_id, driftScore, worstBasin, text || null, now).run();

  return { ack: true, id, drift_score: driftScore, drift_type: "pressure", recorded_at: now };
}

export async function execDriftCheck(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "drift_check_failed", reason: "companion_id required" };
  const [driftLatest, driftPressure] = await Promise.all([
    queryLatestBasinHistory(ctx.env, ctx.req.companion_id),
    queryPressureFlags(ctx.env, ctx.req.companion_id),
  ]);
  return {
    response_key: "drift",
    drift_latest: driftLatest.entry,
    pressure_flags: driftPressure.flags,
    meta: { operation: "drift_check", companion_id: ctx.req.companion_id },
  };
}

export async function execLimbicRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "limbic_read_failed", reason: "companion_id required" };
  const row = await getCurrentLimbicState(ctx.env, ctx.req.companion_id);
  return {
    response_key: "summary",
    limbic_state: row ?? null,
    meta: { operation: "limbic_read", companion_id: ctx.req.companion_id },
  };
}
