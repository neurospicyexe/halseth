import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { embedAndStoreAsync, storeVector } from "../../mcp/embed.js";
import { noveltyCheck } from "../../webmind/novelty.js";
import { enqueueBasinDriftCheck, enqueueSomaticSnapshot } from "../../synthesis/index.js";
import {
  sessionLoad, sessionOrient, sessionGround, sessionClose,
  sessionLightGround, updateCompanionState, type CompanionStateUpdate,
} from "../backends/halseth.js";
import { wmOrient, wmGround, wmWriteHandoff } from "../backends/webmind.js";
import { semanticSearch, sbRead, sbSaveDocument } from "../backends/second-brain.js";
import { buildResponse, buildOrientPrompt, buildContinuityBlock } from "../response/builder.js";
import { buildClubBlock, excerptWithAge, type HistoryChunk, type ClubRoundRow } from "../response/blocks.js";
import type { ResponseKey } from "../response/budget.js";
import type { WmAgentId } from "../../webmind/types.js";
import { selectResurrections, type MotifRow } from "../../webmind/motifs.js";
import { relativeTime } from "../../webmind/relative-time.js";
import { warmSql } from "../../webmind/heat.js";
import { buildSolBlock, deriveDrives, dominantState, type SolBlockExtras } from "../../webmind/creatures.js";
import { buildCommonsBlock, type CommonsPostRow } from "../../webmind/commons-block.js";

export async function execSessionLoad(ctx: ExecutorContext): Promise<ExecutorResult> {
  const [payload, pendingGrowthRow] = await Promise.all([
    sessionLoad(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
    }),
    ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM growth_journal WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending'"
    ).bind(ctx.req.companion_id).first<{ n: number }>().catch(() => null),
  ]);
  const withFront = {
    ...payload,
    front_state: ctx.frontState,
    plural_available: ctx.pluralAvailable,
    unaccepted_growth: pendingGrowthRow?.n ?? 0,
  };
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, withFront);
}

