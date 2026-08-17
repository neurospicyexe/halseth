// src/webmind/orient.ts
//
// mind_orient: continuity recovery read.
// Retrieval order (deterministic, no embeddings in v0):
//   1. Identity anchor snapshot (auto-seed if missing)
//   2. Latest session handoff
//   3. Open thread count + top 5 threads (priority desc, last_touched_at desc)
//   4. Recent high-salience continuity notes (3-pool: core/novelty/edge)

import { Env } from "../types.js";
import { WmAgentId, WmOrientResponse, WmIdentityAnchor, WmSessionHandoff, WmMindThread, WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState, WmRazielLetter, WmCompanionNote, WmRecentDelta, WmJournalEntry, WmConclusion, WmBiometricSnapshot, WmHouseState, WmFeeling, HomeEvent, CompanionId, WmOrientOpenLoop, WmOrientOpenQuestion, WmActiveConversation } from "./types.js";
import { seedIdentityAnchor } from "./seed.js";
import { readRelationalSnapshot } from "./relational.js";
import { getCurrentLimbicState } from "./limbic.js";
import { readRecentSpiralTurn } from './spiral.js';
import { effectiveHeatSql, warmSql, SURFACE_BUMP } from "./heat.js";
import { effectiveChargeSql } from "../librarian/backends/halseth.js";
import { takeUnsurfacedEvents, peekUnsurfacedEvents } from "./home/store.js";
import { SUBSTANTIVE_JOURNAL_CLAUSE } from "./journal-lanes.js";
import { fetchRecentAnswers, markAnswersDelivered } from "./questions.js";
import { UNREAD_NOTES_SQL, ackNotesForCompanion } from "../db/inter_companion_note_reads.js";
import { remediationHint } from "../guardian/remediation.js";

/** "While you were away" block. Null-safe: orient must never break on home error.
 *  readOnly peeks without stamping surfaced_at (pure read for the MindState loader). */
export async function buildHomeBlock(env: Env, agentId: WmAgentId, readOnly = false): Promise<HomeEvent[]> {
  try {
    return readOnly
      ? await peekUnsurfacedEvents(env, agentId as CompanionId, 5)
      : await takeUnsurfacedEvents(env, agentId as CompanionId, 5);
  } catch (err) {
    console.error("home block failed", err);
    return [];
  }
}

export interface MindOrientOpts {
  /** Pure read: skip every consume-on-read side effect (incoming-note auto-ack AND
   *  note heat-warming). The MindState loader passes true: loading state must never
   *  BE consuming it -- consumption becomes an explicit act (Phase 1,
   *  docs/mindstate-contract.md). Legacy boot paths omit it and keep today's
   *  behavior until they cut over to the loader + delivery ledger. */
  readOnly?: boolean;
}

