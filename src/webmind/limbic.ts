// src/webmind/limbic.ts
//
// Limbic state: swarm-level synthesis output from Brain.
// One record per synthesis pass. Read returns the latest.

import { Env } from "../types.js";
import { WmLimbicState, WmLimbicStateInput } from "./types.js";

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
    // Try companion-specific row first; fall back to global (NULL) row
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
