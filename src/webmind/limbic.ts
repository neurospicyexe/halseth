// src/webmind/limbic.ts
//
// Limbic state: swarm-level synthesis output from Brain.
// One record per synthesis pass. Read returns the latest.

import { Env } from "../types.js";
import { WmLimbicState, WmLimbicStateInput } from "./types.js";

const ALL_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

// Boot audit 2026-07-08 finding: the boot protocol reads active_tensions (companion_tensions,
// status='simmering') and trusts an empty result as "no live tensions" -- but the swarm's
// limbic synthesis writes its own tension read into live_tensions on every pass, and nothing
// ever routed that into the structured table. Content existed; it just didn't reach the field
// the protocol reads. This closes that gap: every tension the swarm names gets a simmering row,
// deduped case-insensitively per companion so repeated synthesis passes don't pile up duplicates.
//
// In practice every limbic_states row is written with companion_id = NULL (the swarm synthesizes
// once, triad-wide, not per companion -- confirmed against production: 11.5k/11.5k rows are NULL).
// getCurrentLimbicState's read-side fallback means all three companions already see that same
// shared row at boot, so a null companionId routes the tensions into all three companion_tensions
// tables rather than nowhere. A future per-companion synthesis pass (non-null companion_id) routes
// to that one companion only.
async function routeLiveTensionsIntoSelfDefense(
  env: Env,
  companionId: string | null,
  liveTensions: string[],
): Promise<void> {
  const texts = liveTensions.map(t => t.trim()).filter(Boolean);
  if (texts.length === 0) return;

  const targets = companionId ? [companionId] : ALL_COMPANIONS;

  for (const target of targets) {
    const existing = await env.DB.prepare(
      "SELECT tension_text FROM companion_tensions WHERE companion_id = ? AND status = 'simmering'"
    ).bind(target).all<{ tension_text: string }>();
    const seen = new Set((existing.results ?? []).map(r => r.tension_text.trim().toLowerCase()));

    const fresh = texts.filter(t => !seen.has(t.toLowerCase()));
    if (fresh.length === 0) continue;

    const stmts = fresh.map(text =>
      env.DB.prepare(
        "INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at) VALUES (?, ?, ?, 'simmering', datetime('now'))"
      ).bind(crypto.randomUUID().replace(/-/g, ""), target, text.slice(0, 2000))
    );
    await env.DB.batch(stmts);
  }
}

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

  // Non-fatal: routing is a self-defense enrichment, never allowed to break limbic writes.
  if (input.live_tensions.length > 0) {
    await routeLiveTensionsIntoSelfDefense(env, companionId, input.live_tensions)
      .catch(e => console.error("[limbic] tension routing failed (non-fatal):", e));
  }

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