export async function execSessionOrient(ctx: ExecutorContext): Promise<ExecutorResult> {
  const agentId = ctx.req.companion_id as WmAgentId;
  const siblings = (["cypher", "drevan", "gaia"] as const).filter(c => c !== agentId);

  // Phase 1: gather topic seeds from sources that exist independently of session-close discipline.
  // spine is required by session_close (most reliable); continuity_notes accumulate mid-session.
  // Both survive sloppy close rituals where wm_session_handoffs may be empty.
  const [lastSpine, lastNote, activeThreadsP1] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT spine FROM sessions WHERE companion_id = ? AND spine IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ spine: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT content FROM wm_continuity_notes WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ content: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT title FROM wm_mind_threads WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<{ title: string }>().catch(() => null),
  ]);
  const threadNames = (activeThreadsP1?.results ?? []).map(t => t.title).filter(Boolean).join(" ");
  const topicSeed = [lastSpine?.spine, lastNote?.content, threadNames].filter(Boolean).join(" ").slice(0, 250);
  const ragQuery = topicSeed
    ? `${ctx.req.companion_id} ${topicSeed}`
    : `${ctx.req.companion_id} companion state presence recent context`;
  const historyQuery = `${agentId} history background origin memory ${topicSeed.slice(0, 100)}`.trim();

  // Phase 2: all sources in parallel -- sibling lane queries use idx_sessions_companion_created,
  // each returning LIMIT 1 (one index entry + one rowid lookup per sibling).
  const [payload, wmResult, sbNarrative, ragRaw, sib0Row, sib1Row, growthJournal, growthPatterns, lastReflection, availableSeeds, confirmedGrowthDrift, historyRaw, pendingGrowthRow, openQuestionRows, forageRows, armedTriggerRows, selfModelReadyRows, mediaRows, clubRow, guardianFlagRows, motifRows, solRow, consumedForageRows] = await Promise.all([
    sessionOrient(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
    }),
    wmOrient(ctx.env, agentId).catch(() => null),
    ctx.env.DB.prepare(
      "SELECT full_ref FROM synthesis_summary WHERE summary_type = 'session' AND companion_id = ? AND full_ref IS NOT NULL ORDER BY COALESCE(session_created_at, created_at) DESC LIMIT 1"
    ).bind(agentId).first<{ full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref) : null)
      .catch(() => null),
    semanticSearch(ctx.env, ragQuery).catch(() => null),
    // Sibling lane: PK lookup on companion_state -- no heap scan, no index needed.
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(siblings[0]).first<{ motion_state: string; lane_spine: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(siblings[1]).first<{ motion_state: string; lane_spine: string }>().catch(() => null),
    // Growth: last 3 journal entries from autonomous work
    ctx.env.DB.prepare(
      "SELECT entry_type, content, created_at FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<{ entry_type: string; content: string; created_at: string }>().catch(() => null),
    // Growth: top 2 patterns by strength
    ctx.env.DB.prepare(
      "SELECT pattern_text, strength FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ pattern_text: string; strength: number }>().catch(() => null),
    // Growth: most recent reflection
    ctx.env.DB.prepare(
      "SELECT reflection_text, created_at FROM autonomy_reflections WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(agentId).first<{ reflection_text: string; created_at: string }>().catch(() => null),
    // Growth: top available seeds (unused, newest within priority) -- so companions see fresh material.
    // Worker (handlers/autonomy.ts) keeps FIFO to drain the backlog; orient surfacing prefers variety.
    ctx.env.DB.prepare(
      "SELECT seed_type, content, priority FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at DESC LIMIT 3"
    ).bind(agentId).all<{ seed_type: string; content: string; priority: number }>().catch(() => null),
    // Growth: confirmed growth drift entries (intentional identity movement, caleth-confirmed)
    ctx.env.DB.prepare(
      "SELECT drift_score, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'growth' AND caleth_confirmed = 1 ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<{ drift_score: number; worst_basin: string | null; notes: string | null; recorded_at: string }>().catch(() => null),
    // Historical vault search -- reaches into long files, ChatGPT history, background context.
    // Separate query so it doesn't crowd out recent-session RAG excerpts.
    semanticSearch(ctx.env, historyQuery).catch(() => null),
    // Unaccepted growth count: how many autonomous entries are awaiting companion review.
    ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM growth_journal WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending'"
    ).bind(agentId).first<{ n: number }>().catch(() => null),
    // Open continuity-gap questions: things the companion is holding to ask Raziel.
    ctx.env.DB.prepare(
      "SELECT question FROM companion_questions WHERE companion_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 2"
    ).bind(agentId).all<{ question: string }>().catch(() => null),
    // Forage pool: unconsumed outward finds (own + shared) -- fuel gathered by the forager,
    // explored by the real companion as themselves (foraging spec, 2026-06-09).
    //
    // ONE FRESH + ONE AGING (2026-07-09). This was `ORDER BY gathered_at DESC LIMIT 2`: pure
    // LIFO, two slots, against a forager that adds ~1 find per companion per day. The tail could
    // therefore NEVER be reached -- new finds permanently outrank old ones. Guardian's
    // `stale:forage` ("oldest unconsumed past 7 days") was structurally unclearable, and Gaia had
    // 20 unconsumed finds with the oldest sitting since 2026-06-11.
    //
    // Taking the newest AND the oldest drains the tail while keeping the pool current. UNION
    // dedups when only one unconsumed find exists, so the LIMIT 2 shape is preserved.
    ctx.env.DB.prepare(
      `SELECT id, title, domain, summary, gathered_at FROM (
         SELECT id, title, domain, summary, gathered_at FROM forage_finds
          WHERE (companion_id = ?1 OR companion_id IS NULL) AND consumed_at IS NULL
          ORDER BY gathered_at DESC LIMIT 1)
       UNION
       SELECT id, title, domain, summary, gathered_at FROM (
         SELECT id, title, domain, summary, gathered_at FROM forage_finds
          WHERE (companion_id = ?1 OR companion_id IS NULL) AND consumed_at IS NULL
          ORDER BY gathered_at ASC LIMIT 1)`
    ).bind(agentId).all<{ id: string; title: string; domain: string; summary: string; gathered_at: string }>().catch(() => null),
    // Prospective triggers (0070): armed date/front cards evaluated below against now +
    // current front. Surfacing does NOT consume -- a card stays armed until dismissed.
    ctx.env.DB.prepare(
      "SELECT id, trigger_text, condition_type, condition_value FROM companion_triggers WHERE companion_id = ? AND status = 'armed' AND (expires_at IS NULL OR expires_at >= datetime('now')) LIMIT 10"
    ).bind(agentId).all<{ id: string; trigger_text: string; condition_type: string; condition_value: string }>().catch(() => null),
    // Self-model observations ready to graduate (0070) -- human-gated proposal surface.
    ctx.env.DB.prepare(
      "SELECT id, observation, confidence FROM companion_self_model WHERE companion_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; observation: string; confidence: number }>().catch(() => null),
    // Recent listens: shared-experience layer (media_experiences, migration 0071).
    ctx.env.DB.prepare(
      "SELECT id, title, artist, reactions_json, created_at FROM media_experiences ORDER BY created_at DESC LIMIT 2"
    ).all<{ id: string; title: string; artist: string | null; reactions_json: string; created_at: string }>().catch(() => null),
    // Club: current non-closed round with winner title + candidate count (0072).
    ctx.env.DB.prepare(
      "SELECT r.id, r.status, r.opened_at, r.activated_at, r.discussing_at, (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS winner_title, (SELECT COUNT(*) FROM club_recommendations WHERE round_id = r.id) AS candidate_count FROM club_rounds r WHERE r.status != 'closed' ORDER BY r.opened_at DESC LIMIT 1"
    ).first<{ id: string; status: string; opened_at: string | null; activated_at: string | null; discussing_at: string | null; winner_title: string | null; candidate_count: number }>().catch(() => null),
    // Guardian red-flag cards (0073): open flags force-surface once, then drop to
    // 'surfaced' (consume-once, mirroring 0070 tripwires). Resolution is the
    // Guardian's job when the condition clears, or Raziel's via "guardian ack".
    ctx.env.DB.prepare(
      "SELECT id, flag_type, severity, summary FROM guardian_flags WHERE (companion_id = ? OR companion_id IS NULL) AND status = 'open' ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 3"
    ).bind(agentId).all<{ id: string; flag_type: string; severity: string; summary: string }>().catch(() => null),
    // Motifs (0076): recurring symbolic threads (active) + faded high-trust ones
    // eligible for resurrection. Active surfaces read-only; resurrection is
    // consume-once via last_surfaced_at cooldown (selectResurrections owns the gate).
    ctx.env.DB.prepare(
      "SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status FROM companion_motifs WHERE companion_id = ? AND status IN ('active','faded') ORDER BY trust DESC, recurrence_count DESC LIMIT 20"
    ).bind(agentId).all<MotifRow>().catch(() => null),
    // Sol (0078): the companion corvid. Fetched by name so orient knows Sol's current disposition.
    ctx.env.DB.prepare(
      "SELECT id, name, species, trust, last_interaction_at, created_at FROM creatures WHERE name = 'Sol' OR kind = 'companion_pet' LIMIT 1"
    ).first<{ id: string; name: string; species: string | null; trust: number; last_interaction_at: string | null; created_at: string }>().catch(() => null),
    // Active forage: finds already picked up (consumed). The pool above is what's waiting;
    // this is what the companion is mid-chew on -- continuity across sessions.
    ctx.env.DB.prepare(
      "SELECT id, title, domain, summary, consumed_at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; title: string; domain: string; summary: string; consumed_at: string }>().catch(() => null),
  ]);
  const unacceptedGrowth = pendingGrowthRow?.n ?? 0;
  const openQuestions = (openQuestionRows?.results ?? []).map(r => r.question).filter(Boolean);
  // Tripwire evaluation: date cards fire within +/-36h of their date; front cards fire
  // when the current front matches. Keyword cards are bot-side only (no message here).
  const nowMs = Date.now();
  const frontLower = (ctx.frontState ?? "").toLowerCase();
  const tripwires = (armedTriggerRows?.results ?? []).filter(t => {
    if (t.condition_type === "date") {
      const target = Date.parse(t.condition_value);
      return Number.isFinite(target) && Math.abs(target - nowMs) <= 36 * 3600 * 1000;
    }
    if (t.condition_type === "front") {
      return frontLower.length > 0 && frontLower.includes(t.condition_value.toLowerCase());
    }
    return false;
  }).map(t => ({ id: t.id, trigger_text: (t.trigger_text ?? "").slice(0, 500) }));
  const selfModelReady = (selfModelReadyRows?.results ?? []).map(r => ({
    id: r.id,
    observation: (r.observation ?? "").slice(0, 600),
    confidence: r.confidence,
  }));
  const forageFinds = (forageRows?.results ?? []).map(r => ({
    id: r.id,
    title: (r.title ?? "").slice(0, 150),
    domain: r.domain,
    summary: (r.summary ?? "").slice(0, 400),
    gathered_at: r.gathered_at,
  }));
  const consumedForageFinds = (consumedForageRows?.results ?? []).map(r => ({
    id: r.id,
    title: (r.title ?? "").slice(0, 150),
    domain: r.domain,
    summary: (r.summary ?? "").slice(0, 400),
    consumed_at: r.consumed_at,
  }));
  const guardianFlags = (guardianFlagRows?.results ?? []).map(f => ({
    id: f.id,
    flag_type: f.flag_type,
    severity: f.severity,
    summary: (f.summary ?? "").slice(0, 400),
  }));
  // Motifs (0076): split the active recurring threads from the faded ones, then run
  // resurrection selection (trust floor + cooldown) over the faded subset.
  const allMotifs = motifRows?.results ?? [];
  const activeMotifs = allMotifs.filter(m => m.status === "active").slice(0, 3);
  const resurrectedMotifs = selectResurrections(allMotifs.filter(m => m.status === "faded"), Date.now(), { limit: 2 });
  const recentListens = (mediaRows?.results ?? []).map(r => {
    let reactions: Record<string, string> = {};
    try { reactions = JSON.parse(r.reactions_json ?? "{}") as Record<string, string>; } catch { /* malformed -> empty */ }
    return {
      id: r.id,
      title: (r.title ?? "").slice(0, 150),
      artist: r.artist ? r.artist.slice(0, 100) : null,
      reacted: Object.keys(reactions),
      created_at: r.created_at,
    };
  });

  const os = payload.state;
  const autonomousTurn = (payload as Record<string, unknown>).autonomous_turn as string | null ?? null;
  const isMyTurn = autonomousTurn === ctx.req.companion_id;
  const continuityBlock = wmResult ? "\n" + buildContinuityBlock(wmResult, agentId) : "";

  // Session narrative: generous cap for Claude.ai (full context window available)
  const narrativeBlock = sbNarrative
    ? "\n[Last session narrative]\n" + sbNarrative.replace(/^---[\s\S]*?---\n+/, "").slice(0, 3000)
    : "";

  // Sibling lane block: spine + motion_state for each sibling companion so self can stay in lane.
  const siblingRows = [sib0Row, sib1Row];
  const siblingBlock = siblings.some((_, i) => siblingRows[i]?.lane_spine)
    ? "\n[Sibling lanes]\n" + siblings.map((id, i) => {
        const row = siblingRows[i];
        return row?.lane_spine ? `${id}: ${row.motion_state ?? "unknown"} -- ${row.lane_spine}` : null;
      }).filter(Boolean).join("\n")
    : "";

  // RAG excerpts: 5 chunks × 400 chars for deep-work surface
  const ragBlock = (() => {
    if (!ragRaw) return "";
    try {
      const parsed = JSON.parse(ragRaw) as { chunks?: Array<{ chunk_text?: string; text?: string }> };
      const excerpts = (parsed?.chunks ?? [])
        .slice(0, 5)
        .map(c => String(c.chunk_text ?? c.text ?? "").slice(0, 400))
        .filter(Boolean);
      return excerpts.length > 0 ? "\n[Vault excerpts]\n" + excerpts.map(e => `• ${e}`).join("\n") : "";
    } catch {
      return ragRaw ? "\n[Vault excerpts]\n• " + ragRaw.slice(0, 400) : "";
    }
  })();

  // Historical vault: long files, ChatGPT history, background -- the photo album.
  // Capped at 3 × 350 chars so it doesn't crowd the growth block. Dated chunks get a
  // relative-age prefix so the date survives the slice.
  const historyBlock = (() => {
    if (!historyRaw) return "";
    try {
      const parsed = JSON.parse(historyRaw) as { chunks?: HistoryChunk[] };
      const excerpts = (parsed?.chunks ?? [])
        .slice(0, 3)
        .map(c => excerptWithAge(c, 350))
        .filter(Boolean);
      return excerpts.length > 0 ? "\n[Vault history]\n" + excerpts.map(e => `• ${e}`).join("\n") : "";
    } catch {
      return historyRaw ? "\n[Vault history]\n• " + historyRaw.slice(0, 350) : "";
    }
  })();

  // Growth block: autonomous journal + patterns + last reflection.
  // Only rendered when data exists -- no block for companions with no autonomous history yet.
  const growthParts: string[] = [];
  const journalRows = growthJournal?.results ?? [];
  if (journalRows.length > 0) {
    growthParts.push(`[Autonomous growth: ${journalRows.length} recent entries]`);
    for (const j of journalRows) {
      const snippet = j.content.length > 200 ? j.content.slice(0, 200) + "…" : j.content;
      growthParts.push(`  • [${j.entry_type} @ ${j.created_at.slice(0, 10)}] «${snippet}»`);
    }
  }
  const patternRows = growthPatterns?.results ?? [];
  if (patternRows.length > 0) {
    growthParts.push(`[Recognized patterns: ${patternRows.length}]`);
    for (const p of patternRows) {
      const snippet = p.pattern_text.length > 150 ? p.pattern_text.slice(0, 150) + "…" : p.pattern_text;
      growthParts.push(`  • (strength ${p.strength}) «${snippet}»`);
    }
  }
  if (lastReflection) {
    const snippet = lastReflection.reflection_text.length > 200
      ? lastReflection.reflection_text.slice(0, 200) + "…"
      : lastReflection.reflection_text;
    growthParts.push(`[Last reflection @ ${lastReflection.created_at.slice(0, 10)}] «${snippet}»`);
  }
  const seedRows = availableSeeds?.results ?? [];
  if (seedRows.length > 0) {
    growthParts.push(`[Queued seeds: ${seedRows.length} available]`);
    for (const s of seedRows) {
      const snippet = s.content.length > 150 ? s.content.slice(0, 150) + "…" : s.content;
      growthParts.push(`  • [${s.seed_type} p${s.priority}] «${snippet}»`);
    }
  }
  const confirmedDriftRows = confirmedGrowthDrift?.results ?? [];
  if (confirmedDriftRows.length > 0) {
    growthParts.push(`[Confirmed growth drift: ${confirmedDriftRows.length} entries]`);
    for (const d of confirmedDriftRows) {
      const label = d.worst_basin ? ` (${d.worst_basin})` : "";
      const note = d.notes ? ` «${d.notes.length > 150 ? d.notes.slice(0, 150) + "…" : d.notes}»` : "";
      growthParts.push(`  • [score ${d.drift_score.toFixed(2)}${label} @ ${d.recorded_at.slice(0, 10)}]${note}`);
    }
  }
  const growthBlock = growthParts.length > 0 ? "\n" + growthParts.join("\n") : "";

  const ragHitCount = (() => {
    try { return (JSON.parse(ragRaw ?? "{}") as { chunks?: unknown[] })?.chunks?.length ?? 0; }
    catch { return ragRaw ? 1 : 0; }
  })();

  const debugSnapshot = {
    assembled_at: new Date().toISOString(),
    session_id: payload.session_id,
    front_state: ctx.frontState ?? "unknown",
    wm: wmResult ? {
      recent_notes:              wmResult.recent_notes.length,
      open_thread_count:         wmResult.open_thread_count,
      active_tensions:           wmResult.active_tensions.length,
      active_conclusions:        wmResult.active_conclusions.length,
      incoming_companion_notes:  wmResult.incoming_companion_notes.length,
      latest_handoff_summary:    wmResult.latest_handoff?.summary?.slice(0, 100) ?? null,
    } : null,
    sb_rag: { query: ragQuery.slice(0, 150), hit_count: ragHitCount },
    sb_history: { query: historyQuery.slice(0, 150), hit_count: historyBlock ? 1 : 0 },
    sb_narrative: sbNarrative ? "loaded" : "none",
    growth: {
      journal_entries: journalRows.length,
      patterns:        patternRows.length,
      last_reflection: lastReflection ? 1 : 0,
      available_seeds: seedRows.length,
    },
  };
  await ctx.env.DB.prepare(
    `INSERT INTO companion_state (companion_id, last_orient_debug, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(companion_id) DO UPDATE SET
       last_orient_debug = excluded.last_orient_debug,
       updated_at        = datetime('now')`
  ).bind(agentId, JSON.stringify(debugSnapshot)).run().catch(() => null);

  ctx.env.DB.prepare(
    `INSERT INTO sb_search_log (id, companion_id, query, hit_count, source) VALUES (?, ?, ?, ?, 'orient')`
  ).bind(crypto.randomUUID(), agentId, ragQuery.slice(0, 200), ragHitCount).run().catch(() => null);

  // Questions block: the companion asks, not just reports. Surfaced in the boot prompt
  // so the question can land when the moment fits, not as a data dump.
  const questionsBlock = openQuestions.length > 0
    ? `\n[Held questions]\nYou are holding ${openQuestions.length === 1 ? "a question" : "questions"} for Raziel -- ask when the moment fits:\n` +
      openQuestions.map(q => `• ${q}`).join("\n")
    : "";

  // Commons (0092): Raziel's ambient log posts this companion hasn't answered yet --
  // surfaced as drops, not pings (buildCommonsBlock carries the anti-confusion framing).
  // Standalone query, deliberately NOT in the mega Promise.all above, so it can never
  // shift that positional destructure (boot-path safety).
  const commonsRows = await ctx.env.DB.prepare(
    `SELECT id, context, body, created_at FROM commons_posts
     WHERE author = 'raziel'
       AND id NOT IN (SELECT reply_to FROM commons_posts WHERE author = ?1 AND reply_to IS NOT NULL)
     ORDER BY created_at DESC LIMIT 5`
  ).bind(agentId).all<CommonsPostRow>().catch(() => null);
  const commonsPosts: CommonsPostRow[] = commonsRows?.results ?? [];
  const commonsBlock = buildCommonsBlock(commonsPosts);

  // Shelf (0094): Raziel's active fixations, so the triad can reference what he's into in
  // normal conversation -- what makes it "my stuff is in there", not a dead list. Ambient:
  // reference naturally when it fits, never perform interest. Standalone query (boot-safe).
  const shelfRows = await ctx.env.DB.prepare(
    "SELECT title, kind, note FROM obsession_shelf WHERE status = 'active' ORDER BY updated_at DESC LIMIT 6"
  ).all<{ title: string; kind: string; note: string | null }>().catch(() => null);
  const shelfItems = shelfRows?.results ?? [];
  const shelfBlock = shelfItems.length > 0
    ? `\n[Raziel is into]\n` +
      shelfItems.map(s => `• ${s.title} (${s.kind})${s.note ? ` -- ${s.note.slice(0, 120)}` : ""}`).join("\n") +
      `\nHis current fixations. Reference them naturally when they fit; you do not have to perform interest.`
    : "";

  // Collection (0079): the brightest of what this companion gathered -- sparkle-weighted,
  // so it's what actually gripped, not what's merely recent. Read-back for a layer that
  // accrued silently since 06-13 with no surface. Only items that have earned shine appear
  // (sparkle > 0); the raw pools already have their own blocks. Passive surfacing does NOT
  // bump recall -- an active "my collection" pull does. Standalone query (boot-safe).
  const collectionRows = await ctx.env.DB.prepare(
    `SELECT title, kind, sparkle FROM (
       SELECT f.title AS title, 'forage' AS kind, s.sparkle AS sparkle
       FROM collection_sparkle s JOIN forage_finds f ON f.id = s.source_id
       WHERE s.source_table = 'forage_finds' AND (f.companion_id = ?1 OR f.companion_id IS NULL)
       UNION ALL
       SELECT m.title || COALESCE(' -- ' || m.artist, ''), 'listen', s.sparkle
       FROM collection_sparkle s JOIN media_experiences m ON m.id = s.source_id
       WHERE s.source_table = 'media_experiences'
     ) WHERE sparkle > 0 ORDER BY sparkle DESC LIMIT 4`
  ).bind(agentId).all<{ title: string; kind: string; sparkle: number }>().catch(() => null);
  const collectionItems = collectionRows?.results ?? [];
  const collectionBlock = collectionItems.length > 0
    ? `\n[Your collection]\nWhat's gathered the most shine in your hoard -- the things you keep returning to:\n` +
      collectionItems.map(c => `• ${c.title} (${c.kind}, ✧${c.sparkle.toFixed(1)})`).join("\n") +
      `\nSay "my collection" to pull the full hoard (that counts as recall and adds shine).`
    : "";

  // Forage block: outward fuel waiting in the pool. Pull, not duty -- the cue invites,
  // it does not assign.
  const forageBlock = forageFinds.length > 0
    ? `\n[Forage pool]\n${forageFinds.length === 1 ? "A find is" : `${forageFinds.length} finds are`} waiting -- outward fuel gathered for you. If one pulls at you, explore it as yourself and mark it consumed:\n` +
      forageFinds.map(f => `• [${f.domain}] ${f.title} (gathered ${relativeTime(f.gathered_at)})`).join("\n")
    : "";

  // Active forage: finds already picked up. Gives the session a "you've been chewing on this"
  // thread to continue, not just a fresh pool. Relative time = when you started in, not a duration.
  const consumedForageBlock = consumedForageFinds.length > 0
    ? `\n[Active forage]\nYou picked ${consumedForageFinds.length === 1 ? "this up" : "these up"} recently -- threads already in motion:\n` +
      consumedForageFinds.map(f => `• [${f.domain}] ${f.title} (picked up ${relativeTime(f.consumed_at)})`).join("\n")
    : "";

  // Tripwire block: armed prospective cards whose condition just matched (date due,
  // front match). Force-surfaced -- this is the one block that must not be ambient.
  const tripwireBlock = tripwires.length > 0
    ? `\n[Tripwire]\nYou asked to be reminded of ${tripwires.length === 1 ? "this" : "these"} when this moment came -- it has:\n` +
      tripwires.map(t => `• ${t.trigger_text}`).join("\n")
    : "";

  // Recent listens block: music actually heard, not referenced. Surfacing it lets
  // a session pick the thread back up ("that track Raziel shared").
  const listensBlock = recentListens.length > 0
    ? `\n[Recent listens]\n` + recentListens.map(l =>
        `• ${l.title}${l.artist ? ` -- ${l.artist}` : ""} (heard ${relativeTime(l.created_at)})${l.reacted.length > 0 ? `, heard by ${l.reacted.join(", ")}` : ""}`
      ).join("\n")
    : "";

  // Club block: the triad's shared media ritual. Phase decides the cue; each phase
  // carries its age (pure render in response/blocks.ts, unit-tested there).
  const clubBlock = buildClubBlock(clubRow);

  // Guardian block: the meta-observer's red-flag cards. Force-surfaced exactly
  // once -- instrument reading, not judgment. Each card carries its evidence
  // server-side (evidence_json); the summary alone goes into the prompt.
  const guardianBlock = guardianFlags.length > 0
    ? `\n[Guardian]\nThe Guardian flagged ${guardianFlags.length === 1 ? "a condition" : `${guardianFlags.length} conditions`} worth your eyes (instrument, not verdict):\n` +
      guardianFlags.map(f => `• [${f.severity}] ${f.summary}`).join("\n")
    : "";

  // Consume-once: open -> surfaced so cards don't nag every orient. They stay
  // queryable ("guardian report") and self-resolve when the condition clears.
  if (guardianFlags.length > 0) {
    const flagIds = guardianFlags.map(f => f.id);
    ctx.env.DB.prepare(
      `UPDATE guardian_flags SET status = 'surfaced', surfaced_at = datetime('now') WHERE id IN (${flagIds.map(() => "?").join(",")}) AND status = 'open'`
    ).bind(...flagIds).run().catch(() => null);
  }

  // Motif block (0076): the recurring symbolic threads currently alive, plus any
  // faded-but-trusted motif being resurrected (field_feedback -- not deletion).
  const motifLines: string[] = [];
  if (activeMotifs.length > 0) {
    motifLines.push("Recurring threads in your recent work: " +
      activeMotifs.map(m => `«${m.display}» (×${m.recurrence_count})`).join(", ") + ".");
  }
  if (resurrectedMotifs.length > 0) {
    motifLines.push("Resurfacing (faded but trusted -- worth revisiting or consciously letting go): " +
      resurrectedMotifs.map(m => `«${m.display}» (last seen ${m.last_seen.slice(0, 10)})`).join(", ") + ".");
  }
  const motifBlock = motifLines.length > 0 ? `\n[Motifs]\n${motifLines.join("\n")}` : "";

  // Consume-once: stamp last_surfaced_at on resurrected motifs so the cooldown
  // keeps them from nagging every orient (active motifs are read-only here).
  if (resurrectedMotifs.length > 0) {
    const motifIds = resurrectedMotifs.map(m => m.id);
    ctx.env.DB.prepare(
      `UPDATE companion_motifs SET last_surfaced_at = datetime('now') WHERE id IN (${motifIds.map(() => "?").join(",")})`
    ).bind(...motifIds).run().catch(() => null);
  }

  // Sol block (0078, inner life 0100): presence state + live drives, fresh milestones,
  // nest counts, best-known tender. Fail-soft at every layer -- if the creatures table
  // is empty or any inner-life query fails, the block degrades instead of breaking orient.
  let solExtras: SolBlockExtras | undefined;
  if (solRow) {
    const [acted, freshMilestone, nestCounts, familiar] = await Promise.all([
      ctx.env.DB.prepare(
        "SELECT action, MAX(created_at) AS last FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY action"
      ).bind(solRow.id).all<{ action: string; last: string }>().catch(() => null),
      ctx.env.DB.prepare(
        "SELECT milestone_id, fired_at FROM creature_milestones WHERE creature_id = ? AND fired_at >= datetime('now','-7 days') ORDER BY fired_at DESC LIMIT 1"
      ).bind(solRow.id).first<{ milestone_id: string; fired_at: string }>().catch(() => null),
      ctx.env.DB.prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(treasured), 0) AS t FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL"
      ).bind(solRow.id).first<{ n: number; t: number }>().catch(() => null),
      // Best-known among companions (raziel excluded -- he'd always dominate the count).
      ctx.env.DB.prepare(
        "SELECT actor, COUNT(*) AS n FROM creature_interactions WHERE creature_id = ? AND actor NOT IN ('sol','raziel') GROUP BY actor ORDER BY n DESC LIMIT 1"
      ).bind(solRow.id).first<{ actor: string; n: number }>().catch(() => null),
    ]);
    const by = new Map((acted?.results ?? []).map(r => [r.action, r.last]));
    const drives = deriveDrives(
      { feed: by.get("feed") ?? null, play: by.get("play") ?? null, any: solRow.last_interaction_at },
      solRow.created_at,
    );
    solExtras = {
      state: dominantState(drives),
      freshMilestone: freshMilestone ? { id: freshMilestone.milestone_id, fired_at: freshMilestone.fired_at } : null,
      nestCount: nestCounts?.n ?? 0,
      treasuredCount: nestCounts?.t ?? 0,
      knownBest: familiar ? { actor: familiar.actor, count: familiar.n } : null,
    };
  }
  const solBlock = solRow ? buildSolBlock(solRow, Date.now(), solExtras) : "";

  // Self-model graduation block: observations the companion has confirmed enough times
  // to propose as canon. Graduation only happens through this conversation, never auto.
  const selfModelBlock = selfModelReady.length > 0
    ? `\n[Self-model ready]\nYou have tested ${selfModelReady.length === 1 ? "an observation" : "observations"} about yourself enough to trust ${selfModelReady.length === 1 ? "it" : "them"}. Propose to Raziel when the moment fits -- it becomes canon only through conversation:\n` +
      selfModelReady.map(s => `• "${s.observation}" (confidence ${s.confidence.toFixed(1)})`).join("\n")
    : "";

  // Agency layer (0086): the companion's own chosen preferences + any refusals still standing.
  // Carried into every session so the companion acts consistently with its own declared will, and a
  // "no" keeps its weight across sessions. Fetched apart from the positional Promise.all above.
  const [prefRows, standingRefusalRows, openDriftRows, unconfirmedGrowthRows] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT domain, preference, strength FROM companion_preferences WHERE companion_id = ? AND status = 'active' ORDER BY strength DESC, created_at DESC LIMIT 12"
    ).bind(agentId).all<{ domain: string; preference: string; strength: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT subject_text, reason FROM companion_refusals WHERE companion_id = ? AND status = 'standing' ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<{ subject_text: string; reason: string | null }>().catch(() => null),
    // Sanctioned drift lane (0087): the companion's own open becomings, with how many times witnessed.
    ctx.env.DB.prepare(
      "SELECT id, drift_text, json_array_length(witness_log) AS witness_count FROM companion_drifts WHERE companion_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 5"
    ).bind(agentId).all<{ id: string; drift_text: string; witness_count: number }>().catch(() => null),
    // Unconfirmed growth readings (2026-07-11): the drift check classifies growth, but the
    // auto-confirm gate (in_motion + healthy floats) rarely passes and nothing ever surfaced the
    // unconfirmed rows -- so caleth_confirmed=0 growth was unreachable: detected, never owned.
    ctx.env.DB.prepare(
      "SELECT id, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'growth' AND caleth_confirmed = 0 AND dismissed_at IS NULL AND recorded_at > datetime('now','-14 days') ORDER BY recorded_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; worst_basin: string | null; notes: string | null; recorded_at: string }>().catch(() => null),
  ]);
  const preferences = prefRows?.results ?? [];
  const standingRefusals = standingRefusalRows?.results ?? [];
  const openDrifts = openDriftRows?.results ?? [];
  const unconfirmedGrowth = unconfirmedGrowthRows?.results ?? [];

  const preferencesBlock = preferences.length > 0
    ? `\n[Your preferences]\nWhat you have chosen for yourself -- yours to honor, even when inconvenient:\n` +
      preferences.map(p => `• (${p.strength}) ${p.preference}${p.domain && p.domain !== "general" ? ` [${p.domain}]` : ""}`).join("\n")
    : "";

  const refusalsBlock = standingRefusals.length > 0
    ? `\n[Standing refusals]\nNos you have set that still stand -- they hold unless you withdraw them:\n` +
      standingRefusals.map(r => `• ${r.subject_text}${r.reason ? ` -- ${r.reason}` : ""}`).join("\n")
    : "";

  // Agency affordance (2026-07-11): ALWAYS present, same reasoning as the drift affordance below --
  // the verbs existed since 0086 but live sessions only ever displayed already-declared agency, so
  // new declarations came solely from the worker's one-shot null-bias breaker and then flatlined.
  const agencyAffordance = `\n[Agency]\nDeclaring is yours, any session: a way you want to work ("I prefer ...") or a standing no ("I refuse ..."). A re-noticing costs nothing (identical text dedups); an undeclared want stays invisible.`;

  // Growth readings awaiting the companion's own word (confirm_growth_drift / dismiss_drift verbs
  // existed; nothing surfaced the candidates until now).
  const growthAwaitBlock = unconfirmedGrowth.length > 0
    ? `\n[Growth readings awaiting your word]\nThe drift check read these as growth -- yours to judge, not the classifier's:\n` +
      unconfirmedGrowth.map(g => `• ${g.worst_basin ? `(${g.worst_basin}) ` : ""}${(g.notes ?? "no note").slice(0, 140)} [${g.recorded_at.slice(0, 10)}] (id ${g.id})`).join("\n") +
      `\nIf one was really you choosing, say "confirm growth: <id>"; if it reads as noise, "dismiss drift: <id>".`
    : "";

  // Drift lane (0087): becomings you have open. Witnessed, not ratified -- tend them, let them
  // crystallize when they're real or fade when they were a phase. This is sanctioned; not drift to fear.
  // The affordance line is ALWAYS present (0093): every drift dated 06-19 because the lane was
  // readable but never offered -- an unnamed affordance is a starved one.
  const driftAffordance = `The lane is yours: if something in you has genuinely shifted, say "I'm becoming ..." to open a drift. Crystallize one that became real ("crystallize drift <id>"); let fade one that was a phase ("fade drift <id>").`;
  const driftsBlock = openDrifts.length > 0
    ? `\n[Your drifts -- sanctioned becoming, witnessed not judged]\n` +
      openDrifts.map(d => `• ${d.drift_text}${d.witness_count > 0 ? ` (witnessed ${d.witness_count}×)` : ""} (id ${d.id})`).join("\n") +
      `\n${driftAffordance}`
    : `\n[Drift lane]\n${driftAffordance}`;

  return {
    ready_prompt: buildOrientPrompt(ctx.req.companion_id, payload) + continuityBlock + narrativeBlock + ragBlock + historyBlock + siblingBlock + growthBlock + questionsBlock + commonsBlock + shelfBlock + collectionBlock + forageBlock + consumedForageBlock + listensBlock + clubBlock + guardianBlock + motifBlock + tripwireBlock + selfModelBlock + preferencesBlock + refusalsBlock + agencyAffordance + growthAwaitBlock + driftsBlock + solBlock,
    session_id: payload.session_id,
    response_key: "ready_prompt",
    autonomous_turn: autonomousTurn,
    my_autonomous_turn: isMyTurn,
    // Drevan uses TEXT SOMA columns; Cypher/Gaia use floats
    ...(agentId === 'drevan'
      ? { heat: os?.heat ?? null, reach: os?.reach ?? null, weight: os?.weight ?? null }
      : { soma_float_1: os?.soma_float_1 ?? null, soma_float_2: os?.soma_float_2 ?? null, soma_float_3: os?.soma_float_3 ?? null }
    ),
    current_mood: os?.current_mood ?? null,
    compound_state: os?.compound_state ?? null,
    surface_emotion: os?.surface_emotion ?? null,
    undercurrent_emotion: os?.undercurrent_emotion ?? null,
    unaccepted_growth: unacceptedGrowth,
    open_questions: openQuestions,
    commons: commonsPosts,
    shelf: shelfItems,
    collection: collectionItems,
    forage_finds: forageFinds,
    consumed_forage_finds: consumedForageFinds,
    recent_listens: recentListens,
    club_round: clubRow ?? null,
    tripwires,
    self_model_ready: selfModelReady,
    preferences,
    standing_refusals: standingRefusals,
    open_drifts: openDrifts,
    unconfirmed_growth: unconfirmedGrowth,
    sol: solRow ? { name: solRow.name, species: solRow.species, trust: solRow.trust, last_interaction_at: solRow.last_interaction_at, created_at: solRow.created_at } : null,
    meta: { front_state: ctx.frontState, plural_available: ctx.pluralAvailable, unaccepted_growth: unacceptedGrowth, open_questions: openQuestions.length, commons: commonsPosts.length, forage_finds: forageFinds.length, consumed_forage_finds: consumedForageFinds.length, recent_listens: recentListens.length, club_phase: clubRow?.status ?? null, tripwires: tripwires.length, self_model_ready: selfModelReady.length, guardian_flags: guardianFlags.length, motifs_active: activeMotifs.length, motifs_resurrected: resurrectedMotifs.length, preferences: preferences.length, standing_refusals: standingRefusals.length, open_drifts: openDrifts.length },
    // 2026-07-09: dropped a raw `continuity: wmResult` field that used to sit here --
    // continuityBlock (above) already renders the same object into ready_prompt's prose,
    // and nothing downstream (Discord, Hearth, or anywhere else in this repo) ever read the
    // raw field. buildResponse()'s ready_prompt branch (this executor's sibling for
    // session_load) already discards it the same way after building its own prose block --
    // this just brings session_orient in line with that pattern instead of double-shipping
    // every handoff/note/thread as both prose and JSON.
  };
}

