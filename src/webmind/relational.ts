// src/webmind/relational.ts
//
// companion_relational_state: directional relational state toward a specific person.
// Append-only -- each write is a new snapshot, not an update.
// "I feel [x] toward [person]" -- distinct from SOMA floats.

import { Env } from "../types.js";
import { WmAgentId, WmRelationalState, WmRelationalStateInput } from "./types.js";

export async function writeRelationalState(
  env: Env,
  input: WmRelationalStateInput,
): Promise<{ id: string; noted_at: string }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO companion_relational_state (id, companion_id, toward, state_text, weight, state_type, noted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    id,
    input.companion_id,
    input.toward,
    input.state_text,
    input.weight ?? 0.5,
    input.state_type ?? "feeling",
    now,
  ).run();
  return { id, noted_at: now };
}

// Full history for a companion -- recent first, paginated
export async function readRelationalHistory(
  env: Env,
  companionId: WmAgentId,
  opts: { toward?: string; limit?: number } = {},
): Promise<WmRelationalState[]> {
  const limit = opts.limit ?? 20;
  if (opts.toward) {
    const rows = await env.DB.prepare(
      "SELECT * FROM companion_relational_state WHERE companion_id = ? AND toward = ? ORDER BY noted_at DESC LIMIT ?"
    ).bind(companionId, opts.toward, limit).all<WmRelationalState>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM companion_relational_state WHERE companion_id = ? ORDER BY noted_at DESC LIMIT ?"
  ).bind(companionId, limit).all<WmRelationalState>();
  return rows.results ?? [];
}

// Orient snapshot: most recent state per toward target (one row per relationship)
export async function readRelationalSnapshot(
  env: Env,
  companionId: WmAgentId,
): Promise<WmRelationalState[]> {
  const rows = await env.DB.prepare(`
    SELECT id, companion_id, toward, state_text, weight, state_type, noted_at
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY toward ORDER BY noted_at DESC) AS rn
      FROM companion_relational_state
      WHERE companion_id = ?
    )
    WHERE rn = 1
    ORDER BY noted_at DESC
    LIMIT 10
  `).bind(companionId).all<WmRelationalState>();
  return rows.results ?? [];
}
