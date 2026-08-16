// src/care/tick.ts
//
// The care-loop detection rider (consequence layer C1). Rides runScheduledWork like every other
// autonomic tick: self-gates hourly on its OWN stamp (companion_settings 'system'/'care_tick_at'),
// gathers the signals with READS ONLY, runs the pure rule table (src/care/rules.ts), and logs
// firings to care_actions with exactly one assigned companion each.
//
// THE ANCHOR RULE (ferment-tick lesson, fermentation.ts:165-168): this tick never writes the
// anchors it reads. Owner activity, biometrics, routines, the relational_need drive -- all of them
// stay untouched, or the detector becomes a phantom contact and silences itself. The only writes
// here are care_actions INSERTs and the tick's own gate stamp, which no rule reads.

import type { Env } from "../types.js";
import { hoursSinceIso } from "../webmind/drives.js";
import { readOwnerLastSeen } from "./owner-activity.js";
import {
  evaluateCareRules,
  assignCompanion,
  PENDING_DECAY_HOURS,
  type CareSignals,
  type CareRule,
} from "./rules.js";

const TICK_GATE_HOURS = 1;

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Hours since an ISO/D1 timestamp, or null when the timestamp itself is absent. hoursSinceIso
 *  coerces null to 0, which here would read "no signal ever" as "signal just now" -- the exact
 *  absent-vs-zero conflation the rule table refuses. */
function ageHoursOrNull(iso: string | null | undefined, nowMs: number): number | null {
  return iso ? hoursSinceIso(iso, nowMs) : null;
}

export async function runCareTick(
  env: Env,
  nowMs = Date.now(),
  opts: { force?: boolean } = {},
): Promise<{ fired: number; skipped?: string }> {
  // Self-gate: at most one evaluation per hour. The stamp is the tick's own scheduling anchor --
  // restamping it is correct; it feeds no rule. `force` (the /admin/care-tick live-fire door)
  // skips the gate but never the rule cooldowns: even a forced pass cannot nag.
  if (!opts.force) {
    const stamp = await env.DB.prepare(
      `SELECT value FROM companion_settings WHERE companion_id = 'system' AND key = 'care_tick_at'`,
    ).first<{ value: string }>();
    if (stamp && hoursSinceIso(stamp.value, nowMs) < TICK_GATE_HOURS) {
      return { fired: 0, skipped: "gate" };
    }
  }

  // ── Gather signals (reads only) ──────────────────────────────────────────────
  const [bio, meds, ownerLast, firedRows, pendingRows] = await Promise.all([
    // Latest reading by recorded_at, matching orient's ordering (webmind/orient.ts) so the
    // register tier and the rule table never disagree about which row is "latest".
    env.DB.prepare(
      `SELECT recorded_at, mood, spoons, meds_taken FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT 1`,
    ).first<{ recorded_at: string; mood: string | null; spoons: number | null; meds_taken: number | null }>(),
    env.DB.prepare(
      `SELECT MAX(logged_at) AS at FROM routines WHERE lower(routine_name) LIKE '%med%'`,
    ).first<{ at: string | null }>(),
    // Owner activity across every surface D1 can see -- the shared read (care/owner-activity.ts),
    // one lane one filter with the C6 quiet-owner detector. The denominator is stated in the
    // detail line the rule table builds -- a silence claim must name what it checked.
    readOwnerLastSeen(env),
    env.DB.prepare(
      `SELECT rule, MAX(detected_at) AS at FROM care_actions GROUP BY rule`,
    ).all<{ rule: CareRule; at: string }>(),
    // Un-acted, un-decayed firings: while one exists for a rule, that rule must not fire again --
    // otherwise two pendings for one condition end up assigned to two companions and the
    // one-gesture rail breaks structurally.
    env.DB.prepare(
      `SELECT DISTINCT rule FROM care_actions WHERE acted_at IS NULL AND detected_at > ?`,
    ).bind(new Date(nowMs - PENDING_DECAY_HOURS * 3_600_000).toISOString()).all<{ rule: CareRule }>(),
  ]);

  const lastFired: Partial<Record<CareRule, number>> = {};
  for (const r of firedRows.results ?? []) {
    if (r.at) lastFired[r.rule] = hoursSinceIso(r.at, nowMs);
  }
  const pendingRules = new Set((pendingRows.results ?? []).map(r => r.rule));

  const signals: CareSignals = {
    spoons: bio?.spoons ?? null,
    mood: bio?.mood ?? null,
    meds_taken: bio?.meds_taken ?? null,
    biometrics_age_hours: ageHoursOrNull(bio?.recorded_at, nowMs),
    meds_logged_age_hours: ageHoursOrNull(meds?.at, nowMs),
    owner_silence_hours: ageHoursOrNull(ownerLast?.at, nowMs),
    owner_last_source: ownerLast?.source ?? null,
    last_fired_hours: lastFired,
  };

  const firings = evaluateCareRules(signals).filter(f => !pendingRules.has(f.rule));

  const dayIndex = Math.floor(nowMs / 86_400_000);
  const detectedAt = new Date(nowMs).toISOString();
  for (const f of firings) {
    const companion = assignCompanion(f.rule, dayIndex);
    await env.DB.prepare(
      `INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(newId(), f.rule, companion, f.detail, detectedAt).run();
    console.log(`[care] rule fired: ${f.rule} -> ${companion} (${f.detail})`);
  }

  // Stamp the gate LAST, so a crash mid-run retries within the hour instead of silently skipping.
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES ('system', 'care_tick_at', ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(detectedAt).run();

  return { fired: firings.length };
}
