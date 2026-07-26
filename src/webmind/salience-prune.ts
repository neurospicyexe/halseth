// src/webmind/salience-prune.ts
//
// Task 20 (thinking-quality fix, mig 0105): the salience-prune tick.
// Earned salience has two halves -- warming (task 19: recall/orient bump heat on
// surfaced rows) and pruning (this file): machine-source companion_journal rows
// that stayed cold (low effective heat) AND old (30+ days) self-archive.
// archived=1 only -- the D1 row is never deleted (reversible, and the vector
// index is rebuildable from D1 per the Vectorize covenant). Vector deletion is
// best-effort: a failure there must not fail the archive, because a stray
// vector match on an archived row dies at read time anyway (recall/orient both
// filter WHERE archived = 0, task 19).
//
// Human-source rows are NEVER pruned. This is enforced structurally, not by a
// negative check: the SELECT's source IN (...) list is built from MACHINE_SOURCES
// only, so a NULL/unknown/legacy source (not in that set) can never match the
// IN clause -- fail-protective by construction, not by an easy-to-forget guard.
//
// Rides the existing cron (ctx.waitUntil, sits beside runFermentTick in
// src/index.ts). That cron fires every MINUTE (`*/1 * * * *`, shared with the
// synthesis queue processor) -- this job is NOT daily by cron cadence, so it
// self-gates to a 24h cadence internally, the same way runFermentTick self-gates
// against its own `ferment_at` column (src/handlers/fermentation.ts) instead of
// trusting the cron interval to already be daily.
//
// The gate stamp is the prune's own: companion_settings(companion_id='_system',
// key='salience_prune_last_run_at') -- a sentinel companion_id (not one of
// drevan/cypher/gaia) and a key no other job reads or writes, reusing the
// existing generic KV table (mig 0063) the same way imps/tools/active_model do,
// with no new column or migration. Nothing else in the codebase touches this
// (companion_id, key) pair, so it can never become a second job's event anchor.
//
// Stamp discipline mirrors the ferment tick's: run first, stamp only once the
// run has actually completed (the tick writes ferment_at together with the
// fermented state in the SAME successful UPDATE, never before). A gated-out
// call returns immediately without stamping (there was no run to record). A
// call that runs but throws before reaching the stamp also leaves it unwritten,
// so a failed attempt is retried on the next minute's tick instead of being
// silently gated out for 24h on a run that never actually completed. A run
// that completes and finds nothing to archive still stamps -- "ran, found
// nothing" is a completed run and re-arms the 24h window regardless.
//
// Per the tick-restamp lesson (ferment tick once restamped its own
// silence-trigger anchor) this job's stamp is a distinct table + key from any
// anchor another job reads, and the actual archive work still touches no
// event-time anchor at all -- it only ever writes companion_journal.archived,
// never last_access_at/created_at.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { effectiveHeatSql } from "./heat.js";
import { MACHINE_SOURCES } from "./notes.js";
import { vectorId } from "../mcp/embed.js";

export const PRUNE_MIN_AGE_DAYS = 30;
export const PRUNE_HEAT_FLOOR = 0.15;
export const PRUNE_BATCH = 50;
export const PRUNE_GATE_HOURS = 24;

// The gate's own storage key -- exported so tests can assert no other job's
// anchor (e.g. fermentation's `ferment_at` column, a different table entirely)
// shares this identity.
export const PRUNE_GATE_COMPANION_ID = "_system";
export const PRUNE_GATE_KEY = "salience_prune_last_run_at";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Hours since the prune's own last-run stamp, or null if it has never run. */
async function hoursSinceLastPrune(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?"
  ).bind(PRUNE_GATE_COMPANION_ID, PRUNE_GATE_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  const lastMs = new Date(row.value).getTime();
  if (Number.isNaN(lastMs)) return null;
  return (Date.now() - lastMs) / (1000 * 60 * 60);
}

/** Stamp the prune's own gate. Called only after a run has actually executed. */
async function stampPruneGate(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(PRUNE_GATE_COMPANION_ID, PRUNE_GATE_KEY, new Date().toISOString()).run();
}

/**
 * Earned salience, the pruning half: machine-source journal rows that stayed
 * cold for PRUNE_MIN_AGE_DAYS+ days get archived (invisible to recall/orient)
 * and their vectors best-effort deleted. D1 rows are kept -- reversible, and
 * the index is rebuildable from D1. Human-source rows are NEVER pruned (the
 * source IN (...) list is built only from MACHINE_SOURCES). Idempotent.
 *
 * Self-gated to PRUNE_GATE_HOURS (the cron that drives this fires every
 * minute; see file header). Pass `{ force: true }` to bypass the gate --
 * used only by the manual/testing trigger, never by the cron path.
 */
export async function runSaliencePrune(env: Env, opts: { force?: boolean } = {}): Promise<{ archived: number }> {
  if (!opts.force) {
    const elapsedHours = await hoursSinceLastPrune(env);
    if (elapsedHours !== null && elapsedHours < PRUNE_GATE_HOURS) {
      return { archived: 0 }; // gated: ran within the last 24h, skip the scan entirely
    }
  }

  const machineSources = Array.from(MACHINE_SOURCES);
  const sourcePlaceholders = machineSources.map(() => "?").join(", ");

  const rows = await env.DB.prepare(
    `SELECT id FROM companion_journal
     WHERE archived = 0
       AND source IN (${sourcePlaceholders})
       AND created_at < datetime('now', '-${PRUNE_MIN_AGE_DAYS} days')
       AND ${effectiveHeatSql()} < ${PRUNE_HEAT_FLOOR}
     LIMIT ${PRUNE_BATCH}`
  ).bind(...machineSources).all<{ id: string }>();

  const ids = (rows.results ?? []).map(r => r.id);

  if (ids.length > 0) {
    const idPlaceholders = ids.map(() => "?").join(", ");
    await env.DB.prepare(
      `UPDATE companion_journal SET archived = 1 WHERE id IN (${idPlaceholders})`
    ).bind(...ids).run();

    try {
      await env.VECTORIZE.deleteByIds(ids.map(id => vectorId("companion_journal", id)));
    } catch (err) {
      // Vector deletion is best-effort -- the D1 archive already happened and is
      // what recall/orient's archived = 0 filters honor. A stray leftover vector
      // for an archived row can never resolve to a visible result: the row-fetch
      // join in recallNotesByMeaning excludes archived=1 ids regardless.
      console.error("[salience-prune] vector delete failed", String(err));
    }

    console.log("[salience-prune] archived", { count: ids.length });
  }

  // Stamp only now that the run has actually completed (mirrors the ferment
  // tick writing ferment_at together with its successful state update, never
  // before). A "ran, found nothing" pass still stamps -- it's a completed run.
  await stampPruneGate(env);

  return { archived: ids.length };
}

// POST /mind/salience/prune -- manual/testing trigger (low-frequency crons need
// a test override path). Bypasses the 24h gate (force: true) -- this is the
// deliberate test/ops path, not the cron; the cron path never forces.
export async function postSaliencePrune(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const result = await runSaliencePrune(env, { force: true });
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("[mind/salience/prune] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