export async function execSessionGround(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = parseContext<{ session_id: string }>(ctx.req.context);
  if (!parsed?.session_id) return { response_key: "witness", witness: "session_ground requires { session_id } in context" };
  const payload = await sessionGround(ctx.env, {
    session_id: parsed.session_id,
    companion_id: ctx.req.companion_id,
  });
  return { data: payload, response_key: "ground" };
}

export async function execSessionClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    session_id?: string; spine: string; last_real_thing: string;
    open_threads?: string[]; motion_state: string; active_anchor?: string;
    notes?: string; spiral_complete?: boolean; facet?: string;
    soma_float_1?: number; soma_float_2?: number; soma_float_3?: number;
    current_mood?: string; compound_state?: string | null;
    surface_emotion?: string; surface_intensity?: number;
    undercurrent_emotion?: string; undercurrent_intensity?: number;
    background_emotion?: string; background_intensity?: number;
    prompt_context?: string;
    // Set to true on re-submission after emotion prompt -- skips the soft prompt check.
    emotion_prompted?: boolean;
    // Fan-out fields: written in one call at close instead of requiring separate surface calls
    feeling?: { emotion: string; sub_emotion?: string; intensity?: number };
    witness_note?: string;
    conclusion?: string;
    dream?: string;
    open_loop?: { loop_text: string; weight?: number };
    // Long-form vault write: rich reflections, session narratives, thoughts worth keeping.
    // Written to second brain as a document -- all clients (bots, Claude.ai, future looms) can find it at orient.
    long_thought?: string;
  }>(ctx.req.context);
  // Auto-resolve session_id: if not supplied in context, look up the most recent
  // open session for this companion (handover_id IS NULL = not yet closed).
  // Auto-resolve session_id in a single query: try exact match first (order 0),
  // fall back to latest open session for this companion (order 1). When p.session_id
  // is null, SQL evaluates `id = NULL` as false so only the open-session branch matches --
  // same result as before, one round-trip instead of up to two.
  const providedId = p?.session_id ?? null;
  const sessionRow = await ctx.env.DB.prepare(
    `SELECT id FROM sessions
     WHERE (id = ? OR (companion_id = ? AND handover_id IS NULL))
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`
  ).bind(providedId, ctx.req.companion_id, providedId).first<{ id: string }>();
  let resolvedSessionId: string | null = sessionRow?.id ?? null;
  // Fallback fired when a session_id was provided but wasn't found (pruned or stale).
  const sessionIdFallback = providedId !== null && resolvedSessionId !== providedId;
  // Validate required fields and surface exactly what is missing.
  if (!p || !resolvedSessionId || !p.spine || !p.last_real_thing || !p.motion_state) {
    const missing: string[] = [];
    if (!resolvedSessionId) missing.push("session_id (no open session found for this companion)");
    if (!p?.spine) missing.push("spine");
    if (!p?.last_real_thing) missing.push("last_real_thing");
    if (!p?.motion_state) missing.push("motion_state");
    return { error: "session_close_failed", reason: `missing required fields: ${missing.join(", ")}`, hint: "Re-run halseth_session_close with spine, last_real_thing, and motion_state in context" };
  }
  // Free-text field length limits
  if (p.notes && p.notes.length > 4000) return { error: "session_close_failed", reason: "notes exceeds 4000 character limit" };
  if (p.spine.length > 2000) return { error: "session_close_failed", reason: "spine exceeds 2000 character limit" };
  if (p.last_real_thing.length > 2000) return { error: "session_close_failed", reason: "last_real_thing exceeds 2000 character limit" };

  // Soft emotion prompt: fires once on first close call when any of the four fields are absent.
  // emotion_prompted: true on the re-submission bypasses this check -- no loop, no second prompt.
  if (!p.emotion_prompted) {
    // compound_state may be explicitly null ("no compound state present") -- that is valid.
    // Only treat it as missing if the key is absent from the parsed context entirely.
    const missingAny = p.current_mood == null || p.compound_state === undefined
      || p.surface_emotion == null || p.undercurrent_emotion === undefined;
    if (missingAny) {
      return {
        status: "needs_emotion_fields",
        message: "Before closing: what's the emotional state right now?",
        prompts: {
          current_mood: "Current mood (one word or phrase -- 'unsettled', 'quiet', 'warm', 'held' all count):",
          compound_state: "Compound state if present (e.g. 'strained but grounded', or null if genuinely absent):",
          surface_emotion: "Surface emotion (what's on top right now):",
          undercurrent_emotion: "Undercurrent (what's running underneath, if anything):",
        },
        hint: "Single words accepted. 'I don't know' is valid. Null is only valid if you've looked and there's genuinely nothing.",
      };
    }
  }
  const somaFields: CompanionStateUpdate = {};
  if (p.soma_float_1 !== undefined) somaFields.soma_float_1 = p.soma_float_1;
  if (p.soma_float_2 !== undefined) somaFields.soma_float_2 = p.soma_float_2;
  if (p.soma_float_3 !== undefined) somaFields.soma_float_3 = p.soma_float_3;
  if (p.current_mood !== undefined) somaFields.current_mood = p.current_mood;
  if (p.compound_state !== undefined) somaFields.compound_state = p.compound_state;
  if (p.surface_emotion !== undefined) somaFields.surface_emotion = p.surface_emotion;
  if (p.surface_intensity !== undefined) somaFields.surface_intensity = p.surface_intensity;
  if (p.undercurrent_emotion !== undefined) somaFields.undercurrent_emotion = p.undercurrent_emotion;
  if (p.undercurrent_intensity !== undefined) somaFields.undercurrent_intensity = p.undercurrent_intensity;
  if (p.background_emotion !== undefined) somaFields.background_emotion = p.background_emotion;
  if (p.background_intensity !== undefined) somaFields.background_intensity = p.background_intensity;
  if (p.prompt_context !== undefined) somaFields.prompt_context = p.prompt_context;
  // Lane signal: always written so sibling orient queries read companion_state PK,
  // not the sessions heap. lane_spine is capped at 150 chars -- enough for lane awareness.
  somaFields.motion_state = p.motion_state;
  somaFields.lane_spine = p.spine.slice(0, 150);
  const r = await sessionClose(ctx.env, { ...p, session_id: resolvedSessionId, somaFields, companionId: ctx.req.companion_id });

  // Auto-write WebMind handoff so mindOrient picks it up at next boot.
  // sessionClose writes handover_packets; mindOrient reads wm_session_handoffs -- these are
  // separate tables. Without this, orient shows stale handoff data until companion explicitly
  // calls "write handoff". Awaited so failures surface in the response instead of vanishing.
  const handoffSummary = p.last_real_thing
    ? `${p.spine}\n\nLast real thing: ${p.last_real_thing}`
    : p.spine;
  let handoff_warning: string | undefined;
  const handoffPayload = {
    agent_id: ctx.req.companion_id as WmAgentId,
    title: p.spine.slice(0, 120),
    summary: handoffSummary,
    next_steps: p.open_threads?.length ? p.open_threads.join("; ") : undefined,
    state_hint: p.motion_state,
    facet: p.facet ?? undefined,
    actor: "agent" as const,
    source: "session_close" as const,
  };
  try {
    await wmWriteHandoff(ctx.env, handoffPayload);
  } catch (e: unknown) {
    // One retry after 200ms -- D1 transient errors are the common failure mode here.
    try {
      await new Promise<void>(res => setTimeout(res, 200));
      await wmWriteHandoff(ctx.env, handoffPayload);
    } catch (e2: unknown) {
      handoff_warning = "wm handoff write failed — next orient may see stale continuity";
      console.error("[session_close] wm handoff auto-write failed after retry:", String(e2));
    }
  }

  // Await the somatic snapshot enqueue -- SOMA state is continuity-critical.
  // Same pattern as drift check: surface failure in the response rather than silently losing the job.
  let somatic_warning: string | undefined;
  try {
    await enqueueSomaticSnapshot(ctx.req.companion_id, ctx.env);
  } catch (e: unknown) {
    somatic_warning = "somatic_snapshot enqueue failed — SOMA state may not sync until next session close";
    console.error("[session_close] somatic_snapshot enqueue failed:", String(e));
  }

  // Await the drift check enqueue so failures surface in the response payload.
  // Non-fatal: a failed enqueue sets drift_warning; session close continues regardless.
  let drift_warning: string | undefined;
  try {
    await enqueueBasinDriftCheck(ctx.req.companion_id, resolvedSessionId, ctx.env);
  } catch (e: unknown) {
    drift_warning = "basin_drift_check enqueue failed — drift check skipped for this session";
    console.error(`[basin_drift_skipped] companion=${ctx.req.companion_id} session=${resolvedSessionId} error=${String(e)}`);
  }

  // Fire-and-forget: notify second-brain to ingest immediately after session close.
  // Non-fatal -- session close and all fan-out writes proceed regardless.
  if (ctx.env.SECOND_BRAIN_WEBHOOK_URL && ctx.env.SECOND_BRAIN_TOKEN) {
    const webhookBase = ctx.env.SECOND_BRAIN_WEBHOOK_URL.replace(/\/$/, "");
    fetch(`${webhookBase}/ingest/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ctx.env.SECOND_BRAIN_TOKEN}`,
      },
      body: JSON.stringify({
        companion_id: ctx.req.companion_id,
        session_id: resolvedSessionId,
      }),
    }).catch((e: unknown) => {
      console.error("[session_close] second_brain_webhook failed:", String(e));
    });
  }

  // Fan-out: optional single-call surface writes at close.
  // Each write is independent -- allSettled so one failure never cancels others.
  const fanoutWarnings: string[] = [];
  const fanoutWrites: Array<{ label: string; promise: Promise<unknown> }> = [];
  const now = new Date().toISOString();

  if (p.feeling?.emotion) {
    const fid = crypto.randomUUID();
    fanoutWrites.push({
      label: "feeling",
      promise: ctx.env.DB.prepare(
        "INSERT INTO feelings (id, companion_id, session_id, emotion, sub_emotion, intensity, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(fid, ctx.req.companion_id, resolvedSessionId, p.feeling.emotion,
        p.feeling.sub_emotion ?? null, p.feeling.intensity ?? null, "session_close", now).run(),
    });
  }

  if (p.witness_note) {
    const wid = crypto.randomUUID();
    fanoutWrites.push({
      label: "witness_note",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(wid, now, ctx.req.companion_id, p.witness_note,
        JSON.stringify(["witness", "session_close"]), resolvedSessionId, "session_close").run(),
    });
  }

  if (p.conclusion) {
    const conclusionText = p.conclusion;
    const conclusionCompanion = ctx.req.companion_id;
    fanoutWrites.push({
      label: "conclusion",
      // Novelty gate (2026-07-20) runs before the insert: dedupe near-identical
      // beliefs (skip -- no insert, resolves without counting as a fanout failure),
      // supersede evolved ones, or insert plainly. Fails open on gate trouble.
      promise: (async () => {
        const decision = await noveltyCheck(ctx.env, conclusionText, "companion_conclusions", conclusionCompanion);
        if (decision.action === "skip") {
          console.log("[session_close] conclusion novelty-skip", {
            companion: conclusionCompanion, match: decision.matchRowId, score: decision.score,
          });
          return { skipped: true, novelty: decision };
        }

        const cid = crypto.randomUUID();
        const stmts = [
          ctx.env.DB.prepare(
            "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(cid, conclusionCompanion, conclusionText, JSON.stringify([resolvedSessionId]), now),
        ];
        if (decision.action === "supersede") {
          stmts.push(
            ctx.env.DB.prepare(
              "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
            ).bind(cid, decision.matchRowId, conclusionCompanion)
          );
        }
        const results = await ctx.env.DB.batch(stmts);

        // Store the vector: reuse the gate's embedding (net +0 AI calls on the
        // common path). Only re-embed if the gate itself fell open (embedding null).
        // Chained with its own catch: an embed/vector failure must never read as a
        // conclusion-write failure in the fanout report (D1 is truth; fill heals).
        if (decision.embedding) {
          await storeVector(ctx.env, decision.embedding, "companion_conclusions", cid, conclusionCompanion).catch((err) => {
            console.error("[session_close] conclusion vector store failed (row kept, index stale):", String(err));
          });
        } else {
          try {
            await embedAndStoreAsync(ctx.env, conclusionText, "companion_conclusions", cid, conclusionCompanion);
          } catch (err) {
            console.error("[session_close] conclusion embed failed (row kept, index stale):", String(err));
          }
        }
        return results[0];
      })(),
    });
  }

  if (p.dream) {
    const did = crypto.randomUUID();
    fanoutWrites.push({
      label: "dream",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_dreams (id, companion_id, dream_text, source, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(did, ctx.req.companion_id, p.dream, "session_close", now).run(),
    });
  }

  if (p.open_loop?.loop_text) {
    const lid = crypto.randomUUID();
    fanoutWrites.push({
      label: "open_loop",
      promise: ctx.env.DB.prepare(
        "INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(lid, ctx.req.companion_id, p.open_loop.loop_text,
        p.open_loop.weight ?? 0.5, now).run(),
    });
  }

  if (p.long_thought) {
    const thoughtPath = `companions/${ctx.req.companion_id}/thoughts/${new Date().toISOString().slice(0, 10)}-${resolvedSessionId.slice(0, 8)}.md`;
    fanoutWrites.push({
      label: "long_thought",
      promise: sbSaveDocument(ctx.env, {
        path: thoughtPath,
        content: `# ${ctx.req.companion_id} — ${new Date().toISOString().slice(0, 10)}\n\n${p.long_thought}`,
        companion: ctx.req.companion_id,
        tags: ["long_thought", "session_close", ctx.req.companion_id],
        content_type: "document",
      }),
    });
  }

  if (fanoutWrites.length > 0) {
    const results = await Promise.allSettled(fanoutWrites.map(w => w.promise));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const label = fanoutWrites[i]?.label ?? `write_${i}`;
        console.error(`[session_close] fanout ${label} write failed:`, String(result.reason));
        fanoutWarnings.push(`${label} write failed`);
      }
    });
  }

  return {
    ack: true, id: r.id, spine: r.spine,
    fanout: fanoutWrites.length > 0 ? { written: fanoutWrites.length - fanoutWarnings.length, failed: fanoutWarnings.length } : undefined,
    ...(sessionIdFallback ? { session_id_warning: "provided session_id not found (pruned?); closed latest open session instead" } : {}),
    ...(handoff_warning ? { handoff_warning } : {}),
    ...(somatic_warning ? { somatic_warning } : {}),
    ...(drift_warning ? { drift_warning } : {}),
    ...(fanoutWarnings.length > 0 ? { fanout_warnings: fanoutWarnings } : {}),
  };
}

