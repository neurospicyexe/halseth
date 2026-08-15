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
import { runDailyNarrative } from "./jobs/daily-narrative.js";

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

  // Terminal-state sweep: jobs that exhausted their retries used to sit in
  // 'pending' forever -- invisible to the picker (attempts < 3) but never
  // marked failed, so nothing surfaced them. 113 jobs rotted that way for
  // three months (found 2026-07-04). Flip them to 'failed' so queue health
  // checks and Guardian can see them.
  await env.DB.prepare(
    `UPDATE synthesis_queue
     SET status = 'failed'
     WHERE status = 'pending' AND attempts >= 3`
  ).run().catch((e: unknown) => console.warn("[synthesis] failed-sweep failed:", String(e)));

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
      } else if (job.job_type === "daily_narrative") {
        if (job.companion_id) await runDailyNarrative(job.companion_id, env);
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
  sessionId?: string | null,
  /**
   * Explicit dedup occasion for callers that are not a session close (the daily soma refresh
   * passes `soma-refresh:<date>`). Kept separate from `sessionId` on purpose: the refresh has no
   * session, and stuffing a synthetic key into the `session_id` column would make the queue lie
   * about what caused the job.
   */
  occasionOverride?: string,
): Promise<void> {
  const id = generateId();
  // DEDUP KEY MUST BE PER-OCCASION, NOT PER-COMPANION (fixed 2026-07-31).
  //
  // It was `${companionId}:somatic_snapshot` against an INSERT OR IGNORE on a unique dedup_key. That
  // means the FIRST somatic job for a companion inserts and every one after is silently ignored --
  // forever, because the row is never deleted and a completed job still occupies the key. One
  // companion, one soma reading, for all time.
  //
  // The sibling enqueue got this right: `enqueueSessionSummary` keys on sessionId, so its comment
  // ("double-close produces one job, not two") describes real per-close dedup. Same intent, and only
  // one of the two expressed it correctly -- the shape of bug that hides because both LOOK deduped.
  //
  // Falls back to a timestamp when no session id is available, so a caller without one still enqueues
  // rather than being permanently blocked. Colliding within the same second is the acceptable failure;
  // never enqueueing again is not.
  const occasion = occasionOverride?.trim()
    ? occasionOverride.trim()
    : sessionId && sessionId.trim() ? sessionId.trim() : new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, ?, ?, 'somatic_snapshot', 'pending', ?, datetime('now'))
  `).bind(id, sessionId ?? "", companionId, `${companionId}:${occasion}:somatic_snapshot`).run();
}

// Enqueue a day-scoped narrative job. Called from the daily narrative refresh, never from a close --
// an authored close writes a real `session` summary, and this only fills the gap when none arrives.
// Keyed per companion per day, same shape as the soma refresh.
export async function enqueueDailyNarrative(
  companionId: string,
  env: Env,
  occasion: string,
): Promise<void> {
  const id = generateId();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO synthesis_queue (id, session_id, companion_id, job_type, status, dedup_key, created_at)
    VALUES (?, '', ?, 'daily_narrative', 'pending', ?, datetime('now'))
  `).bind(id, companionId, `${companionId}:${occasion}:daily_narrative`).run();
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
