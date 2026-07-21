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
// src/index.ts). No timestamp gate of its own: idempotent (a row that's already
// archived=1 is excluded from the next SELECT) and cheap (bounded LIMIT), so it
// doesn't need one. Per the tick-restamp lesson (ferment tick restamping its own
// silence-trigger anchor) this job touches no event-time anchor at all -- it only
// ever writes companion_journal.archived, never last_access_at/created_at.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { effectiveHeatSql } from "./heat.js";
import { MACHINE_SOURCES } from "./notes.js";
import { vectorId } from "../mcp/embed.js";

export const PRUNE_MIN_AGE_DAYS = 30;
export const PRUNE_HEAT_FLOOR = 0.15;
export const PRUNE_BATCH = 50;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Earned salience, the pruning half: machine-source journal rows that stayed
 * cold for PRUNE_MIN_AGE_DAYS+ days get archived (invisible to recall/orient)
 * and their vectors best-effort deleted. D1 rows are kept -- reversible, and
 * the index is rebuildable from D1. Human-source rows are NEVER pruned (the
 * source IN (...) list is built only from MACHINE_SOURCES). Idempotent.
 */
export async function runSaliencePrune(env: Env): Promise<{ archived: number }> {
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
  if (ids.length === 0) return { archived: 0 };

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
  return { archived: ids.length };
}

// POST /mind/salience/prune -- manual/testing trigger (low-frequency crons need
// a test override path; this rides the daily cron in src/index.ts otherwise).
export async function postSaliencePrune(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const result = await runSaliencePrune(env);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("[mind/salience/prune] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