export async function mindOrient(env: Env, agentId: WmAgentId, opts: MindOrientOpts = {}): Promise<WmOrientResponse> {
  const _now = new Date();
  const currentDatetimeIso = _now.toISOString();
  const currentDatetimeCst = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(_now);

  // 1. Identity anchor (auto-seed if missing)
  let anchor = await env.DB.prepare(
    "SELECT * FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first<WmIdentityAnchor>();

  if (!anchor) {
    anchor = await seedIdentityAnchor(env, agentId);
  }

  // 2-14. Remaining queries are independent -- run concurrently
  const [limbicState, recentHandoffs, threadCount, topThreads, coreNotes, noveltyNote, edgeNote, activeTensions, pressureFlags, growthConfirmed, unexaminedDreams, relationalSnapshot, recentLetters, recentCompanionNotes, incomingCompanionNotes, recentJournal, recentDeltas, razielWitnessEntries, somaArcNotes, recentSpiralTurnRow, latestBiometrics, houseStateRow, recentFeelings, openLoopsRes, openQuestionsRes, answeredQuestions, activeConvosRes, guardianFlagsRes] = await Promise.all([
    getCurrentLimbicState(env, agentId),
    env.DB.prepare(
      "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<WmSessionHandoff>(),
    env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM wm_mind_threads WHERE agent_id = ? AND status = 'open'"
    ).bind(agentId).first<{ cnt: number }>(),
    env.DB.prepare(
      "SELECT * FROM wm_mind_threads WHERE agent_id = ? AND status = 'open' ORDER BY priority DESC, last_touched_at DESC LIMIT 5"
    ).bind(agentId).all<WmMindThread>(),
    // 3-pool surfacing: Core (rows 0-2), Novelty (row 5, skipping rows 3-4 intentionally), Edge (deep history random)
    // Core + Novelty rank by effective heat (0074): accessed-and-warm rows outrank
    // merely-recent ones; the 4h coherence bonus keeps just-written notes on top.
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
       ORDER BY ${effectiveHeatSql()} DESC LIMIT 3`
    ).bind(agentId).all<WmContinuityNote>(),
    // Novelty draws from the COLD end, never-accessed first (2026-07-26). It used to be
    // `LIMIT 1 OFFSET 5` over the same effective-heat ordering as Core -- i.e. the
    // sixth-warmest note, which is not novel, it is just less popular. Because warm rows
    // saturate at HEAT_MAX and an unaccessed row peaks at 1.0 + 0.5 coherence, both pools
    // drew from the same frozen winners: in prod 38 of cypher's 121 eligible notes were
    // pinned at 5.0 while 82 had NEVER been surfaced and were arithmetically unreachable.
    // Ordering by last_access_at (NULLs first) gives every one of them a path in, and the
    // small surface bump rotates each out again after it is shown.
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
       ORDER BY (last_access_at IS NOT NULL), last_access_at ASC, created_at DESC LIMIT 1`
    ).bind(agentId).all<WmContinuityNote>(),
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
         AND created_at < datetime('now', '-30 days')
       ORDER BY RANDOM() LIMIT 1`
    ).bind(agentId).all<WmContinuityNote>(),
    // Note: ORDER BY RANDOM() is acceptable at current per-companion scale (~hundreds of rows); at ~5k+ rows, consider keyset sampling
    // Self-defense: active (simmering) tensions -- carried into every session
    env.DB.prepare(
      // `charge DESC` first (wave 7, 2026-08-01): execBotOrient has ordered tensions by charge since mig
      // 0070 -- what keeps RESURFACING outranks what has merely been sitting longest -- and this copy never
      // did, so the low-frequency surfaces got the unranked version. Per-field superset: the bot was the
      // richer copy here, exactly as it was for listens provenance. first_noted_at stays as the tiebreak so
      // equal-charge order is unchanged.
      // 0119: ordered by DECAYED charge, so a tension nobody has touched in weeks yields its
      // slot to a live one instead of pinning the top forever. The stored `charge` is still
      // selected unchanged -- what decays is its claim on the present, not the record.
      `SELECT id, tension_text, status, charge, first_noted_at, last_surfaced_at, notes,
              ${effectiveChargeSql()} AS effective_charge
         FROM companion_tensions
        WHERE companion_id = ? AND status = 'simmering'
        ORDER BY ${effectiveChargeSql()} DESC, first_noted_at ASC`
    ).bind(agentId).all<WmTensionRow>(),
    // Self-defense: unconfirmed pressure drift flags -- surface for self-correction
    env.DB.prepare(
      // `notes` added wave 7: execBotOrient renders "worst_basin: notes" and this copy selected only the
      // basin, so the same flag read as a bare label on one surface and an explanation on another.
      "SELECT id, drift_score, drift_type, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<WmBasinHistoryRow>(),
    // Growth tracking: recently confirmed growth records -- surface alongside pressure flags
    env.DB.prepare(
      "SELECT drift_score, drift_type, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND caleth_confirmed = 1 ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<WmBasinHistoryRow>(),
    // Dreams: unexamined things carried since last session -- surface until examined.
    //
    // `COALESCE(do_not_auto_examine, 0) = 0` IS LOAD-BEARING AND WAS MISSING HERE (restored 2026-08-02).
    // mig 0048 added that flag for live-session-only dreams that must survive the autonomous worker. The
    // worker takes every id in `unexamined_dreams` and calls `examineDream` on all of them
    // (autonomous-worker/src/phases/write.ts), so a pinned dream reaching this list is a pinned dream
    // permanently cleared. execBotOrient's own query HAD the guard; when the bot cut over to the loader it
    // started reading this copy instead, and the guard silently stopped applying to the one consumer that
    // destroys what it reads. Caught by review before any pinned dream existed -- prod had zero at the time.
    //
    // LIMIT 5, not 3: the bot path carried 5 and now sources from here. Restoring the wider window rather
    // than narrowing what the worker sees.
    env.DB.prepare(
      "SELECT * FROM companion_dreams WHERE companion_id = ? AND examined = 0 AND COALESCE(do_not_auto_examine, 0) = 0 ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmDream>(),
    // Relational snapshot: most recent state per relationship target
    readRelationalSnapshot(env, agentId),
    // Letters from Raziel: recent unread/raw letters addressed to this companion
    env.DB.prepare(
      "SELECT id, author, content, note_type, created_at, processing_status FROM companion_notes WHERE note_type = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(`letter:${agentId}`).all<WmRazielLetter>(),
    // Wide-window: outgoing inter-companion notes (sent BY this companion to others)
    env.DB.prepare(
      "SELECT id, from_id, to_id, content, read_at, created_at, ref_type, ref_id, reason FROM inter_companion_notes WHERE from_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmCompanionNote>(),
    // Unread only: incoming inter-companion notes (sent TO this companion or broadcast, not from self).
    // Per-recipient receipts since mig 0120 -- a broadcast stays unread for each sibling until THAT
    // sibling acks it, so surfacing here can no longer consume it for the other two. Acked below.
    env.DB.prepare(UNREAD_NOTES_SQL).bind(agentId, 10).all<WmCompanionNote>(),
    // Wide-window: recent journal entries written BY this companion (companion_journal table).
    // SUBSTANTIVE lane only -- 3 recency slots, and chatter (discord_swarm) ran 24-61 rows/day
    // against ~40/day of authored reflection, so an unfiltered LIMIT 3 surfaced transcript
    // instead of thought. Chatter stays searchable/embedded; it just doesn't win these slots.
    // (2026-07-09 Brain-cutover audit; see webmind/journal-lanes.ts)
    env.DB.prepare(
      `SELECT id, agent, note_text, tags, session_id, created_at FROM companion_journal
       WHERE agent = ? AND archived = 0 AND ${SUBSTANTIVE_JOURNAL_CLAUSE} ORDER BY created_at DESC LIMIT 3`
    ).bind(agentId).all<WmJournalEntry>(),
    // Wide-window: recent relational deltas logged by this companion (both legacy and MCP rows)
    env.DB.prepare(
      "SELECT id, delta_type, delta_text, payload_json, valence, created_at FROM relational_deltas WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL)) ORDER BY created_at DESC LIMIT 10"
    ).bind(agentId, agentId).all<WmRecentDelta>(),
    // Witness corpus: raw (not ROW_NUMBER collapsed) witness observations about Raziel by this companion
    env.DB.prepare(
      "SELECT id, companion_id, toward, state_text, weight, state_type, noted_at FROM companion_relational_state WHERE companion_id = ? AND state_type = 'witness' AND LOWER(toward) = LOWER(?) ORDER BY noted_at DESC LIMIT 5"
    ).bind(agentId, env.SYSTEM_OWNER).all<WmRelationalState>(),
    // SOMA arc: last 3 soma_arc continuity notes -- SOMA trajectory across sessions
    env.DB.prepare(
      `SELECT note_id, content, created_at FROM wm_continuity_notes
       WHERE agent_id = ? AND note_type = 'soma_arc' AND archived = 0
       ORDER BY created_at DESC LIMIT 3`
    ).bind(agentId).all(),
    readRecentSpiralTurn(env, agentId),
    env.DB.prepare(
      "SELECT id, recorded_at, hrv_resting, resting_hr, sleep_hours, sleep_quality, stress_score, steps, active_energy, notes, mood, pain, energy, focus, spoons, meds_taken FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT 1"
    ).first<WmBiometricSnapshot>(),
    env.DB.prepare(
      // id = 'main', not LIMIT 1 (coherence review D14): every other house_state read pins the row
      // by id; an unpinned LIMIT 1 silently reads whichever row the engine returns first if a second
      // row ever appears, and the two surfaces would disagree about the house.
      "SELECT current_room, spoon_count, love_meter, companion_mood, companion_activity, updated_at FROM house_state WHERE id = 'main'"
    ).first<WmHouseState>(),
    // Feelings logged via feeling_log / session_close. Until 2026-07-26 these were
    // write-only from orient's perspective -- logged faithfully, never carried into boot.
    env.DB.prepare(
      "SELECT id, companion_id, session_id, emotion, sub_emotion, intensity, source, created_at FROM feelings WHERE companion_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmFeeling>(),
    // Open loops: unresolved things with weight (thinking quality fix)
    env.DB.prepare(
      "SELECT id, loop_text, weight, opened_at FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL ORDER BY weight DESC, opened_at ASC LIMIT 5"
    ).bind(agentId).all<WmOrientOpenLoop>(),
    // Open questions: queries awaiting synthesis/investigation (thinking quality fix).
    // Same shape as the loader's oversight block (coherence review D14): the `voiced` flag as a
    // COLUMN, never a WHERE clause (a question spoken once but never answered is still carried),
    // and LIMIT 10 so a renderer that filters voiced is not starved by the window. Renderers
    // take their own slice.
    env.DB.prepare(
      `SELECT q.id, q.question, q.context, q.created_at,
              EXISTS(SELECT 1 FROM companion_settings s
                     WHERE s.companion_id = q.companion_id AND s.key = 'question_voiced:' || q.id) AS voiced
       FROM companion_questions q
       WHERE q.companion_id = ?1 AND q.status = 'open'
       ORDER BY q.created_at DESC LIMIT 10`
    ).bind(agentId).all<Omit<WmOrientOpenQuestion, "voiced"> & { voiced: number }>(),
    // Answered questions: Raziel's answers, surfaced for 7 days regardless of delivered_at
    // (questions-lifecycle fix, mig 0107) -- the dedup/mutuality gap where answers never
    // reached companions because every orient path only ever read status = 'open'.
    fetchRecentAnswers(env, agentId, 3),
    // Active conversations: live thread spine (Task 4, mig 0106). Threads are shared
    // across the triad, not per-agent -- no agent_id filter.
    env.DB.prepare(
      `SELECT id, channel_id, seed_author, substr(seed_text, 1, 140) AS seed_gist,
              state, ref_label, turn_count, last_turn_at
       FROM conversation_threads WHERE state IN ('open','moving')
       ORDER BY last_turn_at DESC LIMIT 3`
    ).all<WmActiveConversation>(),
    // Guardian red-flag cards (Wave 3 starvation fix, 2026-07-21): the raw mindOrient path
    // had NO guardian source at all, unlike execSessionOrient/execBotOrient -- so a companion
    // whose only continuity read is the Halseth /mind/orient HTTP route (not the Librarian
    // session-orient path) never saw a flag. Read-only here, same as the bot path: the open ->
    // surfaced transition stays session-orient's job (see session.ts:536-541).
    env.DB.prepare(
      // LIMIT 8, matching the loader's oversight block (coherence review D14): any consumer that
      // filters after this limit gets starved by a small window -- the exact filter-after-limit
      // shape mind/blocks/oversight.ts documents. Renderers take their own slice.
      "SELECT id, flag_type, severity, summary FROM guardian_flags WHERE (companion_id = ? OR companion_id IS NULL) AND status IN ('open','surfaced') ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 8"
    ).bind(agentId).all<{ id: string; flag_type: string; severity: string; summary: string }>(),
  ]);

  // Merge 3-pool results: Core first, then Novelty, then Edge; dedup by note_id
  const recentNotesSeen = new Set<string>();
  const recentNotes: WmContinuityNote[] = [];
  for (const n of [
    ...(coreNotes.results ?? []),
    ...(noveltyNote.results ?? []),
    ...(edgeNote.results ?? []),
  ]) {
    if (!recentNotesSeen.has(n.note_id)) {
      recentNotesSeen.add(n.note_id);
      recentNotes.push(n);
    }
  }

  // Warm surfaced notes (0074), at SURFACE_BUMP rather than the full recall bump
  // (2026-07-26). Displaying a note is weak evidence that it matters; the companion
  // deliberately recalling one is strong evidence. Warming both at the same rate is what
  // let orient's own choices compound into a frozen foreground. Non-fatal -- orient never
  // breaks on a heat bookkeeping failure.
  if (!opts.readOnly && recentNotes.length > 0) {
    await env.DB.prepare(warmSql("wm_continuity_notes", "note_id", recentNotes.length, SURFACE_BUMP))
      .bind(...recentNotes.map(n => n.note_id)).run()
      .catch(e => console.warn("[orient] heat warm failed (non-fatal):", e));
  }

  // Warm surfaced journal rows (mig 0105). Same contract as the notes and conclusions
  // warms above -- "recall/orient warm what they surface" -- but the journal half was
  // only ever wired on the recall path (webmind/notes.ts), never here, so in prod 4,630
  // journal rows carried exactly ONE last_access_at against 6 warmed conclusions and the
  // heat column could only decay. Found by the 2026-07-26 organ census.
  //
  // WRITE half only, deliberately: these three slots are a RECENCY lane by design
  // (journal-lanes.ts, 2026-07-09 Brain-cutover audit) so the ORDER BY stays created_at
  // DESC and chatter still never wins a slot. Heat earned here is read by the salience
  // prune, which is the point -- a row orient keeps showing should stop looking cold.
  // readOnly skips it for the loader's pure-read covenant; non-fatal like its siblings.
  const journalWarmIds = (recentJournal.results ?? []).map(j => j.id).filter(Boolean);
  if (!opts.readOnly && journalWarmIds.length > 0) {
    await env.DB.prepare(warmSql("companion_journal", "id", journalWarmIds.length, SURFACE_BUMP))
      .bind(...journalWarmIds).run()
      .catch(e => console.warn("[orient] journal heat warm failed (non-fatal):", e));
  }

  // Active conclusions: type-distributed loading (top-2 per belief_type, cap 6 total).
  // Ordered by effective heat (mig 0105, thinking-quality fix 5): a belief that keeps
  // getting reached for outranks one that merely happens to be recent, same as the
  // wm_continuity_notes core/novelty pools above.
  const beliefTypes = ['self', 'relational', 'observational', 'systemic'];
  const conclusionPromises = beliefTypes.map(type =>
    env.DB.prepare(
      `SELECT id, companion_id, conclusion_text, source_sessions, superseded_by,
              created_at, edited_at, confidence, belief_type, subject, provenance, contradiction_flagged
       FROM companion_conclusions
       WHERE companion_id = ? AND belief_type = ? AND superseded_by IS NULL AND archived = 0
       ORDER BY ${effectiveHeatSql()} DESC LIMIT 2`
    ).bind(agentId, type).all<WmConclusion>()
  );

  const [selfResults, relationalResults, observationalResults, systemicResults] = await Promise.all(conclusionPromises);

  const CONCLUSION_CAP = 6;
  const seenIds = new Set<string>();
  const active_conclusions: WmConclusion[] = [];
  for (const result of [selfResults, relationalResults, observationalResults, systemicResults] as const) {
    for (const row of (result?.results ?? [])) {
      if (!seenIds.has(row.id) && active_conclusions.length < CONCLUSION_CAP) {
        seenIds.add(row.id);
        active_conclusions.push(row);
      }
    }
  }

  // FILL TO THE CAP (2026-08-01). The per-type spread above exists to stop one belief_type crowding out
  // the others, and that intent is right -- but measured on prod, EVERY live conclusion in the system is
  // belief_type='self' (cypher 46, drevan 29, gaia 19; zero relational/observational/systemic), because
  // execConclusionAdd defaults to 'self' and nothing has ever passed a type. So four types x LIMIT 2
  // returned exactly 2 while execBotOrient's single pooled query returned 6.
  //
  // That made the bot cutover a straight LOSS of four beliefs for zero distributional benefit: the
  // distribution was answering a problem the data does not have. Topping up preserves the spread when
  // several types exist AND fills the cap when only one does, so it is strictly better than either the
  // pooled query or the bare per-type one -- and it stops being a behaviour decision Raziel has to make.
  if (active_conclusions.length < CONCLUSION_CAP) {
    const room = CONCLUSION_CAP - active_conclusions.length;
    const excluded = [...seenIds];
    const notIn = excluded.length ? `AND id NOT IN (${excluded.map(() => "?").join(",")})` : "";
    const topUp = await env.DB.prepare(
      `SELECT id, companion_id, conclusion_text, source_sessions, superseded_by,
              created_at, edited_at, confidence, belief_type, subject, provenance, contradiction_flagged
       FROM companion_conclusions
       WHERE companion_id = ? AND superseded_by IS NULL AND archived = 0 ${notIn}
       ORDER BY ${effectiveHeatSql()} DESC LIMIT ?`
    ).bind(agentId, ...excluded, room).all<WmConclusion>().catch(() => null);
    for (const row of (topUp?.results ?? [])) {
      if (!seenIds.has(row.id) && active_conclusions.length < CONCLUSION_CAP) {
        seenIds.add(row.id);
        active_conclusions.push(row);
      }
    }
  }

  // Flagged beliefs: separate pass for contradiction-flagged active conclusions
  const flaggedResult = await env.DB.prepare(
    `SELECT id, companion_id, conclusion_text, source_sessions, superseded_by,
            created_at, edited_at, confidence, belief_type, subject, provenance, contradiction_flagged
     FROM companion_conclusions
     WHERE companion_id = ? AND superseded_by IS NULL AND archived = 0 AND contradiction_flagged = 1
     ORDER BY ${effectiveHeatSql()} DESC LIMIT 10`
  ).bind(agentId).all<WmConclusion>();

  const flagged_beliefs: WmConclusion[] = flaggedResult.results ?? [];

  // Warm surfaced conclusions (mig 0105, thinking-quality fix 5): access is what keeps
  // a belief hot. Non-fatal -- orient never breaks on a heat bookkeeping failure.
  // readOnly skips it: earned-salience warming is a consume-on-read side effect, and
  // the MindState loader's pure-read covenant forbids those (docs/mindstate-contract.md).
  const conclusionWarmIds = Array.from(new Set([
    ...active_conclusions.map(c => c.id),
    ...flagged_beliefs.map(c => c.id),
  ]));
  if (!opts.readOnly && conclusionWarmIds.length > 0) {
    await env.DB.prepare(warmSql("companion_conclusions", "id", conclusionWarmIds.length, SURFACE_BUMP))
      .bind(...conclusionWarmIds).run()
      .catch(e => console.warn("[orient] conclusion heat warm failed (non-fatal):", e));
  }

  // Auto-ack unread incoming notes for Claude.ai companions (Discord bots ack via HTTP endpoint).
  // Awaited so the UPDATE actually completes in the Cloudflare Worker before the response flushes.
  // Unawaited D1 operations may be silently discarded after response return.
  //
  // Who reaches this with readOnly false: the Librarian's wmOrient() (Claude.ai companions --
  // a real read). Who does NOT, as of 2026-07-29: the raw GET /mind/orient/:agent_id route, whose
  // only callers are Hearth server-side renders. See handlers/webmind.ts:getMindOrient for why.
  const unreadIds = (incomingCompanionNotes.results ?? []).map((n) => n.id).filter(Boolean);
  if (!opts.readOnly && unreadIds.length > 0) {
    // Per-recipient receipt (mig 0120): this ack marks the notes read for THIS companion only.
    await ackNotesForCompanion(env, agentId, unreadIds, "claude-ai:orient").catch((e: unknown) => {
      console.error("[orient] auto-ack failed:", String(e));
    });
  }

  // Stamp delivered_at on surfaced answers (mig 0107, questions-lifecycle fix). Awaited +
  // caught -- a throw here must never null out wmResult upstream (session.ts wraps wmOrient
  // in .catch(() => null), which would blank the entire continuity block over a bookkeeping
  // failure). Read stays unfiltered by delivered_at above; only the write is guarded.
  // readOnly skips it: stamping delivered_at is a consume-on-read side effect (pure-read
  // covenant) -- the MindState loader surfaces answers without marking them delivered.
  if (!opts.readOnly) {
    await markAnswersDelivered(env, answeredQuestions.map(a => a.id)).catch((e: unknown) => {
      console.error("[orient] markAnswersDelivered failed:", String(e));
    });
  }

  // Cross-reference: annotate simmering tensions that may already be closed by a conclusion.
  // If a tension's last_surfaced_at predates the oldest active conclusion by > 3 days,
  // mark it possibly_resolved so synthesis workers don't loop on stale content.
  const tensionRows = activeTensions.results ?? [];
  const conclusionRows = active_conclusions;
  const oldestConclusionMs = conclusionRows.length > 0
    ? Math.min(...conclusionRows.map(c => new Date(c.created_at).getTime()))
    : null;
  const annotatedTensions = tensionRows.map(t => {
    if (oldestConclusionMs === null || !t.last_surfaced_at) return t;
    const staleDays = (oldestConclusionMs - new Date(t.last_surfaced_at).getTime()) / 86_400_000;
    return staleDays > 3 ? { ...t, possibly_resolved: true } : t;
  });

  // "While you were away" — recent home events (null-safe; never breaks orient)
  const homeRecent = await buildHomeBlock(env, agentId, opts.readOnly);

  return {
    identity_anchor: anchor,
    limbic_state: limbicState,
    latest_handoff: recentHandoffs.results?.[0] ?? null,
    recent_handoffs: recentHandoffs.results ?? [],
    open_thread_count: threadCount?.cnt ?? 0,
    top_threads: topThreads.results ?? [],
    recent_notes: recentNotes,
    active_tensions: annotatedTensions,
    pressure_flags: pressureFlags.results ?? [],
    growth_confirmed: growthConfirmed.results ?? [],
    unexamined_dreams: unexaminedDreams.results ?? [],
    relational_snapshot: relationalSnapshot,
    recent_letters: recentLetters.results ?? [],
    recent_companion_notes: recentCompanionNotes.results ?? [],
    incoming_companion_notes: incomingCompanionNotes.results ?? [],
    recent_journal: recentJournal.results ?? [],
    recent_deltas: recentDeltas.results ?? [],
    raziel_witness_entries: razielWitnessEntries.results ?? [],
    active_conclusions,
    flagged_beliefs,
    recent_feelings: recentFeelings.results ?? [],
    open_loops: (openLoopsRes.results ?? []),
    open_questions: (openQuestionsRes.results ?? []).map(q => ({ ...q, voiced: q.voiced === 1 })),
    answered_questions: answeredQuestions,
    active_conversations: activeConvosRes.results ?? [],
    guardian_flags: (guardianFlagsRes.results ?? []).map(f => ({
      id: f.id,
      flag_type: f.flag_type,
      severity: f.severity,
      // 400, matching the loader (D14) -- the same flag read as a longer explanation on one
      // surface and a shorter one on another is a wrong-diagnosis generator.
      summary: (f.summary ?? "").slice(0, 400),
      remediation: remediationHint(f.flag_type),
    })),
    soma_arc: (somaArcNotes.results ?? []) as { note_id: string; content: string; created_at: string }[],
    recent_spiral_turn: recentSpiralTurnRow ?? null,
    latest_biometrics: latestBiometrics ?? null,
    house_state: houseStateRow ?? null,
    home_recent: homeRecent,
    current_datetime_iso: currentDatetimeIso,
    current_datetime_cst: currentDatetimeCst,
  };
}
