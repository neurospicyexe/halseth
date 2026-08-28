// src/graph/tick.ts
//
// Nightly self-gated rebuild of graph_edges (mig 0127, src/graph/rebuild.ts). graph_edges is a
// derived, disposable projection over relationships that already exist in D1 -- until now it was
// only rebuilt manually via POST /admin/graph/rebuild, so it silently drifted as new source rows
// (conclusions, deltas, journal entries, notes, tensions, handovers) landed without anyone calling
// that endpoint.
//
// Rides the existing cron (ctx.waitUntil, sits beside runSaliencePrune in src/index.ts). That cron
// fires every MINUTE (`*/1 * * * *`, shared with the synthesis queue processor and every other
// rider in runScheduledWork) -- this job is NOT daily by cron cadence, so it self-gates to a 24h
// cadence internally, the exact mechanism runSaliencePrune uses (src/webmind/salience-prune.ts),
// copied rather than reinvented per that file's own header comment.
//
// The gate stamp is this job's own: companion_settings(companion_id='_system',
// key='graph_rebuild_last_run_at') -- the same sentinel companion_id the salience prune uses (not
// one of drevan/cypher/gaia) and a key no other job reads or writes, reusing the existing generic
// KV table (mig 0063) the same way imps/tools/active_model/salience_prune_last_run_at do, with no
// new column or migration.
//
// Stamp discipline mirrors the salience prune's (itself mirroring the ferment tick's): run first,
// stamp only once the run has actually completed. A gated-out call returns immediately without
// stamping (there was no run to record). A call that runs but throws before reaching the stamp
// also leaves it unwritten, so a failed attempt is retried on the next minute's tick instead of
// being silently gated out for 24h on a run that never actually completed.
//
// Per the tick-restamp lesson (a past ferment tick once restamped its own silence-trigger anchor
// and never fired again) this job's stamp is a distinct table+key pair from any anchor another job
// reads or writes, and rebuildGraph itself touches no event-time anchor of any kind -- it only ever
// writes graph_edges rows, never a timestamp column another job's gate depends on.

import type { Env } from "../types.js";
import { rebuildGraph, type SourceCount } from "./rebuild.js";

export const GRAPH_REBUILD_GATE_HOURS = 24;

// The gate's own storage key -- exported so tests can assert no other job's anchor (e.g. the
// salience prune's own key, a different key in the same table) shares this identity.
export const GRAPH_REBUILD_GATE_COMPANION_ID = "_system";
export const GRAPH_REBUILD_GATE_KEY = "graph_rebuild_last_run_at";

/** Hours since this tick's own last-run stamp, or null if it has never run. */
async function hoursSinceLastRebuild(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?"
  ).bind(GRAPH_REBUILD_GATE_COMPANION_ID, GRAPH_REBUILD_GATE_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  const lastMs = new Date(row.value).getTime();
  if (Number.isNaN(lastMs)) return null;
  return (Date.now() - lastMs) / (1000 * 60 * 60);
}

/** Stamp this tick's own gate. Called only after a run has actually executed. */
async function stampGraphRebuildGate(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(GRAPH_REBUILD_GATE_COMPANION_ID, GRAPH_REBUILD_GATE_KEY, new Date().toISOString()).run();
}

/**
 * Nightly rider: full deterministic rebuild of graph_edges, self-gated to GRAPH_REBUILD_GATE_HOURS
 * (the cron that drives this fires every minute; see file header). Pass `{ force: true }` to bypass
 * the gate -- reserved for manual/testing callers, never the cron path.
 *
 * Logs a single line with per-source inserted counts and elapsed ms on every completed run (not on
 * a gated-out no-op, since there is nothing to report).
 */
export async function runGraphRebuildTick(env: Env, opts: { force?: boolean } = {}): Promise<{ ran: boolean; sources?: SourceCount[]; ms?: number }> {
  if (!opts.force) {
    const elapsedHours = await hoursSinceLastRebuild(env);
    if (elapsedHours !== null && elapsedHours < GRAPH_REBUILD_GATE_HOURS) {
      return { ran: false }; // gated: ran within the last 24h, skip the rebuild entirely
    }
  }

  const start = Date.now();
  const sources = await rebuildGraph(env);
  const ms = Date.now() - start;

  console.log("[graph-rebuild-tick] rebuilt", { ms, sources });

  // Stamp only now that the run has actually completed (mirrors the salience prune writing its
  // stamp only after its scan/archive finished, never before -- a thrown error above leaves this
  // unreached, so a failed attempt is retried next minute rather than gated out for 24h).
  await stampGraphRebuildGate(env);

  return { ran: true, sources, ms };
}
