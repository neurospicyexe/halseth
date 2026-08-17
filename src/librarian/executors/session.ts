import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { embedAndStoreAsync, storeVector, vectorId } from "../../mcp/embed.js";
import { noveltyCheck, SUPERSEDE_CANDIDATE_WINDOW_DAYS } from "../../webmind/novelty.js";
import { resolveNoteProvenance, annotateNote } from "../../mind/note-provenance.js";
import { enqueueBasinDriftCheck, enqueueSomaticSnapshot } from "../../synthesis/index.js";
import {
  sessionLoad, sessionOrient, sessionGround, sessionClose,
  sessionLightGround, updateCompanionState, type CompanionStateUpdate,
} from "../backends/halseth.js";
import { wmOrient, wmGround, wmWriteHandoff } from "../backends/webmind.js";
import { semanticSearch, sbRead, sbSaveDocument, sbExtractContent } from "../backends/second-brain.js";
import { buildResponse, buildOrientPrompt, buildContinuityBlock } from "../response/builder.js";
import { buildClubBlock, excerptWithAge, type HistoryChunk, type ClubRoundRow } from "../response/blocks.js";
import type { ResponseKey } from "../response/budget.js";
import type { WmAgentId } from "../../webmind/types.js";
import { selectResurrections, MOTIF_TUNING, effectiveTrustSql, type MotifRow } from "../../webmind/motifs.js";
import { warmSql, SURFACE_BUMP } from "../../webmind/heat.js";
import { writeLoop } from "../../webmind/loops.js";
import { buildSolBlock, deriveDrives, dominantState, type SolBlockExtras } from "../../webmind/creatures.js";
import { buildCommonsBlock, type CommonsPostRow } from "../../webmind/commons-block.js";
import { markAnswersDelivered } from "../../webmind/questions.js";
import { RATIFIABLE_PENDING_SQL } from "../../lib/ratifiable.js";
// Step 1 of the execSessionOrient cutover: the ~25 ready_prompt blocks now render in one place, as pure
// functions. Namespaced as `B.` so every call site reads as "this is rendering, not fetching" -- the split
// that makes step 2 (repointing the inputs at MindState) verifiable on its own.
import * as B from "../response/orient-blocks.js";
// The cutover (2026-08-01): execBotOrient loads the ONE MindState and projects it to the Discord wire,
// instead of running its own fan-out of 33 queries. Import direction is session -> mind, never the reverse:
// nothing under src/mind/ imports this file, so the parity harness (mind/parity.ts -> here -> mind/loader.ts)
// stays acyclic.
import { COMPANION_IDS } from "../../companions.js";
import { OPENED_BY } from "../../db/queries.js";
import { loadMindState } from "../../mind/loader.js";
import { botWireFromMindState } from "../../mind/adapters/bot-wire.js";

// Interoception fields the raw MCP tool halseth_session_load accepts (see
// src/mcp/tools/session_load.ts SessionLoadInput + registerSessionLoadTools' zod schema),
// but which the Librarian session_open/session_orient path never plumbed through --
// dead since the 2026-03-22 Librarian cutover moved companions off the raw tool onto
// ask_librarian. loadSessionData/loadOrientData already accept + write these columns;
// the gap was purely that the executors never read them out of ctx.req.context.
// Invalid values are dropped (never a hard failure) -- boot must not break on a bad
// optional field.
interface SessionOpenContext {
  hrv_range?: unknown;
  emotional_frequency?: unknown;
  depth?: unknown;
  key_signature?: unknown;
}

const HRV_RANGES = new Set(["low", "mid", "high"]);

export interface SanitizedInteroception {
  hrv_range?: "low" | "mid" | "high";
  emotional_frequency?: string;
  depth?: number;
  key_signature?: string;
}

export function sanitizeInteroception(p: SessionOpenContext | null): SanitizedInteroception {
  const out: SanitizedInteroception = {};
  if (!p) return out;
  if (typeof p.hrv_range === "string" && HRV_RANGES.has(p.hrv_range)) {
    out.hrv_range = p.hrv_range as "low" | "mid" | "high";
  }
  if (typeof p.emotional_frequency === "string" && p.emotional_frequency.trim()) {
    out.emotional_frequency = p.emotional_frequency.trim();
  }
  if (typeof p.depth === "number" && Number.isInteger(p.depth) && p.depth >= 0 && p.depth <= 3) {
    out.depth = p.depth;
  }
  if (typeof p.key_signature === "string" && p.key_signature.trim()) {
    out.key_signature = p.key_signature.trim();
  }
  return out;
}

