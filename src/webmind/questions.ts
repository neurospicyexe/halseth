// src/webmind/questions.ts
//
// Answered-question delivery: shared read + ack helpers for the three orient paths
// (mindOrient, execSessionOrient, execBotOrient). Fixes the questions-lifecycle bug --
// Raziel answers in Hearth (status -> 'answered', answer text stored) but every orient
// path only ever read status = 'open', so the answer never reached the companion.
//
// 7-day window, deliberately NOT gated on delivered_at: an answer stays visible at
// orient for 7 days at every surface, so an early bot orient can't eat the answer
// before the Claude.ai session sees it. delivered_at only records that *some* orient
// has surfaced it at least once (mig 0107); it never narrows the read.

import { Env } from "../types.js";
import { WmAnsweredQuestion } from "./types.js";

export async function fetchRecentAnswers(
  env: Env,
  companionId: string,
  limit = 3,
): Promise<WmAnsweredQuestion[]> {
  const result = await env.DB.prepare(
    `SELECT id, question, answer, answered_at, delivered_at FROM companion_questions
     WHERE companion_id = ? AND status = 'answered' AND answer IS NOT NULL
       AND answered_at >= datetime('now', '-7 days')
     ORDER BY answered_at DESC LIMIT ?`
  ).bind(companionId, limit).all<WmAnsweredQuestion>();
  return result.results ?? [];
}

// Stamps delivered_at the first time an orient surfaces an answer. Never re-stamps
// (WHERE delivered_at IS NULL) -- delivered_at records first delivery, not last read.
// Callers MUST await this: unawaited D1 writes are silently discarded once the Worker
// response flushes (see the read_at auto-ack at src/webmind/orient.ts:239-249).
export async function markAnswersDelivered(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await env.DB.prepare(
    `UPDATE companion_questions SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`
  ).bind(new Date().toISOString(), ...ids).run();
}
