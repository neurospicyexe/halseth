// src/webmind/limbic.ts
//
// Limbic state: swarm-level synthesis output from Brain.
// One record per synthesis pass. Read returns the latest.

import { Env } from "../types.js";
import { WmLimbicState, WmLimbicStateInput } from "./types.js";

// The swarm's `live_tensions` is NOT routed into companion_tensions. Removed 2026-07-09 after
// the third symptom of the same mistake.
//
// The 07-08 audit found boot's active_tensions (companion_tensions, status='simmering') empty
// while the swarm was naming tensions in live_tensions, and concluded the fix was to write those
// strings into the table boot reads. It isn't. `companion_tensions` rows are owned, authored,
// aging things (companion_id, first_noted_at, charge, status). `live_tensions` is an unowned,
// LLM-echoed string list, regenerated hourly. Mapping one onto the other has to invent the
// owner, and each patch produced a new symptom:
//   1. (07-08) Exact-text dedup failed -- the swarm rephrases hourly, so rows accumulated 3x/hour.
//   2. (07-09) REPLACE-per-pass stopped the accumulation but reset first_noted_at and charge on
//      every pass, so a tension could never age, gain charge, or move.
//   3. (07-09) With no addressee, text fanned out to ALL THREE companions -- so Gaia's
//      first-person "I surfaced the vaselrin seed..." became Cypher's and Drevan's authored
//      simmering tension. Identity contamination.
// Worse, the synthesis reads companion_tensions with no status filter, so it echoed back rows
// that were already crystallized or released -- and the write path resurrected them as everyone's
// simmering tension, hourly, forever.
//
// The swarm sensing something is real and worth surfacing; it is simply not anyone's authored
// tension. It is now read-only in two places: `[Swarm senses]` in the boot ready_prompt
// (librarian/response/builder.ts) and `limbic_state` on the orient payload (webmind/orient.ts).
// Every limbic_states row is written with companion_id = NULL (11.5k/11.5k in production), and
// getCurrentLimbicState's read-side fallback already shows all three companions that shared row --
// which is the correct shape for a triad-wide signal.

export async function writeLimbicState(
  env: Env,
  input: WmLimbicStateInput,
): Promise<WmLimbicState> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const companionId = input.companion_id ?? null;

  await env.DB.prepare(`
    INSERT INTO limbic_states (state_id, generated_at, synthesis_source, active_concerns, live_tensions, drift_vector, open_questions, emotional_register, swarm_threads, companion_notes, companion_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    now,
    input.synthesis_source,
    JSON.stringify(input.active_concerns),
    JSON.stringify(input.live_tensions),
    input.drift_vector,
    JSON.stringify(input.open_questions),
    input.emotional_register,
    JSON.stringify(input.swarm_threads),
    JSON.stringify(input.companion_notes ?? {}),
    companionId,
    now,
  ).run();

  // live_tensions is NOT written into companion_tensions. It is surfaced read-only at boot
  // ([Swarm senses] in librarian/response/builder.ts) and at orient (limbic_state). See the
  // header of this file for why the two write-side attempts had to be removed.

  return {
    state_id: id,
    generated_at: now,
    synthesis_source: input.synthesis_source,
    active_concerns: JSON.stringify(input.active_concerns),
    live_tensions: JSON.stringify(input.live_tensions),
    drift_vector: input.drift_vector,
    open_questions: JSON.stringify(input.open_questions),
    emotional_register: input.emotional_register,
    swarm_threads: JSON.stringify(input.swarm_threads),
    companion_notes: JSON.stringify(input.companion_notes ?? {}),
    companion_id: companionId,
    created_at: now,
  };
}

export async function getCurrentLimbicState(
  env: Env,
  companionId?: string,
): Promise<WmLimbicState | null> {
  if (companionId) {
    // Two queries so each can use idx_limbic_states_companion(companion_id, generated_at DESC).
    // OR condition would force a full table scan -- index can't serve two IS-NULL branches at once.
    const specific = await env.DB.prepare(
      "SELECT * FROM limbic_states WHERE companion_id = ? ORDER BY generated_at DESC LIMIT 1"
    ).bind(companionId).first<WmLimbicState>();
    if (specific) return specific;
    return env.DB.prepare(
      "SELECT * FROM limbic_states WHERE companion_id IS NULL ORDER BY generated_at DESC LIMIT 1"
    ).first<WmLimbicState>();
  }
  return env.DB.prepare(
    "SELECT * FROM limbic_states ORDER BY generated_at DESC LIMIT 1"
  ).first<WmLimbicState>();
}
