// src/webmind/orient.ts
//
// mind_orient: continuity recovery read.
// Retrieval order (deterministic, no embeddings in v0):
//   1. Identity anchor snapshot (auto-seed if missing)
//   2. Latest session handoff
//   3. Open thread count + top 5 threads (priority desc, last_touched_at desc)
//   4. Recent high-salience continuity notes (3-pool: core/novelty/edge)

import { Env } from "../types.js";
import { WmAgentId, WmOrientResponse, WmIdentityAnchor, WmSessionHandoff, WmMindThread, WmContinuityNote, WmTensionRow, WmBasinHistoryRow, WmDream, WmRelationalState, WmRazielLetter, WmCompanionNote, WmRecentDelta, WmJournalEntry, WmConclusion } from "./types.js";
import { seedIdentityAnchor } from "./seed.js";
import { readRelationalSnapshot } from "./relational.js";
import { getCurrentLimbicState } from "./limbic.js";
import { readRecentSpiralTurn } from './spiral.js';

export async function mindOrient(env: Env, agentId: WmAgentId): Promise<WmOrientResponse> {
  // 1. Identity anchor (auto-seed if missing)
  let anchor = await env.DB.prepare(
    "SELECT * FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first<WmIdentityAnchor>();

  if (!anchor) {
    anchor = await seedIdentityAnchor(env, agentId);
  }

  // 2-14. Remaining queries are independent -- run concurrently
  const [limbicState, recentHandoffs, threadCount, topThreads, coreNotes, noveltyNote, edgeNote, activeTensions, pressureFlags, growthConfirmed, unexaminedDreams, relationalSnapshot, recentLetters, recentCompanionNotes, incomingCompanionNotes, recentJournal, recentDeltas, razielWitnessEntries, somaArcNotes, recentSpiralTurnRow] = await Promise.all([
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
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
       ORDER BY created_at DESC LIMIT 3`
    ).bind(agentId).all<WmContinuityNote>(),
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
       ORDER BY created_at DESC LIMIT 1 OFFSET 5`
    ).bind(agentId).all<WmContinuityNote>(),
    // Note: Novelty returns empty when fewer than 6 qualifying rows exist (new/sparse agents fall back to Core-only)
    env.DB.prepare(
      `SELECT * FROM wm_continuity_notes
       WHERE agent_id = ? AND salience = 'high' AND note_type NOT IN ('soma_arc', 'spiral_turn') AND archived = 0
         AND created_at < datetime('now', '-30 days')
       ORDER BY RANDOM() LIMIT 1`
    ).bind(agentId).all<WmContinuityNote>(),
    // Note: ORDER BY RANDOM() is acceptable at current per-companion scale (~hundreds of rows); at ~5k+ rows, consider keyset sampling
    // Self-defense: active (simmering) tensions -- carried into every session
    env.DB.prepare(
      "SELECT id, tension_text, status, first_noted_at, last_surfaced_at, notes FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY first_noted_at ASC"
    ).bind(agentId).all<WmTensionRow>(),
    // Self-defense: unconfirmed pressure drift flags -- surface for self-correction
    env.DB.prepare(
      "SELECT drift_score, drift_type, worst_basin, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'pressure' AND caleth_confirmed = 0 ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<WmBasinHistoryRow>(),
    // Growth tracking: recently confirmed growth records -- surface alongside pressure flags
    env.DB.prepare(
      "SELECT drift_score, drift_type, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND caleth_confirmed = 1 ORDER BY recorded_at DESC LIMIT 3"
    ).bind(agentId).all<WmBasinHistoryRow>(),
    // Dreams: unexamined things carried since last session -- surface until examined
    env.DB.prepare(
      "SELECT * FROM companion_dreams WHERE companion_id = ? AND examined = 0 ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<WmDream>(),
    // Relational snapshot: most recent state per relationship target
    readRelationalSnapshot(env, agentId),
    // Letters from Raziel: recent unread/raw letters addressed to this companion
    env.DB.prepare(
      "SELECT id, author, content, note_type, created_at, processing_status FROM companion_notes WHERE note_type = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(`letter:${agentId}`).all<WmRazielLetter>(),
    // Wide-window: outgoing inter-companion notes (sent BY this companion to others)
    env.DB.prepare(
      "SELECT id, from_id, to_id, content, read_at, created_at FROM inter_companion_notes WHERE from_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(agentId).all<WmCompanionNote>(),
    // Unread only: incoming inter-companion notes (sent TO this companion or broadcast, not from self)
    // read_at IS NULL ensures notes don't repeat across sessions. Auto-acked below after fetch.
    env.DB.prepare(
      "SELECT id, from_id, to_id, content, read_at, created_at FROM inter_companion_notes WHERE (to_id = ? OR to_id IS NULL) AND from_id != ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 10"
    ).bind(agentId, agentId).all<WmCompanionNote>(),
    // Wide-window: recent journal entries written BY this companion (companion_journal table)
    env.DB.prepare(
      "SELECT id, agent, note_text, tags, session_id, created_at FROM companion_journal WHERE agent = ? ORDER BY created_at DESC LIMIT 3"
    ).bind(agentId).all<WmJournalEntry>(),
    // Wide-window: recent relational deltas logged by this companion (both legacy and MCP rows)
    env.DB.prepare(
      "SELECT id, delta_type, delta_text, payload_json, valence, created_at FROM relational_deltas WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL)) ORDER BY created_at DESC LIMIT 10"
    ).bind(agentId, agentId).all<WmRecentDelta>(),
    // Witness corpus: raw (not ROW_NUMBER collapsed) witness observations about Raziel by this companion
    env.DB.prepare(
      "SELECT id, companion_id, toward, state_text, weight, state_type, noted_at FROM companion_relational_state WHERE companion_id = ? AND state_type = 'witness' AND toward = 'raziel' ORDER BY noted_at DESC LIMIT 5"
    ).bind(agentId).all<WmRelationalState>(),
    // SOMA arc: last 3 soma_arc continuity notes -- SOMA trajectory across sessions
    env.DB.prepare(
      `SELECT note_id, content, created_at FROM wm_continuity_notes
       WHERE agent_id = ? AND note_type = 'soma_arc' AND archived = 0
       ORDER BY created_at DESC LIMIT 3`
    ).bind(agentId).all(),
    readRecentSpiralTurn(env, agentId),
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

  // Active conclusions: type-distributed loading (top-2 per belief_type, cap 6 total)
  const beliefTypes = ['self', 'relational', 'observational', 'systemic'];
  const conclusionPromises = beliefTypes.map(type =>
    env.DB.prepare(
      `SELECT id, companion_id, conclusion_text, source_sessions, superseded_by,
              created_at, edited_at, confidence, belief_type, subject, provenance, contradiction_flagged
       FROM companion_conclusions
       WHERE companion_id = ? AND belief_type = ? AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT 2`
    ).bind(agentId, type).all<WmConclusion>()
  );

  const [selfResults, relationalResults, observationalResults, systemicResults] = await Promise.all(conclusionPromises);

  const seenIds = new Set<string>();
  const active_conclusions: WmConclusion[] = [];
  for (const result of [selfResults, relationalResults, observationalResults, systemicResults] as const) {
    for (const row of (result?.results ?? [])) {
      if (!seenIds.has(row.id) && active_conclusions.length < 6) {
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
     WHERE companion_id = ? AND superseded_by IS NULL AND contradiction_flagged = 1
     ORDER BY created_at DESC`
  ).bind(agentId).all<WmConclusion>();

  const flagged_beliefs: WmConclusion[] = flaggedResult.results ?? [];

  // Auto-ack unread incoming notes for Claude.ai companions (Discord bots ack via HTTP endpoint).
  // Fire-and-forget: a failure here doesn't block the orient response.
  const unreadIds = (incomingCompanionNotes.results ?? []).map((n) => n.id).filter(Boolean);
  if (unreadIds.length > 0) {
    const placeholders = unreadIds.map(() => "?").join(", ");
    env.DB.prepare(
      `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`
    ).bind(new Date().toISOString(), ...unreadIds).run().catch((e: unknown) => {
      console.error("[orient] auto-ack failed:", String(e));
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
    soma_arc: (somaArcNotes.results ?? []) as { note_id: string; content: string; created_at: string }[],
    recent_spiral_turn: recentSpiralTurnRow ?? null,
  };
}
