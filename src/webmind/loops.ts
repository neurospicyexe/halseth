// src/webmind/loops.ts
//
// companion_open_loops: unresolved things with weight.
// Distinct from wm_mind_threads (intentions) -- a loop is unresolved, not a goal.
// Surfaced in ground sorted by weight; closed when resolved.

import { Env } from "../types.js";
import { WmAgentId, WmOpenLoop, WmLoopInput } from "./types.js";

export async function writeLoop(env: Env, input: WmLoopInput): Promise<{ id: string; opened_at: string }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, input.companion_id, input.loop_text, input.weight ?? 0.5, now).run();
  return { id, opened_at: now };
}

export async function readLoops(
  env: Env,
  companionId: WmAgentId,
  opts: { include_closed?: boolean; limit?: number } = {}
): Promise<WmOpenLoop[]> {
  const limit = opts.limit ?? 20;
  const rows = opts.include_closed
    ? await env.DB.prepare(
        "SELECT * FROM companion_open_loops WHERE companion_id = ? ORDER BY closed_at ASC, weight DESC LIMIT ?"
      ).bind(companionId, limit).all<WmOpenLoop>()
    : await env.DB.prepare(
        "SELECT * FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL ORDER BY weight DESC LIMIT ?"
      ).bind(companionId, limit).all<WmOpenLoop>();
  return rows.results ?? [];
}

export async function closeLoop(env: Env, id: string, companionId: WmAgentId): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE companion_open_loops SET closed_at = ? WHERE id = ? AND companion_id = ? AND closed_at IS NULL"
  ).bind(now, id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Hold a loop open on purpose (migration 0082, Guardian self-resolution). A companion
 * clearing its own loop_stuck flag can keep the loop but record WHY it stays; reviewed_at
 * suppresses the stuck flag for 21d (detectStuckLoops). The reason is appended to loop_text
 * so the held justification travels with the loop. Ownership-guarded; only an open loop.
 */
export async function reviewLoop(
  env: Env, id: string, companionId: WmAgentId, reason: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const note = (reason ?? "").trim().slice(0, 280);
  const result = await env.DB.prepare(
    `UPDATE companion_open_loops
       SET reviewed_at = ?1,
           loop_text = CASE WHEN ?2 != '' THEN loop_text || ' [held ' || ?3 || ': ' || ?2 || ']' ELSE loop_text END
     WHERE id = ?4 AND companion_id = ?5 AND closed_at IS NULL`
  ).bind(now, note, now.slice(0, 10), id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}
