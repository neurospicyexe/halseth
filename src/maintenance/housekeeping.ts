// src/maintenance/housekeeping.ts  (2026-11-05, quiet-drops sweep items 13/14/15)
//
// Three janitors that ride the every-minute cron, self-gated to hourly on their own stamp (a distinct
// (companion_id, key) pair no other job reads -- the tick-restamp lesson):
//
//   reapStuckAutonomyRuns   autonomy_runs 'running' for > 6h -> 'failed', error_message 'reaped'.
//                           A run that never PATCHed its terminal status (worker killed mid-run) read as
//                           "running" forever (07-17, 10-13, 10-27). Nothing legitimate runs 6 hours.
//   pruneFailedSynthesis    synthesis_queue 'failed' rows older than 14 days are deleted, in batches.
//                           9,004 of them accumulated (DeepSeek 402/null, 08-04..10-23); the cause is
//                           dead, the rows were never pruned. 'done' rows are left alone.
//   expireForageFinds       unconsumed forage_finds older than 21 days get expired_at stamped (mig 0169).
//                           Never deleted, never marked consumed; every unconsumed-pool read excludes them.
//
// No model, no interpretation: arithmetic over timestamps. Each janitor has its own catch.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

export const REAP_AFTER_HOURS = 6;
export const REAP_REASON = "reaped";
export const SYNTHESIS_FAILED_KEEP_DAYS = 14;
export const SYNTHESIS_PRUNE_BATCH = 1000;
export const FORAGE_EXPIRE_DAYS = 21;
export const HOUSEKEEPING_GATE_HOURS = 1;
export const HOUSEKEEPING_GATE_COMPANION_ID = "_system";
export const HOUSEKEEPING_GATE_KEY = "housekeeping_at";

export async function reapStuckAutonomyRuns(env: Env, afterHours = REAP_AFTER_HOURS): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE autonomy_runs
        SET status = 'failed', completed_at = datetime('now'), error_message = ?
      WHERE status = 'running'
        AND COALESCE(started_at, created_at) < datetime('now', ?)`
  ).bind(REAP_REASON, `-${Math.floor(afterHours)} hours`).run();
  return r.meta?.changes ?? 0;
}

export async function pruneFailedSynthesis(env: Env, keepDays = SYNTHESIS_FAILED_KEEP_DAYS): Promise<number> {
  const r = await env.DB.prepare(
    `DELETE FROM synthesis_queue
      WHERE id IN (
        SELECT id FROM synthesis_queue
         WHERE status = 'failed'
           AND COALESCE(processed_at, created_at) < datetime('now', ?)
         LIMIT ${SYNTHESIS_PRUNE_BATCH})`
  ).bind(`-${Math.floor(keepDays)} days`).run();
  return r.meta?.changes ?? 0;
}

export async function expireForageFinds(env: Env, days = FORAGE_EXPIRE_DAYS): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE forage_finds
        SET expired_at = datetime('now')
      WHERE consumed_at IS NULL AND expired_at IS NULL
        AND gathered_at < datetime('now', ?)`
  ).bind(`-${Math.floor(days)} days`).run();
  return r.meta?.changes ?? 0;
}

async function hoursSinceLastRun(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?"
  ).bind(HOUSEKEEPING_GATE_COMPANION_ID, HOUSEKEEPING_GATE_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  const ms = new Date(row.value).getTime();
  return Number.isNaN(ms) ? null : (Date.now() - ms) / 3_600_000;
}

async function stampGate(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(HOUSEKEEPING_GATE_COMPANION_ID, HOUSEKEEPING_GATE_KEY, new Date().toISOString()).run();
}

export interface HousekeepingResult {
  ran: boolean;
  reaped: number;
  pruned_synthesis: number;
  expired_forage: number;
}

export async function runHousekeeping(env: Env, opts: { force?: boolean } = {}): Promise<HousekeepingResult> {
  const out: HousekeepingResult = { ran: false, reaped: 0, pruned_synthesis: 0, expired_forage: 0 };
  if (!opts.force) {
    const elapsed = await hoursSinceLastRun(env);
    if (elapsed !== null && elapsed < HOUSEKEEPING_GATE_HOURS) return out;
  }
  out.ran = true;
  // Each janitor has its own catch: one failure (e.g. mig 0169 not yet applied) never blocks the others.
  try { out.reaped = await reapStuckAutonomyRuns(env); }
  catch (e) { console.error("[housekeeping] autonomy reaper failed:", e); }
  try { out.pruned_synthesis = await pruneFailedSynthesis(env); }
  catch (e) { console.error("[housekeeping] synthesis prune failed:", e); }
  try { out.expired_forage = await expireForageFinds(env); }
  catch (e) { console.error("[housekeeping] forage expiry failed:", e); }
  if (out.reaped || out.pruned_synthesis || out.expired_forage) {
    console.log(`[housekeeping] reaped=${out.reaped} synthesis_pruned=${out.pruned_synthesis} forage_expired=${out.expired_forage}`);
  }
  // Stamp after the run so a throw above (outside the catches) retries next minute.
  await stampGate(env);
  return out;
}

// POST /admin/housekeeping  (manual trigger, forced)
export async function postHousekeeping(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const result = await runHousekeeping(env, { force: true });
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}