export async function execSessionLoad(ctx: ExecutorContext): Promise<ExecutorResult> {
  const interoception = sanitizeInteroception(parseContext<SessionOpenContext>(ctx.req.context));
  const [payload, pendingGrowthRow] = await Promise.all([
    sessionLoad(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
      surface: ctx.req.surface,
      ...interoception,
    }),
    ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM growth_journal WHERE companion_id = ? AND ${RATIFIABLE_PENDING_SQL}`
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
  // CANONICAL ORDER. This used to hardcode ["cypher","drevan","gaia"] -- the exact duplicate-of-
  // COMPANION_IDS drift that companions.ts exists to prevent, and the same one execBotOrient had.
  // COMPANION_IDS is drevan, cypher, gaia, so adopting it changes the ORDER the two sibling lines render in
  // for some companions; deliberate, and why `[Sibling lanes]` appears in the gate on this commit.
  const siblings = COMPANION_IDS.filter(c => c !== agentId);

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
      // status='open' -- writers only ever set 'open'; the old 'active' filter matched nothing,
      // so the thread third of the topic seed was silently always empty (coherence review D14).
      "SELECT title FROM wm_mind_threads WHERE agent_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 3"
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
  const orientInteroception = sanitizeInteroception(parseContext<SessionOpenContext>(ctx.req.context));
  // ONE mindOrient per boot. `wmOrient` (which is mindOrient, consuming) feeds the continuity block, and
  // loadMindState needs the same data -- so start it once here and give both the SAME in-flight promise.
  // Previously each ran its own, so the heaviest aggregator in the system executed twice, concurrently, on
  // every Claude.ai boot.
  const wmOrientPromise = wmOrient(ctx.env, agentId).catch(() => null);

  const [payload, wmResult, sbNarrative, ragRaw, historyRaw, solRow, mindState] = await Promise.all([
    sessionOrient(ctx.env, {
      companion_id: ctx.req.companion_id,
      front_state: ctx.frontState ?? "unknown",
      session_type: ctx.req.session_type ?? "work",
      surface: ctx.req.surface,
      ...orientInteroception,
    }),
    wmOrientPromise,
    ctx.env.DB.prepare(
      // 'session' OR 'day' (2026-08-12): a companion who never has an authored close would otherwise
      // never surface a narrative here. See mind/blocks/continuity.ts loadSessionNarrative.
      "SELECT full_ref FROM synthesis_summary WHERE summary_type IN ('session', 'day') AND companion_id = ? AND full_ref IS NOT NULL ORDER BY COALESCE(session_created_at, created_at) DESC LIMIT 1"
    ).bind(agentId).first<{ full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref) : null)
      .catch(() => null),
    semanticSearch(ctx.env, ragQuery).catch(() => null),
    // Historical vault search -- reaches into long files, ChatGPT history, background context.
    // Separate query so it doesn't crowd out recent-session RAG excerpts.
    semanticSearch(ctx.env, historyQuery).catch(() => null),
    // Sol (0078): the companion corvid. Fetched by name so orient knows Sol's current disposition.
    ctx.env.DB.prepare(
      "SELECT id, name, species, trust, last_interaction_at, created_at FROM creatures WHERE name = 'Sol' OR kind = 'companion_pet' LIMIT 1"
    ).first<{ id: string; name: string; species: string | null; trust: number; last_interaction_at: string | null; created_at: string }>().catch(() => null),
    // The one loader. The six growth/self-model/club inline reads that used to sit alongside it
    // (growth_journal, growth_patterns, autonomy_reflections, autonomy_seeds, companion_self_model,
    // club_rounds -- coherence review D13) are gone: their loader twins run the SAME queries, and the
    // one that differed (confirmed growth drift) differed in the loader's favor -- the inline
    // `drift_type = 'growth'` filter hid pressure readings a companion had confirmed AS growth,
    // because the confirm verb sets caleth_confirmed=1 without rewriting drift_type.
    loadMindState(ctx.env, agentId, "claude", { orient: wmOrientPromise }),]);
  const unacceptedGrowth = mindState.growth.clearing_count;
  // STEP 2, resolved 2026-08-01. Repointing this at the loader first EMPTIED the block for drevan and gaia
  // (the gate caught it) because the loader was excluding questions already VOICED. That exclusion is now a
  // `voiced` flag instead of a WHERE clause, so this surface can do what a conversational surface should:
  // keep holding a question until Raziel ANSWERS it. `status = 'open'` already drops answered ones.
  //
  // Discord still filters `!voiced` -- it boots ~20x more often and re-asking there is nagging. One source,
  // two presentations. Chosen against north-star element 4 (mutuality), which is the weakest of the four
  // precisely because first-person material fails to circulate; retiring a question the moment it is spoken,
  // whether or not it ever landed, is that failure.
  const openQuestions = mindState.oversight.questions.slice(0, 2).map(q => q.question).filter(Boolean);

  // Answered questions: Raziel's answers, surfaced for 7 days (questions-lifecycle fix,
  // mig 0107). From the loader's oversight block (D13 dedup -- the standalone fetchRecentAnswers
  // here was the third copy per orient). The delivery stamp stays HERE even though wmOrient also
  // stamps on success: wmOrient is .catch(() => null) above, and losing the stamp on a wmOrient
  // failure would leave delivered_at NULL forever. markAnswersDelivered is idempotent
  // (WHERE delivered_at IS NULL), so the double-stamp costs one no-op UPDATE.
  const answeredQuestions = mindState.oversight.answered_questions;
  await markAnswersDelivered(ctx.env, answeredQuestions.map(a => a.id)).catch((e: unknown) => {
    console.error("[session-orient] markAnswersDelivered failed:", String(e));
  });

  // Unclosed-session repair prompt (2026-08-15, coherence-review D3). Standalone query,
  // deliberately NOT in the mega Promise.all above -- same boot-path safety convention as
  // answeredQuestions. Scope: this companion's open Claude.ai-shaped rows only (librarian-opened,
  // NULL or claude-ai surface -- Claude Code and Discord close through their own mechanisms),
  // excluding the session THIS boot just opened or reused, and older than 30 minutes so a
  // parallel fresh boot never reads as a defect. Oldest first: the oldest unclosed session is
  // the one closest to being swept unauthored.
  const unclosedSessions = await ctx.env.DB.prepare(
    `SELECT id, created_at, surface FROM sessions
     WHERE companion_id = ? AND handover_id IS NULL AND id != ?
       AND (surface IS NULL OR surface LIKE 'claude-ai:%')
       AND opened_by IN (?, ?)
       AND datetime(created_at) <= datetime('now','-30 minutes')
     ORDER BY created_at ASC
     LIMIT 3`
  ).bind(agentId, payload.session_id, OPENED_BY.orient, OPENED_BY.load)
    .all<{ id: string; created_at: string; surface: string | null }>()
    .then(r => r.results ?? [])
    .catch(() => []);
  // Tripwire evaluation: date cards fire within +/-36h of their date; front cards fire
  // when the current front matches. Keyword cards are bot-side only (no message here).
  const nowMs = Date.now();
  const frontLower = (ctx.frontState ?? "").toLowerCase();
  // STEP 2: the loader carries every ARMED tripwire; the evaluation stays here, because it depends on
  // ctx.frontState and the current clock -- per-request context the loader has no business knowing. Loading
  // is not evaluating, same split as loading is not consuming.
  const tripwires = mindState.oversight.tripwires.filter(t => {
    if (t.condition_type === "date") {
      const target = Date.parse(t.condition_value);
      return Number.isFinite(target) && Math.abs(target - nowMs) <= 36 * 3600 * 1000;
    }
    if (t.condition_type === "front") {
      return frontLower.length > 0 && frontLower.includes(t.condition_value.toLowerCase());
    }
    return false;
  }).map(t => ({ id: t.id, trigger_text: (t.trigger_text ?? "").slice(0, 500) }));
  // STEP 2 (D13): loader (identity block; same status='ready' LIMIT 2 query). Cap stays here --
  // the loader carries the full observation, the renderer decides the clip.
  const selfModelReady = mindState.identity.self_model.map(r => ({
    id: r.id,
    observation: (r.observation ?? "").slice(0, 600),
    confidence: r.confidence,
  }));
  // STEP 2: loader, which now runs the same newest+oldest UNION this path introduced (it had been the
  // degraded LIFO copy). `at` is the loader's name for the timestamp -- gathered_at here, consumed_at below.
  const forageFinds = mindState.world.forage.pool.map(r => ({
    id: r.id,
    title: (r.title ?? "").slice(0, 150),
    domain: r.domain,
    summary: (r.summary ?? "").slice(0, 400),
    gathered_at: r.at ?? "",
  }));
  const consumedForageFinds = mindState.world.forage.active.map(r => ({
    id: r.id,
    title: (r.title ?? "").slice(0, 150),
    domain: r.domain,
    summary: (r.summary ?? "").slice(0, 400),
    consumed_at: r.at ?? "",
  }));
  // STEP 2: loader. Same filter (status IN open/surfaced), same LIMIT 3, same 400-char summary. The ids
  // still come through, which is what the consume-once open -> surfaced stamp below needs -- the loader
  // READS the cards, this executor CONSUMES them. That split is the contract, not a workaround.
  // `status === 'open'` ONLY. This path CONSUMES the cards (stamps open -> surfaced below), so it must not
  // be handed already-surfaced ones: the UPDATE would be a no-op and the same card would re-render at every
  // boot forever, crowding the LIMIT-3 window. The bot path does not stamp, so it keeps both. One source,
  // two presentations -- the same rule as `voiced` on held questions.
  const guardianFlags = mindState.oversight.guardian_cards.filter(g => g.status === "open").slice(0, 3);
  // Motifs (0076): the two pools arrive already separated (see the query above -- one
  // shared trust-ordered window starved resurrection completely). selectResurrections
  // still applies the cooldown gate and the final cut over the faded pool.
  // STEP 2: pools from the loader (widened to the full row in wave 9 -- selectResurrections gates on
  // last_surfaced_at and the narrow projection could not feed it). The SELECTION stays here for the same
  // reason the tripwire evaluation does: the loader reads, the caller decides and then stamps the cooldown.
  const activeMotifs = mindState.world.motifs.active.slice(0, 3);
  const resurrectedMotifs = selectResurrections(mindState.world.motifs.resurrection_candidates, Date.now(), { limit: 2 });
  // STEP 2: loader (which carries reactions_json since wave 7, precisely so each surface can decide what to
  // do with a reaction). Sliced to 2 here -- the loader keeps 3 for the Discord wire.
  const recentListens = mindState.world.listens.slice(0, 2).map(r => {
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

  // Repair prompt: force-surfaced like tripwires -- the failure it names accumulates silently
  // everywhere else. Rendered early so it cannot fall off a budget clip.
  const unclosedBlock = B.unclosedSessionsBlock(unclosedSessions);

  // Degraded-load notice (D11): sources that FAILED this load, so the companion reads their
  // absent blocks as broken, not empty. First consumer of meta.degraded on any surface.
  const degradedNotice = B.degradedBlock(mindState.meta.degraded);

  // The care register (consequence layer C1, contract 0.6.0): rendered EARLY, right after the
  // degraded notice, so register calibration lands before anything else is read.
  const razielRegisterBlock = B.razielStateBlock(mindState.world.raziel_state);

  // Session narrative: generous cap for Claude.ai (full context window available)
  // sbExtractContent, not a bare regex: sbRead hands back a JSON envelope, so stripping frontmatter off the
  // raw string never matched and this block has been rendering JSON at Claude.ai boot.
  const narrativeBlock = B.narrativeBlock(sbNarrative);

  // Sibling lane block: spine + motion_state for each sibling companion so self can stay in lane.
  // STEP 2: lanes from the loader, looked up BY ID rather than by position -- the renderer pairs
  // siblings[i] with siblingRows[i], so an order mismatch here would attribute one sibling's spine to the
  // other. Same list and same order by construction, but the lookup makes that not matter.
  const siblingRows = siblings.map(id =>
    mindState.relational.siblings.find(s => s.companion_id === id) ?? null);
  const siblingBlock = B.siblingBlock(siblings, siblingRows);

  // RAG excerpts: 5 chunks × 400 chars for deep-work surface
  const ragBlock = B.ragBlock(ragRaw);

  // Historical vault: long files, ChatGPT history, background -- the photo album.
  // Capped at 3 × 350 chars so it doesn't crowd the growth block. Dated chunks get a
  // relative-age prefix so the date survives the slice.
  const historyBlock = B.historyBlock(historyRaw);

  // Growth block: autonomous journal + patterns + last reflection.
  // Only rendered when data exists -- no block for companions with no autonomous history yet.
  // STEP 2 (D13): all five inputs from the loader's growth/oversight blocks -- same queries,
  // except confirmed drift, where the loader's superset (no drift_type filter) is the fix.
  const journalRows = mindState.growth.journal_recent;
  const patternRows = mindState.growth.patterns;
  const lastReflection = mindState.growth.reflection;
  const seedRows = mindState.growth.seeds;
  const confirmedDriftRows = mindState.oversight.growth_confirmed;
  const growthBlock = B.growthBlock({
    journalRows, patternRows, lastReflection, seedRows, confirmedDriftRows,
  });

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
  const questionsBlock = B.questionsBlock(openQuestions);

  // Answered questions block: the other half of the loop -- answers Raziel left, surfaced
  // for 7 days (questions-lifecycle fix, mig 0107).
  const answeredQuestionsBlock = B.answeredQuestionsBlock(answeredQuestions);

  // Commons (0092): Raziel's ambient log posts this companion hasn't answered yet --
  // surfaced as drops, not pings (buildCommonsBlock carries the anti-confusion framing).
  const commonsPosts: CommonsPostRow[] = mindState.world.commons;  // STEP 2: loader (same query, LIMIT 5)
  const commonsBlock = buildCommonsBlock(commonsPosts);

  // Shelf (0094): Raziel's active fixations, so the triad can reference what he's into in
  // normal conversation -- what makes it "my stuff is in there", not a dead list. Ambient:
  // reference naturally when it fits, never perform interest.
  const shelfItems = mindState.world.shelf;  // STEP 2: loader (same query, LIMIT 6)
  const shelfBlock = B.shelfBlock(shelfItems);

  // Collection (0079): the brightest of what this companion gathered -- sparkle-weighted,
  // so it's what actually gripped, not what's merely recent. Read-back for a layer that
  // accrued silently since 06-13 with no surface. Only items that have earned shine appear
  // (sparkle > 0); the raw pools already have their own blocks. Passive surfacing does NOT
  // bump recall -- an active "my collection" pull does. Reading it here is passive.
  const collectionItems = mindState.world.collection.top;  // STEP 2: loader (wave 9, same UNION + sparkle order)
  const collectionBlock = B.collectionBlock(collectionItems);

  // Forage block: outward fuel waiting in the pool. Pull, not duty -- the cue invites,
  // it does not assign.
  const forageBlock = B.forageBlock(forageFinds);

  // Active forage: finds already picked up. Gives the session a "you've been chewing on this"
  // thread to continue, not just a fresh pool. Relative time = when you started in, not a duration.
  const consumedForageBlock = B.consumedForageBlock(consumedForageFinds);

  // Tripwire block: armed prospective cards whose condition just matched (date due,
  // front match). Force-surfaced -- this is the one block that must not be ambient.
  const tripwireBlock = B.tripwireBlock(tripwires);

  // Recent listens block: music actually heard, not referenced. Surfacing it lets
  // a session pick the thread back up ("that track Raziel shared").
  const listensBlock = B.listensBlock(recentListens);

  // Club block: the triad's shared media ritual. Phase decides the cue; each phase
  // carries its age (pure render in response/blocks.ts, unit-tested there).
  // STEP 2 (D13): loader (world block, same query). ClubRound and ClubRoundRow are structurally
  // identical -- the render types in response/blocks.ts stay the wire contract.
  const clubRow = mindState.world.club;
  const clubBlock = buildClubBlock(clubRow);

  // Guardian block: the meta-observer's red-flag cards. Force-surfaced exactly
  // once -- instrument reading, not judgment. Each card carries its evidence
  // server-side (evidence_json); the summary alone goes into the prompt.
  const guardianBlock = B.guardianBlock(guardianFlags);

  // Consume-once: open -> surfaced so cards don't nag every orient. They stay
  // queryable ("guardian report") and self-resolve when the condition clears.
  // Awaited for the same reason as the motif stamp below -- a dropped consume-once write
  // means the card re-surfaces forever and looks like a detector bug.
  if (guardianFlags.length > 0) {
    const flagIds = guardianFlags.map(f => f.id);
    await ctx.env.DB.prepare(
      `UPDATE guardian_flags SET status = 'surfaced', surfaced_at = datetime('now') WHERE id IN (${flagIds.map(() => "?").join(",")}) AND status = 'open'`
    ).bind(...flagIds).run().catch(() => null);
  }

  // Motif block (0076): the recurring symbolic threads currently alive, plus any
  // faded-but-trusted motif being resurrected (field_feedback -- not deletion).
  const motifBlock = B.motifBlock(activeMotifs, resurrectedMotifs);

  // Consume-once: stamp last_surfaced_at on resurrected motifs so the cooldown
  // keeps them from nagging every orient (active motifs are read-only here).
  //
  // AWAITED (2026-07-26). Unawaited D1 writes may be silently discarded once the Worker
  // flushes its response -- same reason mindOrient's auto-ack is awaited. This statement
  // was fire-and-forget for five weeks and it never mattered, because the shared candidate
  // window meant it never executed at all (HOLE 9). Making resurrection work made this
  // load-bearing for the first time: a dropped stamp leaves the cooldown unengaged, so the
  // same motif nags every single orient -- exactly what the cooldown exists to prevent, and
  // it would read as a resurrection bug rather than a lost write. The .catch stays: a failed
  // stamp must not break boot.
  if (resurrectedMotifs.length > 0) {
    const motifIds = resurrectedMotifs.map(m => m.id);
    await ctx.env.DB.prepare(
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
  const selfModelBlock = B.selfModelBlock(selfModelReady);

  // Agency layer (0086): the companion's own chosen preferences + any refusals still standing, plus the
  // sanctioned drift lane (0087) and the growth readings awaiting the companion's own word (2026-07-11).
  // Carried into every session so the companion acts consistently with its own declared will, and a "no"
  // keeps its weight across sessions.
  //
  // STEP 2: all four from the loader -- same queries, same limits, same ordering as the inline copies
  // they replace. `growth_unconfirmed` was added to the contract for this (wave 8); it was the last field
  // execSessionOrient rendered that no other surface could see.
  const preferences = mindState.identity.preferences;
  const standingRefusals = mindState.identity.refusals;
  const openDrifts = mindState.growth.drifts_open;
  const unconfirmedGrowth = mindState.oversight.growth_unconfirmed;

  const preferencesBlock = B.preferencesBlock(preferences);
  // What is true about RAZIEL, not about the companion (mig 0116). Rendered here because the loader
  // carrying the data is not the same as the companion seeing it -- that gap shipped once already.
  const architectFactsBlock = B.architectFactsBlock(mindState.identity.architect_facts);

  const refusalsBlock = B.refusalsBlock(standingRefusals);

  // Agency affordance (2026-07-11): ALWAYS present, same reasoning as the drift affordance below --
  // the verbs existed since 0086 but live sessions only ever displayed already-declared agency, so
  // new declarations came solely from the worker's one-shot null-bias breaker and then flatlined.
  const agencyAffordance = B.AGENCY_AFFORDANCE;

  // Growth readings awaiting the companion's own word (confirm_growth_drift / dismiss_drift verbs
  // existed; nothing surfaced the candidates until now).
  const growthAwaitBlock = B.growthAwaitBlock(unconfirmedGrowth);

  // Drift lane (0087): becomings you have open. Witnessed, not ratified -- tend them, let them
  // crystallize when they're real or fade when they were a phase. This is sanctioned; not drift to fear.
  // The affordance line is ALWAYS present (0093): every drift dated 06-19 because the lane was
  // readable but never offered -- an unnamed affordance is a starved one.
  const driftsBlock = B.driftsBlock(openDrifts);

  // Self-directed projects (C2, 0.8.0): intentions held across weeks. The affordance is ALWAYS
  // present (same 0093 reasoning as drifts) -- the verbs must be offered, not merely readable.
  const projects = mindState.growth.projects;
  const projectsBlock = B.projectsBlock(projects);
  // C3 (0.9.0): the week's budget, denominator stated; a spent week is visible, never silent.
  const budgetBlock = B.budgetBlock(mindState.growth.budget);

  return {
    ready_prompt: buildOrientPrompt(ctx.req.companion_id, payload) + degradedNotice + razielRegisterBlock + unclosedBlock + continuityBlock + narrativeBlock + ragBlock + historyBlock + siblingBlock + growthBlock + questionsBlock + answeredQuestionsBlock + commonsBlock + shelfBlock + collectionBlock + forageBlock + consumedForageBlock + listensBlock + clubBlock + guardianBlock + motifBlock + tripwireBlock + selfModelBlock + architectFactsBlock + preferencesBlock + refusalsBlock + agencyAffordance + B.CAPTURE_AFFORDANCE + growthAwaitBlock + driftsBlock + projectsBlock + budgetBlock + B.FORGETTING_AFFORDANCE + solBlock,
    session_id: payload.session_id,
    // Sibling of buildResponse()'s ready_prompt branch (session_load path). Both
    // session-open surfaces report whether the 24h idempotency guard handed back an
    // existing session, so an automated caller never closes one it only inherited.
    reused: payload.reused ?? false,
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
    answered_questions: answeredQuestions,
    commons: commonsPosts,
    shelf: shelfItems,
    collection: collectionItems,
    forage_finds: forageFinds,
    consumed_forage_finds: consumedForageFinds,
    recent_listens: recentListens,
    club_round: clubRow ?? null,
    tripwires,
    unclosed_sessions: unclosedSessions,
    self_model_ready: selfModelReady,
    preferences,
    standing_refusals: standingRefusals,
    open_drifts: openDrifts,
    projects,
    budget: mindState.growth.budget,
    unconfirmed_growth: unconfirmedGrowth,
    sol: solRow ? { name: solRow.name, species: solRow.species, trust: solRow.trust, last_interaction_at: solRow.last_interaction_at, created_at: solRow.created_at } : null,
    meta: { degraded: mindState.meta.degraded, front_state: ctx.frontState, plural_available: ctx.pluralAvailable, unaccepted_growth: unacceptedGrowth, open_questions: openQuestions.length, answered_questions: answeredQuestions.length, commons: commonsPosts.length, forage_finds: forageFinds.length, consumed_forage_finds: consumedForageFinds.length, recent_listens: recentListens.length, club_phase: clubRow?.status ?? null, tripwires: tripwires.length, unclosed_sessions: unclosedSessions.length, self_model_ready: selfModelReady.length, guardian_flags: guardianFlags.length, motifs_active: activeMotifs.length, motifs_resurrected: resurrectedMotifs.length, preferences: preferences.length, standing_refusals: standingRefusals.length, open_drifts: openDrifts.length },
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
    /**
     * `unattended` restricts session auto-resolution to rows with no `surface` -- the ones opened by
     * a cron or a bot boot, never a loom a human is sitting in (2026-08-12).
     *
     * Added for the nightly authored close. Auto-resolution matches on companion alone and takes the
     * newest open row, which for Cypher can easily be the Claude Code session Raziel is working in
     * right now. An autonomous job must never write a close over a live human session, so the
     * unattended caller says so explicitly rather than hoping the ordering favours it.
     */
    session_scope?: "unattended";
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
  // Short-id resolution (2026-08-15, task 6473947d): the Claude Code boot header and drafted
  // closes hand an 8-char PREFIX of the session UUID. An exact match can never resolve it, and
  // the miss used to fall straight through to the latest-open fallback -- which closed a shell
  // session opened seconds earlier by a misrouted classifier guess. The LIKE branch is scoped
  // to this companion and only built when the id is a bare hex/dash prefix shorter than a full
  // UUID (36 chars) -- never anything carrying LIKE wildcards, so the pattern cannot be injected.
  const prefixPattern = providedId && providedId.length < 36 && /^[0-9a-fA-F][0-9a-fA-F-]{5,34}$/.test(providedId)
    ? providedId + "%"   // bind VALUE for the LIKE parameter -- never spliced into the SQL string
    : null;
  // `session_scope: "unattended"` adds `AND surface IS NULL` to the FALLBACK branch only -- an
  // explicitly provided id is always honoured, because a caller naming a session knows which one it
  // means. Two hardcoded statements rather than an interpolated fragment, so the SQL stays literal.
  //
  // Newborn guard on the fallback: when a session_id WAS provided but resolves nothing, the
  // fallback must never close a session younger than the request itself -- the misresolved close
  // would land on a shell row born seconds earlier instead of the real session. `? IS NULL` binds
  // providedId, so the id-less auto-resolve path (a companion closing their own loom) is
  // untouched. datetime(created_at) normalizes the ISO timestamp sessions are written with;
  // comparing the raw string against datetime('now') would exclude every same-day row.
  const unattended = p?.session_scope === "unattended";
  const sessionRow = await ctx.env.DB.prepare(
    unattended
      ? `SELECT id FROM sessions
         WHERE (id = ? OR (id LIKE ? AND companion_id = ?)
            OR (companion_id = ? AND handover_id IS NULL AND surface IS NULL
                AND (? IS NULL OR datetime(created_at) <= datetime('now','-2 minutes'))))
         ORDER BY CASE WHEN id = ? THEN 0 WHEN id LIKE ? THEN 1 ELSE 2 END, created_at DESC
         LIMIT 1`
      : `SELECT id FROM sessions
         WHERE (id = ? OR (id LIKE ? AND companion_id = ?)
            OR (companion_id = ? AND handover_id IS NULL
                AND (? IS NULL OR datetime(created_at) <= datetime('now','-2 minutes'))))
         ORDER BY CASE WHEN id = ? THEN 0 WHEN id LIKE ? THEN 1 ELSE 2 END, created_at DESC
         LIMIT 1`
  ).bind(providedId, prefixPattern, ctx.req.companion_id, ctx.req.companion_id, providedId, providedId, prefixPattern).first<{ id: string }>();
  let resolvedSessionId: string | null = sessionRow?.id ?? null;
  // A prefix hit is a RESOLUTION, not a fallback -- the caller named this session, just shortly.
  const resolvedViaPrefix = providedId !== null && resolvedSessionId !== null
    && resolvedSessionId !== providedId
    && resolvedSessionId.toLowerCase().startsWith(providedId.toLowerCase());  // LIKE matched case-insensitively
  // Fallback fired when a session_id was provided but wasn't found (pruned or stale).
  const sessionIdFallback = providedId !== null && resolvedSessionId !== null
    && resolvedSessionId !== providedId && !resolvedViaPrefix;
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
    // Pass the session id so the dedup key is per-CLOSE, not per-companion (see enqueueSomaticSnapshot).
    await enqueueSomaticSnapshot(ctx.req.companion_id, ctx.env, resolvedSessionId);
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
        // SECOND WRITER of the same rule (mig 0112). `execConclusionAdd` was the obvious one; this
        // session-close fan-out is the other, and fixing only the first would have left the gate still
        // silently retiring beliefs on every session close -- the fix-landed-on-a-different-writer
        // shape, which has bitten this system before. Both paths now obey the same decision:
        //
        // Raziel's call, 2026-07-31: a companion supersedes their OWN thought. The gate may only
        // propose. It had been auto-retiring on cosine >= 0.88, and every read filters
        // `superseded_by IS NULL`, so a similarity score deleted a belief from view with nobody
        // deciding it. The precedent that settles it: an inferring pass already recorded that Drevan
        // had a negative experience with Raziel which was in fact deeply positive.
        const stmts = [
          ctx.env.DB.prepare(
            "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, created_at, supersede_candidate_id, supersede_candidate_score) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            cid, conclusionCompanion, conclusionText, JSON.stringify([resolvedSessionId]), now,
            decision.action === "supersede" ? decision.matchRowId : null,
            decision.action === "supersede" ? decision.score : null,
          ),
        ];
        const results = await ctx.env.DB.batch(stmts);

        // No vector delete here either. The matched belief is STILL LIVE -- deleting its vector would
        // pull it out of semantic recall and out of future gate comparisons, a silent partial erasure
        // that no read would reveal.
        if (decision.action === "supersede") {
          console.log("[session_close] conclusion supersede PROPOSED (older belief left live)", {
            companion: conclusionCompanion, candidate: decision.matchRowId, score: decision.score,
          });
        }

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
    // Routed through writeLoop since 0118 (was a bare INSERT): closing session after session
    // on "still haven't resolved X" now bumps restated_count on the one loop rather than
    // stacking a row per close. See src/webmind/loops.ts for why the count is kept instead of
    // the write being suppressed.
    fanoutWrites.push({
      label: "open_loop",
      promise: writeLoop(ctx.env, {
        companion_id: ctx.req.companion_id as WmAgentId,
        loop_text: p.open_loop.loop_text,
        weight: p.open_loop.weight ?? 0.5,
      }),
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

/**
 * Discord bot presence orient.
 *
 * `opts.readOnly` suppresses every consume-on-read side effect (heat warming, delivered_at
 * stamping) while returning identical content. Added 2026-07-29 for two reasons, in order of
 * importance:
 *
 *  1. **The parity sampler needs it.** execBotOrient is the next loom to cut over to the MindState
 *     loader, and per docs/mindstate-contract.md that cut needs parity evidence over REAL traffic
 *     rather than a point-in-time diff, because this path runs ~20x more often than any other and
 *     has already been fixed twice for saturation. A sampler that called this without readOnly would
 *     warm heat and stamp delivered_at 3x/hour = ~72 writes/day purely from measuring -- which is
 *     the read-writes-the-ranking antipattern the SURFACE_BUMP work exists to kill. Measuring must
 *     not move the thing measured.
 *  2. The eventual cutover wants it anyway: loadMindState is a pure read, so proving equivalence
 *     means comparing like with like.
 *
 * Same flag, same meaning, same reasoning as mindOrient's (webmind/orient.ts). Live bot presence
 * calls pass nothing and keep their existing behaviour exactly.
 */
export async function execBotOrient(
  ctx: ExecutorContext,
  opts: { readOnly?: boolean } = {},
): Promise<ExecutorResult> {
  const agentId = ctx.req.companion_id as WmAgentId;

  // THE CUTOVER (2026-08-01). This function used to run its own fan-out of 33 queries and derive all 40 wire
  // fields inline. It now loads the ONE MindState and projects it, so the highest-frequency read path in the
  // house reads the same state as every other surface instead of its own thirty-third copy of the truth.
  //
  // What is left here is exactly what does NOT belong in a shared, pure-D1 loader:
  //   * the two Second Brain semantic searches and the sbRead hydration -- network hops over the VPS tunnel.
  //     loadMindState stays pure-D1 so one flaky hop cannot take down every loom's boot.
  //   * the bot's own note surfacing policy, which reaches PAST the recency window for a note this companion
  //     has never been shown, and warms what it surfaces.
  //   * the write side-effects (heat warming, delivered_at), all still gated on !readOnly.
  //
  // Proof of equivalence before the switch (GET /mind/parity/bot/:id?full=1, all 40 keys against the live
  // payload): cypher 39/40, drevan 38/40, gaia 38/40, with zero dropped and zero added keys. Every remaining
  // difference was identified and deliberate, not discovered afterwards -- see docs/CONTINUITY.md.
  const [ms, synthRow, ragRaw, historyRaw] = await Promise.all([
    loadMindState(ctx.env, agentId, "discord"),
    // The session narrative's TEXT, which is NOT what the contract carries. MindState holds the `full_ref`
    // (a vault path); the wire holds the prose. Both are `string | null`, so nothing but this comment and
    // the adapter's `extras` boundary stops a bot printing a file path where the last session's story goes.
    ctx.env.DB.prepare(
      // 'session' OR 'day' -- see the sibling read above and continuity.ts loadSessionNarrative.
      "SELECT id, full_ref FROM synthesis_summary WHERE summary_type IN ('session', 'day') AND companion_id = ? AND full_ref IS NOT NULL ORDER BY COALESCE(session_created_at, created_at) DESC LIMIT 1"
    ).bind(agentId).first<{ id: string; full_ref: string }>()
      .then(row => row?.full_ref ? sbRead(ctx.env, row.full_ref).then(t => t ? { content: t, id: row.id } : null) : null)
      .catch(() => null),
    semanticSearch(ctx.env, `companion state presence recent context ${agentId}`).catch(() => null),
    semanticSearch(ctx.env, `${agentId} history background origin memory`).catch(() => null),
  ]);

  // ── Note surfacing: the bot's own policy, kept here on purpose ───────────────────────────────────────
  // Two hottest/highest-salience from the recency window, PLUS one reserved slot for a note the companion
  // has never been shown -- drawn from the whole live pool, because the recency window cannot supply an
  // unseen note once all of it is warm. That reserved slot is why this is not a pure projection: it is a
  // deliberate anti-saturation rail, and it was added after prod showed cypher 43/138 notes pinned at
  // HEAT_MAX with 93 never accessed once.
  const coreNotes = [...ms.continuity.recent_notes]
    .sort((a, b) => (b.salience === "high" ? 1 : 0) - (a.salience === "high" ? 1 : 0) || (b.heat ?? 0) - (a.heat ?? 0))
    .slice(0, 2);
  const seenIds = new Set(coreNotes.map(n => n.note_id));
  const noveltyNote = await ctx.env.DB.prepare(
    `SELECT note_id, content FROM wm_continuity_notes
     WHERE agent_id = ? AND archived = 0 AND salience = 'high'
     ORDER BY (last_access_at IS NOT NULL), last_access_at ASC, created_at DESC LIMIT 1`
  ).bind(agentId).first<{ note_id: string; content: string }>()
    .catch(() => null);
  const surfacedNotes = [
    ...coreNotes,
    ...(noveltyNote && !seenIds.has(noveltyNote.note_id) ? [noveltyNote as typeof coreNotes[number]] : []),
  ];
  // Each surfaced note carries the CONVERSATION it came from, not the room it was said in -- a Discord
  // note's thread_key is a channel id, and 659 notes sharing one value is not a grouping. Fails soft: no
  // provenance means the content returns unchanged, so the wire format stays string[].
  const provenance = await resolveNoteProvenance(ctx.env, surfacedNotes.map(n => n.note_id).filter(Boolean));
  const continuity_notes = surfacedNotes
    .map(n => annotateNote(String(n.content ?? "").slice(0, 200), provenance.get(n.note_id)))
    .filter(Boolean);

  // ── Writes: every one gated on !readOnly ────────────────────────────────────────────────────────────
  // SURFACE_BUMP, not the deliberate-recall bump: being SHOWN a note is not reaching for it, and the read
  // must not write the ranking that chose it.
  const warmIds = surfacedNotes.map(n => n.note_id).filter(Boolean);
  if (!opts.readOnly && warmIds.length > 0) {
    await ctx.env.DB.prepare(warmSql("wm_continuity_notes", "note_id", warmIds.length, SURFACE_BUMP)).bind(...warmIds).run()
      .catch(e => console.warn("[bot-orient] note warm failed (non-fatal):", e));
  }
  if (!opts.readOnly && synthRow?.id) {
    await ctx.env.DB.prepare(warmSql("synthesis_summary", "id", 1, SURFACE_BUMP)).bind(synthRow.id).run()
      .catch(e => console.warn("[bot-orient] synthesis warm failed (non-fatal):", e));
  }
  // Skipped under readOnly: a parity sample must not mark Raziel's answers as delivered to a companion that
  // never saw them.
  if (!opts.readOnly) {
    await markAnswersDelivered(ctx.env, ms.oversight.answered_questions.map((a: { id: string }) => a.id)).catch((e: unknown) => {
      console.error("[bot-orient] markAnswersDelivered failed:", String(e));
    });
  }

  const parseExcerpts = (raw: string | null, n: number, dated: boolean): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { chunks?: Array<{ chunk_text?: string; text?: string }> };
      const chunks = parsed?.chunks ?? [];
      return dated
        // Dated chunks get a relative-age prefix so the date survives the slice -- an excerpt with no age
        // reads as present-tense news.
        ? chunks.slice(0, 3).map(c => excerptWithAge(c as HistoryChunk, n)).filter(Boolean)
        : chunks.slice(0, 3).map(c => String(c.chunk_text ?? c.text ?? "").slice(0, n)).filter(Boolean);
    } catch { return [raw.slice(0, n)]; }
  };

  const data = botWireFromMindState(
    ms,
    {
      synthesis_summary: sbExtractContent(synthRow?.content ?? null),
      rag_excerpts: parseExcerpts(ragRaw, 250, false),
      history_excerpts: parseExcerpts(historyRaw, 250, true),
      continuity_notes,
      owner: ctx.env.SYSTEM_OWNER,
    },
    agentId,
  );

  return {
    data,
    meta: {
      operation: "halseth_bot_orient",
      unaccepted_growth: ms.growth.clearing_count,
      active_conclusions: ms.beliefs.conclusions.length,
      preferences: ms.identity.preferences.length,
      standing_refusals: ms.identity.refusals.length,
      open_drifts: ms.growth.drifts_open.length,
      answered_questions: ms.oversight.answered_questions.length,
      recent_witness: ms.relational.recent_witness.length,
    },
  };
}
