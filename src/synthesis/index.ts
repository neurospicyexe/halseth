// src/synthesis/index.ts
//
// Synthesis queue processor. Called by the scheduled cron handler.
// Picks up pending jobs, routes by job_type, marks done or failed.
// Max 5 jobs per cron invocation -- keeps execution time bounded.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { runSessionSummary } from "./jobs/session-summary.js";
import { runDrevanState } from "./jobs/drevan-state.js";
import { runBasinDriftCheck } from "./jobs/basin-drift-check.js";

const MAX_PER_RUN = 5;

interface QueueRow {
  id: string;
  session_id: string;
  companion_id: string | null;
  job_type: string;
  attempts: number;
}

export async function processQueue(env: Env): Promise<void> {
  const pending = await env.DB.prepare(`
    SELECT id, session_id, companion_id, job_type, attempts
    FROM synthesis_queue
    WHERE status = 'pending' AND attempts < 3
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(MAX_PER_RUN).all<QueueRow>();

  // TTL cleanup: runs every cron tick regardless of queue depth.
  // wm_thread_events is a pure audit log -- orient/ground never read it.
  // synthesis_queue 'done' rows are spent after processing.
  // Both use cheap indexed deletes; failure here is non-fatal.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM wm_thread_events WHERE created_at < datetime('now', '-90 days')"
    ),
    env.DB.prepare(
      "DELETE FROM synthesis_queue WHERE status = 'done' AND processed_at < datetime('now', '-30 days')"
    ),
  ]).catch((e: unknown) => console.warn("[synthesis] TTL cleanup failed:", String(e)));

  if (!pending.results?.length) return;

  for (const job of pending.results) {
    // Mark processing
    await env.DB.prepare(
      "UPDATE synthesis_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ?"
    ).bind(job.id).run();

    try {
      if (job.job_type === "session_summary") {
        await runSessionSummary(job.session_id, env);
      } else if (job.job_type === "drevan_state") {
        await runDrevanState(env);
      } else if (job.job_type === "basin_drift_check") {
        if (job.companion_id) await runBasinDriftCheck(job.companion_id, env);
      } else {
        console.warn(`[synthesis] unknown job_type: ${job.job_type}`);
      }

      await env.DB.prepare(
        "UPDATE synthesis_queue SET status = 'done', processed_at = datetime('now') WHERE id = ?"
      ).bind(job.id).run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesis] job ${job.id} failed:`, msg);
      await env.DB.prepare(
        "UPDATE synthesis_queue SET status = 'pending', last_error = ? WHERE id = ?"
      ).bind(msg, job.id).run();
    }
  }
}

// Enqueue a Drevan state computation job. Called from halseth_session_close when companion_id = drevan.
export async function enqueueDrevanState(env: Env): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO synthesis_queue (id, session_id, companion_id, job_type, status, created_at)
    VALUES (?, '', 'drevan', 'drevan_state', 'pending', datetime('now'))
  `).bind(id).run();
}

// Enqueue a basin drift check. Called from halseth_session_close (fire-and-forget).
export async function enqueueBasinDriftCheck(
  companionId: string,
  sessionId: string,
  env: Env,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO synthesis_queue (id, session_id, companion_id, job_type, status, created_at)
    VALUES (?, ?, ?, 'basin_drift_check', 'pending', datetime('now'))
  `).bind(id, sessionId, companionId).run();
}

// Enqueue a session summary job. Called from halseth_session_close.
export async function enqueueSessionSummary(
  sessionId: string,
  companionId: string | null,
  env: Env,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO synthesis_queue (id, session_id, companion_id, job_type, status, created_at)
    VALUES (?, ?, ?, 'session_summary', 'pending', datetime('now'))
  `).bind(id, sessionId, companionId ?? null).run();
}
