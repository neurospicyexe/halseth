// src/webmind/limbic.ts
//
// Limbic state: swarm-level synthesis output from Brain.
// One record per synthesis pass. Read returns the latest.

import { Env } from "../types.js";
import { WmLimbicState, WmLimbicStateInput } from "./types.js";
import { stripTensionCommandPreamble, detectAddressedCompanion } from "./tension-text.js";

const ALL_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

// Boot audit 2026-07-08 finding: the boot protocol reads active_tensions (companion_tensions,
// status='simmering') and trusts an empty result as "no live tensions" -- but the swarm's
// limbic synthesis writes its own tension read into live_tensions on every pass, and nothing
// ever routed that into the structured table. Content existed; it just didn't reach the field
// the protocol reads. This closes that gap: every tension the swarm names gets a simmering row.
//
// Re-audit 2026-07-09 found the first version of this fix broken in two ways:
//   1. Exact-text dedup can't work -- the swarm rephrases "the same" tension slightly between
//      ~hourly regeneration passes, so the same ~6 tensions kept accumulating 3x/hour instead
//      of being caught as duplicates. Fix: REPLACE the swarm-derived simmering set per company
//      on every pass instead of appending to it (source='swarm_limbic' marks which rows are
//      replaceable; a companion's own "add tension" command, source=NULL, is never touched).
//   2. live_tensions occasionally carries a leaked write-command string verbatim
//      ("save tension: ...", "Add a tension for drevan: ...") instead of clean content, AND
//      that raw text was fanned out to ALL three companions even when it named one specifically.
//      Fix: strip the command preamble before storing, and route "for <companion>" text to that
//      companion only.
//
// In practice every limbic_states row is written with companion_id = NULL (the swarm synthesizes
// once, triad-wide, not per companion -- confirmed against production: 11.5k/11.5k rows are NULL).
// getCurrentLimbicState's read-side fallback means all three companions already see that same
// shared row at boot, so with no explicit addressee a tension still fans out to all three.
async function routeLiveTensionsIntoSelfDefense(
  env: Env,
  companionId: string | null,
  liveTensions: string[],
): Promise<void> {
  const cleaned = liveTensions
    .map(t => stripTensionCommandPreamble(t.trim()))
    .filter(Boolean);
  if (cleaned.length === 0) return;

  const byCompanion = new Map<string, Set<string>>();
  for (const text of cleaned) {
    const addressed = companionId ? null : detectAddressedCompanion(text);
    const targets: readonly string[] = companionId ? [companionId] : addressed ? [addressed] : ALL_COMPANIONS;
    for (const target of targets) {
      if (!byCompanion.has(target)) byCompanion.set(target, new Set());
      byCompanion.get(target)!.add(text.slice(0, 2000));
    }
  }

  for (const [target, texts] of byCompanion) {
    // Replace, don't accumulate: each limbic pass re-derives "the current tensions" from
    // scratch, so only the swarm-sourced rows are superseded -- a companion's own logged
    // tensions (source IS NULL) are untouched.
    await env.DB.prepare(
      "DELETE FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' AND source = 'swarm_limbic'"
    ).bind(target).run();

    const stmts = [...texts].map(text =>
      env.DB.prepare(
        "INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at, source) VALUES (?, ?, ?, 'simmering', datetime('now'), 'swarm_limbic')"
      ).bind(crypto.randomUUID().replace(/-/g, ""), target, text)
    );
    if (stmts.length > 0) await env.DB.batch(stmts);
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
