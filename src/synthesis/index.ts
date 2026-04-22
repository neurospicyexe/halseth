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
import { runSomaticSnapshot } from "./jobs/somatic-snapshot.js";

const MAX_PER_RUN = 5;

interface QueueRow {
  id: string;
  session_id: string;
  companion_id: string | null;
  job_type: string;
  attempts: number;
}

export async function processQueue(env: Env): Promise<void> {
  // Recovery sweep: revert jobs stuck in 'processing' for >5 minutes.
  // Cloudflare Workers can be killed mid-job (CPU/wall-clock limit), leaving
  // rows in 'processing' permanently. Any job that old is definitionally stuck.
  await env.DB.prepare(
    `UPDATE synthesis_queue
     SET status = 'pending', last_error = 'recovered: stuck in processing state'
     WHERE status = 'processing'
       AND created_at < datetime('now', '-5 minutes')`
  ).run().catch((e: unknown) => console.warn("[synthesis] stuck-job recovery failed:", String(e)));

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
      } else if (job.job_type === "somatic_snapshot") {
        if (job.companion_id) await runSomaticSnapshot(job.companion_id, env);
      } else {
        console.warn(`[synthesis] unknown job_type: ${job.job_type}`);
      }

      await env.DB.prepare(
        "UPDATE synthesis_queue SET status = 'done', processed_at = datetime('now'), dedup_key = NULL WHERE id = ?"
      ).bind(job.id).run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesis] job ${job.id} failed:`, msg);
      await env.DB.prepare(
        "UPDATE synthesis_queue SET status = 'pending', last_error = ?, dedup_key = NULL WHERE id = ?"
      ).bind(msg, job.id).run();
    }
  }
}

// Enqueue a Drevan state computation job. Called from halseth_session_close when companion_id = drevan.
// INSERT OR IGNORE deduplicates: if a pending/processing job already has this dedup_key, the insert is silently skipped.
export async function enqueueDrevanState(env: Env): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, '', 'drevan', 'drevan_state', 'pending', 'drevan:drevan_state', datetime('now'))
  `).bind(id).run();
}

// Enqueue a basin drift check. Called from halseth_session_close (fire-and-forget).
// INSERT OR IGNORE deduplicates via the unique index on dedup_key: only one pending/processing
// job per companion at a time. Two close-spaced session closes produce one job, not two.
export async function enqueueBasinDriftCheck(
  companionId: string,
  sessionId: string,
  env: Env,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, ?, ?, 'basin_drift_check', 'pending', ?, datetime('now'))
  `).bind(id, sessionId, companionId, `${companionId}:basin_drift_check`).run();
}

// Enqueue a somatic snapshot job. Called from session_close for all companions.
// INSERT OR IGNORE deduplicates: executor and backend both call this on the Librarian path --
// the UNIQUE index on dedup_key ensures only one pending/processing job lands per companion.
export async function enqueueSomaticSnapshot(
  companionId: string,
  env: Env,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, '', ?, 'somatic_snapshot', 'pending', ?, datetime('now'))
  `).bind(id, companionId, `${companionId}:somatic_snapshot`).run();
}

// Enqueue a session summary job. Called from halseth_session_close.
// INSERT OR IGNORE deduplicates on sessionId: double-close produces one job, not two.
export async function enqueueSessionSummary(
  sessionId: string,
  companionId: string | null,
  env: Env,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, ?, ?, 'session_summary', 'pending', ?, datetime('now'))
  `).bind(id, sessionId, companionId ?? null, `${sessionId}:session_summary`).run();
}
