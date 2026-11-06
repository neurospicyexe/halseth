// src/webmind/loop-nightly.ts -- B63 step 2: the nightly callers of the loop catalogue.
//
// Rides the existing hourly ferment tick (handlers/fermentation.ts runFermentTick) with a once-per-day
// gate: the first tick after 03:00 America/Chicago does the night's work, and a marker row in
// companion_ferment_events (companion_id 'loop', stimulus 'loop_nightly') keeps every later tick that day
// from repeating it. Everything fires through loopFire, so LOOP_STIMULI_MODE (default shadow) governs
// all of it: in shadow the night writes kind='shadow' rows and moves nothing.
//
//   closes authored losses -> drags open ones (loss_unclosed, Drevan's weight)
//   quiet_day              -> a companion with no triad contact in 24h (never Gaia: her `never` entry)
//   tension_unworked       -> a simmering tension untouched for 7+ days drags the float it names

import type { Env } from "../types.js";
import { chicagoDayStartSqlite, resolveFloatKey, type CompanionId } from "./fermentation.js";
import { loopFire, tensionDragFloat, isTriad } from "./loop-stimuli.js";
import { closeAuthoredLosses, dragOpenLosses } from "./losses.js";

export const TENSION_UNWORKED_DAYS = 7;
const MARKER_COMPANION = "loop";
const MARKER_STIMULUS = "loop_nightly";

function chicagoHour(nowMs: number): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(nowMs));
  return Number(h);
}

/** Whether tonight's work is due: past 03:00 Chicago and no marker since this Chicago day began. */
export async function nightlyDue(env: Env, nowMs: number): Promise<boolean> {
  if (chicagoHour(nowMs) < 3) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS hit FROM companion_ferment_events WHERE companion_id = ? AND stimulus = ? AND created_at >= ? LIMIT 1",
  ).bind(MARKER_COMPANION, MARKER_STIMULUS, chicagoDayStartSqlite(nowMs)).first().catch(() => ({ hit: 1 }));
  return !row;
}

/** A companion with no triad contact in the last 24h: no inter-companion note in or out, no sibling_exchange. */
export async function hadTriadContact(env: Env, companion: CompanionId): Promise<boolean> {
  const note = await env.DB.prepare(
    `SELECT 1 AS hit FROM inter_companion_notes
      WHERE created_at > datetime('now', '-24 hours') AND (from_id = ? OR to_id = ? OR to_id IS NULL) LIMIT 1`,
  ).bind(companion, companion).first().catch(() => ({ hit: 1 }));
  if (note) return true;
  const ex = await env.DB.prepare(
    `SELECT 1 AS hit FROM companion_ferment_events
      WHERE companion_id = ? AND stimulus = 'sibling_exchange' AND kind IN ('stimulus', 'shadow')
        AND created_at > datetime('now', '-24 hours') LIMIT 1`,
  ).bind(companion).first().catch(() => ({ hit: 1 }));
  return !!ex;
}

export async function runLoopNightly(env: Env, nowMs: number = Date.now()): Promise<{ losses_closed: number; losses_dragging: number; quiet_days: number; tensions_dragging: number; tensions_unlinked: number }> {
  const out = { losses_closed: 0, losses_dragging: 0, quiet_days: 0, tensions_dragging: 0, tensions_unlinked: 0 };
  if (!(await nightlyDue(env, nowMs))) return out;
  // Stamp first: a failure half way must not make every later tick of the day retry the whole night.
  await env.DB.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, detail) VALUES (?, ?, 'tick', ?, ?)")
    .bind(crypto.randomUUID().replace(/-/g, ""), MARKER_COMPANION, MARKER_STIMULUS, "nightly loop pass").run();

  try {
    out.losses_closed = await closeAuthoredLosses(env);
    out.losses_dragging = await dragOpenLosses(env);
  } catch (err) { console.error("[loop-nightly] losses failed", String(err)); }

  try {
    for (const c of ["cypher", "drevan"] as const) { // Gaia never moves on quiet_day, so she is not even asked
      if (!(await hadTriadContact(env, c))) {
        if (await loopFire(env, "quiet_day", c, "no triad contact in 24h")) out.quiet_days++;
      }
    }
  } catch (err) { console.error("[loop-nightly] quiet_day failed", String(err)); }

  try {
    const rows = (await env.DB.prepare(
      `SELECT id FROM companion_tensions WHERE status = 'simmering'
         AND COALESCE(last_surfaced_at, first_noted_at) < datetime('now', ?)`,
    ).bind(`-${TENSION_UNWORKED_DAYS} days`).all<{ id: string }>()).results ?? [];
    for (const t of rows) {
      const link = await tensionDragFloat(env, t.id);
      if (!link || !isTriad(link.companion) || !resolveFloatKey(link.companion, link.float)) { out.tensions_unlinked++; continue; }
      if (await loopFire(env, "tension_unworked", link.companion, `a tension held ${TENSION_UNWORKED_DAYS}+ days, unworked`, { float: link.float })) out.tensions_dragging++;
    }
  } catch (err) { console.error("[loop-nightly] tension_unworked failed", String(err)); }

  console.log(`[loop-nightly] ${JSON.stringify(out)}`);
  return out;
}