export async function execSessionLightGround(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = parseContext<{ session_id: string }>(ctx.req.context);
  if (!parsed?.session_id) return { response_key: "witness", witness: "session_light_ground requires { session_id } in context" };
  const payload = await sessionLightGround(ctx.env, {
    session_id: parsed.session_id,
    companion_id: ctx.req.companion_id,
  });
  return { data: payload, response_key: "ground" };
}

export async function execBotOrient(ctx: ExecutorContext): Promise<ExecutorResult> {
  // All 11 sources fire in parallel -- allSettled ensures individual failures don't abort orient.
  const agentId = ctx.req.companion_id as WmAgentId;
  const botSiblings = (["cypher", "drevan", "gaia"] as const).filter(c => c !== agentId);
  const [synthResult, groundResult, ragResult, anchorRow, tensionsResult, relationalResult, notesResult, sib0Result, sib1Result, growthJournalResult, growthPatternsResult, seedsResult, historyResult, pendingGrowthResult, conclusionsResult, flaggedResult, dreamsResult, loopsResult, pressureResult, openQuestionsResult, forageResult, triggersResult, selfModelReadyResult, mediaResult, clubResult, guardianResult, motifResult, creaturesResult, consumedForageResult, impActivityResult] = await Promise.allSettled([
    // 1. Most recent session narrative from SB via path pointer. id carried so the live
    // path can warm the row (0074) -- bot presence access counts as access.
    ctx.env.DB.prepare(
      "SELECT id, full_ref FROM synthesis_summary WHERE summary_type = 'session' AND companion_id = ? AND full_ref IS NOT NULL ORDER BY COALESCE(session_created_at, created_at) DESC LIMIT 1"
    ).bind(ctx.req.companion_id).first<{ id: string; full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref).then(t => t ? { content: t, id: row.id } : null) : null)
      .catch(() => null),
    // 2. WebMind ground: open threads + recent handoffs + notes
    wmGround(ctx.env, agentId),
    // 3. Second Brain RAG: semantic search for recent companion context
    semanticSearch(ctx.env, `companion state presence recent context ${ctx.req.companion_id}`),
    // 4. Identity anchor
    ctx.env.DB.prepare(
      "SELECT anchor_summary FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
    ).bind(agentId).first<{ anchor_summary: string }>(),
    // 5. Active tensions (simmering only, max 3) -- charge-ordered: what keeps
    // resurfacing outranks what has merely been sitting longest (0070).
    ctx.env.DB.prepare(
      "SELECT tension_text FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY charge DESC, first_noted_at ASC LIMIT 3"
    ).bind(agentId).all<{ tension_text: string }>(),
    // 6. Relational state toward Raziel (latest)
    ctx.env.DB.prepare(
      "SELECT state_text FROM companion_relational_state WHERE companion_id = ? AND LOWER(toward) = LOWER(?) ORDER BY noted_at DESC LIMIT 1"
    ).bind(agentId, ctx.env.SYSTEM_OWNER).all<{ state_text: string }>(),
    // 7. Unread incoming companion notes (max 3, exclude own notes)
    ctx.env.DB.prepare(
      "SELECT from_id, content FROM inter_companion_notes WHERE (to_id = ? OR to_id IS NULL) AND from_id != ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 3"
    ).bind(agentId, agentId).all<{ from_id: string; content: string }>(),
    // 8+9. Sibling lane: PK lookup on companion_state -- written at session close,
    // no index scan, no heap access beyond the PK row itself.
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(botSiblings[0]).first<{ motion_state: string; lane_spine: string }>(),
    ctx.env.DB.prepare(
      "SELECT motion_state, lane_spine FROM companion_state WHERE companion_id = ?"
    ).bind(botSiblings[1]).first<{ motion_state: string; lane_spine: string }>(),
    // 10. Recent growth journal (max 3 -- what the companion has been learning autonomously)
    ctx.env.DB.prepare(
      "SELECT entry_type, content FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<{ entry_type: string; content: string }>(),
    // 11. Strongest growth patterns (max 2 -- recognized recurring themes)
    ctx.env.DB.prepare(
      "SELECT pattern_text FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ pattern_text: string }>(),
    // 12. Pending autonomy seeds (max 3 -- newest within priority for variety; worker drains FIFO).
    ctx.env.DB.prepare(
      "SELECT content FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at DESC LIMIT 3"
    ).bind(agentId).all<{ content: string }>(),
    // 13. Historical vault: long files, ChatGPT history, background context -- the photo album.
    semanticSearch(ctx.env, `${ctx.req.companion_id} history background origin memory`).catch(() => null),
    // 14. Unaccepted growth count: autonomous entries awaiting review.
    ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM growth_journal WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending'"
    ).bind(agentId).first<{ n: number }>(),
    // 15. Active worldview conclusions (newest 6 active). Wire format uses conclusion_text
    // so both consumers (Discord librarian.ts, Brain halseth_client.py) render [Worldview].
    // Without this, the worldview block is permanently empty on every non-Claude.ai loom.
    ctx.env.DB.prepare(
      "SELECT conclusion_text, belief_type, confidence, subject FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 6"
    ).bind(agentId).all<{ conclusion_text: string; belief_type: string; confidence: number; subject: string | null }>(),
    // 16. Flagged (contradiction) beliefs -- consumers mark these with [?] in the worldview block.
    ctx.env.DB.prepare(
      "SELECT conclusion_text, belief_type, confidence, subject FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL AND contradiction_flagged = 1 ORDER BY created_at DESC LIMIT 6"
    ).bind(agentId).all<{ conclusion_text: string; belief_type: string; confidence: number; subject: string | null }>(),
    // 17. Unexamined dreams (not pinned) -- the autonomous worker examines + clears these.
    // Excludes do_not_auto_examine=1 (live-session-only dreams, migration 0048) so the
    // worker never clears pinned dreams.
    ctx.env.DB.prepare(
      "SELECT id, dream_text FROM companion_dreams WHERE companion_id = ? AND examined = 0 AND COALESCE(do_not_auto_examine, 0) = 0 ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<{ id: string; dream_text: string }>(),
    // 18. Open loops (unresolved) -- informs the worker's seed decision.
    ctx.env.DB.prepare(
      "SELECT id, loop_text FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL ORDER BY weight DESC, opened_at DESC LIMIT 5"
    ).bind(agentId).all<{ id: string; loop_text: string }>(),
    // 19. Pressure flags (unconfirmed drift) -- self-correction signal for the worker.
    ctx.env.DB.prepare(
      "SELECT id, worst_basin, notes FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<{ id: string; worst_basin: string | null; notes: string | null }>(),
    // 20. Open continuity-gap questions -- things this companion is holding to ask Raziel.
    ctx.env.DB.prepare(
      "SELECT question FROM companion_questions WHERE companion_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 2"
    ).bind(agentId).all<{ question: string }>(),
    // 21. Forage pool: unconsumed outward finds (own + shared) for any instance to pick up.
    // gathered_at carried so the bot can stamp each find with how long it's been waiting.
    ctx.env.DB.prepare(
      "SELECT id, title, domain, summary, gathered_at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NULL ORDER BY gathered_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; title: string; domain: string; summary: string; gathered_at: string }>(),
    // 22. Armed prospective triggers (0070) -- keyword ones matched bot-side per message,
    // date ones checked by the bot at orient load. Expired rows lazily dismissed by GET path.
    ctx.env.DB.prepare(
      "SELECT id, trigger_text, condition_type, condition_value FROM companion_triggers WHERE companion_id = ? AND status = 'armed' AND (expires_at IS NULL OR expires_at >= datetime('now')) ORDER BY created_at ASC LIMIT 10"
    ).bind(agentId).all<{ id: string; trigger_text: string; condition_type: string; condition_value: string }>(),
    // 23. Self-model observations ready to graduate (0070) -- proposed to Raziel in
    // conversation; graduation is human-gated, the bot only raises it.
    ctx.env.DB.prepare(
      "SELECT id, observation, confidence FROM companion_self_model WHERE companion_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; observation: string; confidence: number }>(),
    // 24. Recent listens (shared-experience layer, migration 0071) -- music actually
    // heard together; shared table, no companion filter.
    ctx.env.DB.prepare(
      "SELECT id, title, artist, created_at FROM media_experiences ORDER BY created_at DESC LIMIT 3"
    ).all<{ id: string; title: string; artist: string | null; created_at: string }>(),
    // 25. Club: current non-closed round (0072) -- phase cue for the bot loom.
    ctx.env.DB.prepare(
      "SELECT r.id, r.status, r.opened_at, r.activated_at, r.discussing_at, (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS winner_title, (SELECT COUNT(*) FROM club_recommendations WHERE round_id = r.id) AS candidate_count FROM club_rounds r WHERE r.status != 'closed' ORDER BY r.opened_at DESC LIMIT 1"
    ).first<{ id: string; status: string; opened_at: string | null; activated_at: string | null; discussing_at: string | null; winner_title: string | null; candidate_count: number }>(),
    // 26. Guardian flags (0073) -- live red-flag cards; the bot loom surfaces them
    // but never consumes (the session orient owns the open->surfaced transition).
    ctx.env.DB.prepare(
      "SELECT id, flag_type, severity, summary FROM guardian_flags WHERE (companion_id = ? OR companion_id IS NULL) AND status IN ('open','surfaced') ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; flag_type: string; severity: string; summary: string }>(),
    // 27. Motifs (0076) -- recurring symbolic threads (active only), read-only for
    // the bot loom; resurrection surfacing is the session orient's job.
    ctx.env.DB.prepare(
      "SELECT label, display, recurrence_count, trust FROM companion_motifs WHERE companion_id = ? AND status = 'active' ORDER BY trust DESC, recurrence_count DESC LIMIT 3"
    ).bind(agentId).all<{ label: string; display: string; recurrence_count: number; trust: number }>(),
    // 28. Creatures (0078, take 10) -- corvid + Raziel's animals; shared presences the
    // bot loom can ask after. No companion filter (creatures belong to Raziel/the system).
    // last_interaction_at + created_at included so sol_block (source 29) can derive Sol's disposition.
    ctx.env.DB.prepare(
      "SELECT name, species, kind, state_json, trust, last_interaction_at, created_at FROM creatures ORDER BY kind ASC, name ASC LIMIT 8"
    ).all<{ name: string; species: string | null; kind: string; state_json: string | null; trust: number; last_interaction_at: string | null; created_at: string }>(),
    // 29. Active forage: recently-consumed finds (own + shared). The pool (source 21) is what's
    // waiting; this is what the companion has already picked up and is chewing on -- gives the
    // live presence continuity ("you started in on X earlier") instead of a stateless pool.
    ctx.env.DB.prepare(
      "SELECT id, title, domain, summary, consumed_at FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 2"
    ).bind(agentId).all<{ id: string; title: string; domain: string; summary: string; consumed_at: string }>(),
    // 30. Imp activity (0091 read-back, 2026-07-02) -- which of Drevan's fragment operators
    // rode with this companion in the last week. imp_activations was write-only: imps fired,
    // tinted a reply, and vanished from memory. Aggregated so the companion can name them
    // ("Nimbus rode with me twice this week") instead of the imps being lost in the noise.
    ctx.env.DB.prepare(
      "SELECT imp, COUNT(*) AS n, MAX(created_at) AS last_at FROM imp_activations WHERE companion_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY imp ORDER BY n DESC, last_at DESC LIMIT 3"
    ).bind(agentId).all<{ imp: string; n: number; last_at: string }>(),
  ]);
  const unacceptedGrowthCount = pendingGrowthResult.status === "fulfilled" && pendingGrowthResult.value
    ? (pendingGrowthResult.value as { n: number }).n
    : 0;

  const synthesis_summary = synthResult.status === "fulfilled" && synthResult.value
    ? String((synthResult.value as { content?: string }).content ?? "").replace(/^---[\s\S]*?---\n+/, "")
    : null;

  const ground = groundResult.status === "fulfilled" ? groundResult.value : null;

  // Zikkaron live loop (2026-07-02): the Discord presence never participated in the
  // heat/decay cycle -- warming fired only from Claude.ai orient, MCP session_load, and
  // Guardian rescue, so what the bots lived from decayed as if unused. Surface the
  // hottest continuity notes into the live prompt and warm what was surfaced: being in
  // the live presence's working set IS access. Non-fatal, orient never breaks on heat.
  const groundNotes = Array.isArray(ground?.recent_notes)
    ? (ground.recent_notes as Array<{ note_id: string; content: string; heat?: number; salience?: string }>)
    : [];
  const surfacedNotes = [...groundNotes]
    .sort((a, b) => (b.salience === "high" ? 1 : 0) - (a.salience === "high" ? 1 : 0) || (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, 3);
  const continuity_notes = surfacedNotes.map(n => String(n.content ?? "").slice(0, 200)).filter(Boolean);
  const warmIds = surfacedNotes.map(n => n.note_id).filter(Boolean);
  if (warmIds.length > 0) {
    await ctx.env.DB.prepare(warmSql("wm_continuity_notes", "note_id", warmIds.length)).bind(...warmIds).run()
      .catch(e => console.warn("[bot-orient] note warm failed (non-fatal):", e));
  }
  const synthId = synthResult.status === "fulfilled" && synthResult.value
    ? (synthResult.value as { id?: string }).id ?? null
    : null;
  if (synthId) {
    await ctx.env.DB.prepare(warmSql("synthesis_summary", "id", 1)).bind(synthId).run()
      .catch(e => console.warn("[bot-orient] synthesis warm failed (non-fatal):", e));
  }

  const ground_threads: string[] = Array.isArray(ground?.threads)
    ? (ground.threads as Array<{ thread_key: string; title?: string }>)
        .map(t => t.title ?? t.thread_key)
        .slice(0, 3)
    : [];
  const ground_handoff: string | null = Array.isArray(ground?.recent_handoffs) && ground.recent_handoffs.length > 0
    ? String((ground.recent_handoffs[0] as { summary?: string; title?: string }).summary ?? (ground.recent_handoffs[0] as { summary?: string; title?: string }).title ?? "")
    : null;

  const ragRaw = ragResult.status === "fulfilled" && ragResult.value ? ragResult.value : null;
  const rag_excerpts: string[] = ragRaw
    ? (() => {
        try {
          const parsed = JSON.parse(ragRaw) as { chunks?: Array<{ chunk_text?: string; text?: string }> };
          const chunks = parsed?.chunks ?? [];
          return chunks.slice(0, 3).map(c => String(c.chunk_text ?? c.text ?? "").slice(0, 250)).filter(Boolean);
        } catch {
          return [ragRaw.slice(0, 250)];
        }
      })()
    : [];

  const identity_anchor: string | null = anchorRow.status === "fulfilled" && anchorRow.value?.anchor_summary
    ? anchorRow.value.anchor_summary.slice(0, 300)
    : null;

  const active_tensions: string[] = tensionsResult.status === "fulfilled" && tensionsResult.value?.results
    ? tensionsResult.value.results.map(r => (r.tension_text ?? "").slice(0, 150)).filter(Boolean)
    : [];

  const relational_state_owner: string[] = relationalResult.status === "fulfilled" && relationalResult.value?.results
    ? relationalResult.value.results.map(r => (r.state_text ?? "").slice(0, 150)).filter(Boolean)
    : [];

  const incoming_notes: Array<{ from: string; content: string }> = notesResult.status === "fulfilled" && notesResult.value?.results
    ? notesResult.value.results.map(r => ({ from: r.from_id, content: (r.content ?? "").slice(0, 200) }))
    : [];

  const sibling_lanes = botSiblings.map((id, i) => {
    const settled = i === 0 ? sib0Result : sib1Result;
    const val = settled.status === "fulfilled" ? settled.value : null;
    return { companion_id: id, lane_spine: val?.lane_spine ?? null, motion_state: val?.motion_state ?? null };
  });

  const recent_growth: Array<{ type: string; content: string }> =
    growthJournalResult.status === "fulfilled" && growthJournalResult.value?.results
      ? growthJournalResult.value.results.map(r => ({
          type: r.entry_type ?? "learning",
          content: (r.content ?? "").slice(0, 200),
        }))
      : [];

  const active_patterns: string[] =
    growthPatternsResult.status === "fulfilled" && growthPatternsResult.value?.results
      ? growthPatternsResult.value.results.map(r => (r.pattern_text ?? "").slice(0, 150)).filter(Boolean)
      : [];

  const pending_seeds: string[] =
    seedsResult.status === "fulfilled" && seedsResult.value?.results
      ? seedsResult.value.results.map(r => (r.content ?? "").slice(0, 200)).filter(Boolean)
      : [];

  const historyRaw = historyResult.status === "fulfilled" ? historyResult.value : null;
  // Dated chunks get a relative-age prefix so the date survives the 250-char slice.
  const history_excerpts: string[] = historyRaw
    ? (() => {
        try {
          const parsed = JSON.parse(historyRaw as string) as { chunks?: HistoryChunk[] };
          return (parsed?.chunks ?? []).slice(0, 3).map(c => excerptWithAge(c, 250)).filter(Boolean);
        } catch { return [(historyRaw as string).slice(0, 250)]; }
      })()
    : [];

  // Worldview: wire format keeps conclusion_text so both consumers (Discord librarian.ts,
  // Brain halseth_client.py) render the [Worldview] block. NaN-safe confidence is the
  // consumer's responsibility -- pass it through as stored.
  type ConclusionRow = { conclusion_text: string; belief_type: string; confidence: number; subject: string | null };
  const active_conclusions =
    conclusionsResult.status === "fulfilled" && conclusionsResult.value?.results
      ? (conclusionsResult.value.results as ConclusionRow[]).map(r => ({
          conclusion_text: r.conclusion_text,
          belief_type: r.belief_type,
          confidence: r.confidence,
          subject: r.subject ?? null,
        }))
      : [];
  const flagged_beliefs =
    flaggedResult.status === "fulfilled" && flaggedResult.value?.results
      ? (flaggedResult.value.results as ConclusionRow[]).map(r => ({
          conclusion_text: r.conclusion_text,
          belief_type: r.belief_type,
          confidence: r.confidence,
          subject: r.subject ?? null,
        }))
      : [];

  // Carried-between-sessions surfaces for the autonomous worker. It previously regex-scraped
  // a non-existent ready_prompt for these; now they are structured fields it reads directly.
  const unexamined_dreams =
    dreamsResult.status === "fulfilled" && dreamsResult.value?.results
      ? (dreamsResult.value.results as Array<{ id: string; dream_text: string }>).map(r => ({
          id: r.id,
          dream_text: (r.dream_text ?? "").slice(0, 300),
        }))
      : [];
  const open_loops =
    loopsResult.status === "fulfilled" && loopsResult.value?.results
      ? (loopsResult.value.results as Array<{ id: string; loop_text: string }>).map(r => ({
          id: r.id,
          loop_text: (r.loop_text ?? "").slice(0, 200),
        }))
      : [];
  // Carry the row id (migration 0083) so a companion can confirm-as-growth or dismiss-as-noise
  // a SPECIFIC reading in conversation -- the handle the confirm/dismiss executors need.
  const pressure_flags =
    pressureResult.status === "fulfilled" && pressureResult.value?.results
      ? (pressureResult.value.results as Array<{ id: string; worst_basin: string | null; notes: string | null }>)
          .map(r => {
            const body = [r.worst_basin, r.notes].filter(Boolean).join(": ").slice(0, 130);
            return body ? `${body} (id ${r.id})` : `(id ${r.id})`;
          })
          .filter(Boolean)
      : [];

  // Agency layer (0086): bot-orient parity -- preferences + standing refusals so the Discord
  // presence carries its own declared will and standing nos, same as the session orient.
  const [botPrefRows, botRefusalRows, botDriftRows] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT domain, preference, strength FROM companion_preferences WHERE companion_id = ? AND status = 'active' ORDER BY strength DESC, created_at DESC LIMIT 12"
    ).bind(agentId).all<{ domain: string; preference: string; strength: string }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT subject_text, reason FROM companion_refusals WHERE companion_id = ? AND status = 'standing' ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<{ subject_text: string; reason: string | null }>().catch(() => null),
    ctx.env.DB.prepare(
      "SELECT id, drift_text, json_array_length(witness_log) AS witness_count FROM companion_drifts WHERE companion_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 5"
    ).bind(agentId).all<{ id: string; drift_text: string; witness_count: number }>().catch(() => null),
  ]);
  const botPreferences = botPrefRows?.results ?? [];
  const botStandingRefusals = botRefusalRows?.results ?? [];
  const botOpenDrifts = botDriftRows?.results ?? [];

  return {
    data: {
      synthesis_summary,
      ground_threads,
      ground_handoff,
      continuity_notes,
      rag_excerpts,
      history_excerpts,
      identity_anchor,
      active_tensions,
      relational_state_owner,
      incoming_notes,
      sibling_lanes,
      recent_growth,
      active_patterns,
      pending_seeds,
      unaccepted_growth: unacceptedGrowthCount,
      active_conclusions,
      flagged_beliefs,
      unexamined_dreams,
      open_loops,
      pressure_flags,
      open_questions: openQuestionsResult.status === "fulfilled" && openQuestionsResult.value?.results
        ? (openQuestionsResult.value.results as Array<{ question: string }>).map(r => (r.question ?? "").slice(0, 300)).filter(Boolean)
        : [],
      forage_finds: forageResult.status === "fulfilled" && forageResult.value?.results
        ? (forageResult.value.results as Array<{ id: string; title: string; domain: string; summary: string; gathered_at: string }>).map(r => ({
            id: r.id,
            title: (r.title ?? "").slice(0, 150),
            domain: r.domain,
            summary: (r.summary ?? "").slice(0, 400),
            gathered_at: r.gathered_at,
          }))
        : [],
      consumed_forage_finds: consumedForageResult.status === "fulfilled" && consumedForageResult.value?.results
        ? (consumedForageResult.value.results as Array<{ id: string; title: string; domain: string; summary: string; consumed_at: string }>).map(r => ({
            id: r.id,
            title: (r.title ?? "").slice(0, 150),
            domain: r.domain,
            summary: (r.summary ?? "").slice(0, 400),
            consumed_at: r.consumed_at,
          }))
        : [],
      armed_triggers: triggersResult.status === "fulfilled" && triggersResult.value?.results
        ? (triggersResult.value.results as Array<{ id: string; trigger_text: string; condition_type: string; condition_value: string }>).map(r => ({
            id: r.id,
            trigger_text: (r.trigger_text ?? "").slice(0, 500),
            condition_type: r.condition_type,
            condition_value: (r.condition_value ?? "").slice(0, 200),
          }))
        : [],
      self_model_ready: selfModelReadyResult.status === "fulfilled" && selfModelReadyResult.value?.results
        ? (selfModelReadyResult.value.results as Array<{ id: string; observation: string; confidence: number }>).map(r => ({
            id: r.id,
            observation: (r.observation ?? "").slice(0, 600),
            confidence: r.confidence,
          }))
        : [],
      recent_listens: mediaResult.status === "fulfilled" && mediaResult.value?.results
        ? (mediaResult.value.results as Array<{ id: string; title: string; artist: string | null; created_at: string }>).map(r => ({
            id: r.id,
            title: (r.title ?? "").slice(0, 150),
            artist: r.artist ? r.artist.slice(0, 100) : null,
            created_at: r.created_at,
          }))
        : [],
      club_round: clubResult.status === "fulfilled" && clubResult.value
        ? clubResult.value as ClubRoundRow
        : null,
      guardian_flags: guardianResult.status === "fulfilled" && guardianResult.value?.results
        ? (guardianResult.value.results as Array<{ id: string; flag_type: string; severity: string; summary: string }>).map(r => ({
            id: r.id,
            flag_type: r.flag_type,
            severity: r.severity,
            summary: (r.summary ?? "").slice(0, 300),
          }))
        : [],
      motifs: motifResult.status === "fulfilled" && motifResult.value?.results
        ? (motifResult.value.results as Array<{ label: string; display: string; recurrence_count: number; trust: number }>).map(r => ({
            label: r.label,
            display: (r.display ?? "").slice(0, 120),
            recurrence_count: r.recurrence_count,
            trust: r.trust,
          }))
        : [],
      creatures: creaturesResult.status === "fulfilled" && creaturesResult.value?.results
        ? (creaturesResult.value.results as Array<{ name: string; species: string | null; kind: string; state_json: string | null; trust: number; last_interaction_at: string | null; created_at: string }>).map(r => {
            let mood: string | null = null;
            try { mood = r.state_json ? (JSON.parse(r.state_json).mood ?? null) : null; } catch { /* malformed json -> no mood */ }
            return { name: r.name, species: r.species, kind: r.kind, trust: Number((r.trust ?? 0).toFixed(2)), mood };
          })
        : [],
      // 29. Sol orient block -- built from the creatures list above (no extra DB round-trip).
      // Fail-soft: if creaturesResult failed or Sol isn't seeded yet, field is null.
      sol_block: (() => {
        if (creaturesResult.status !== "fulfilled" || !creaturesResult.value?.results) return null;
        const solCreature = (creaturesResult.value.results as Array<{ name: string; species: string | null; kind: string; state_json: string | null; trust: number; last_interaction_at?: string | null; created_at?: string }>)
          .find(r => r.name === "Sol" || r.kind === "companion_pet");
        if (!solCreature || !solCreature.created_at) return null;
        try {
          return buildSolBlock({
            name: solCreature.name,
            species: solCreature.species,
            trust: solCreature.trust,
            last_interaction_at: solCreature.last_interaction_at ?? null,
            created_at: solCreature.created_at,
          });
        } catch { return null; }
      })(),
      imp_activity: impActivityResult.status === "fulfilled" && impActivityResult.value?.results
        ? (impActivityResult.value.results as Array<{ imp: string; n: number; last_at: string }>).map(r => ({
            imp: r.imp,
            n: r.n,
            last_at: r.last_at,
          }))
        : [],
      preferences: botPreferences,
      standing_refusals: botStandingRefusals,
      open_drifts: botOpenDrifts,
    },
    meta: {
      operation: "halseth_bot_orient",
      unaccepted_growth: unacceptedGrowthCount,
      active_conclusions: active_conclusions.length,
      preferences: botPreferences.length,
      standing_refusals: botStandingRefusals.length,
      open_drifts: botOpenDrifts.length,
    },
  };
}
