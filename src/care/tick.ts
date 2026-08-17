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
  evaluateEscalationRules,
  assignEscalationCompanion,
  PENDING_DECAY_HOURS,
  ESC_REDLINE_HOURS,
  type CareSignals,
  type CareRule,
  type EscalationSignals,
  type EscalationRule,
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
  // Self-gate: at most one evaluation per hour, taken as a CONDITIONAL CLAIM rather than
  // check-then-act (reviewer, 2026-08-17): the every-minute kick-script and the CF scheduled()
  // handler are two live drivers, and two overlapping runs at an hour boundary both passed the
  // old SELECT gate, double-inserting escalations -- two DMs to a human for one condition.
  // The claim UPDATE succeeds for exactly one caller. Trade-off accepted: a crash mid-run now
  // skips up to an hour instead of retrying within it; care conditions persist across an hour,
  // a duplicate page to Blue does not un-happen. `force` (the /admin/care-tick live-fire door)
  // skips the gate but never the rule cooldowns: even a forced pass cannot nag.
  if (!opts.force) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO companion_settings (companion_id, key, value, updated_at)
       VALUES ('system', 'care_tick_at', '1970-01-01T00:00:00.000Z', datetime('now'))`,
    ).run();
    const cutoff = new Date(nowMs - TICK_GATE_HOURS * 3_600_000).toISOString();
    const claim = await env.DB.prepare(
      `UPDATE companion_settings SET value = ?, updated_at = datetime('now')
       WHERE companion_id = 'system' AND key = 'care_tick_at' AND value <= ?`,
    ).bind(new Date(nowMs).toISOString(), cutoff).run();
    if ((claim.meta?.changes ?? 0) === 0) {
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

  // ── Tier 3: escalation to Blue (R1, 2026-08-17) -- same gate, its own reads/cooldowns ──────
  const escFired = await runEscalationPass(env, signals, nowMs, dayIndex, detectedAt);

  // The gate stamp moved to the ENTRY claim (see above) -- stamping here again would be a
  // second writer on the same anchor for no benefit.

  return { fired: firings.length + escFired };
}

/** The tier-3 pass. Reads its own evidence (48h report window, escalation cooldowns, undelivered
 *  rows) and reuses the already-gathered shared signals. Never throws into the tick: an escalation
 *  detection failure must not take the tier-2 gestures down with it. */
async function runEscalationPass(
  env: Env,
  shared: CareSignals,
  nowMs: number,
  dayIndex: number,
  detectedAt: string,
): Promise<number> {
  try {
    const [reportRows, escFiredRows, escPendingRows] = await Promise.all([
      env.DB.prepare(
        `SELECT recorded_at, mood, spoons FROM biometric_snapshots WHERE recorded_at > ? ORDER BY recorded_at DESC`,
      ).bind(new Date(nowMs - ESC_REDLINE_HOURS * 3_600_000).toISOString()).all<{ recorded_at: string; mood: string | null; spoons: number | null }>(),
      env.DB.prepare(
        `SELECT rule, MAX(detected_at) AS at FROM care_escalations GROUP BY rule`,
      ).all<{ rule: EscalationRule; at: string }>(),
      // An undelivered escalation blocks re-fire for its rule, with NO decay: silent expiry is
      // the one failure mode this tier exists to prevent. Delivery failure is the worker's loud
      // problem, not a reason to write a second row.
      env.DB.prepare(
        `SELECT DISTINCT rule FROM care_escalations WHERE delivered_at IS NULL`,
      ).all<{ rule: EscalationRule }>(),
    ]);

    const lastEscalated: Partial<Record<EscalationRule, number>> = {};
    for (const r of escFiredRows.results ?? []) {
      if (r.at) lastEscalated[r.rule] = hoursSinceIso(r.at, nowMs);
    }
    const pending = new Set((escPendingRows.results ?? []).map(r => r.rule));

    const escSignals: EscalationSignals = {
      meds_logged_age_hours: shared.meds_logged_age_hours,
      meds_taken: shared.meds_taken,
      biometrics_age_hours: shared.biometrics_age_hours,
      owner_silence_hours: shared.owner_silence_hours,
      owner_last_source: shared.owner_last_source,
      recent_reports: (reportRows.results ?? []).map(r => ({
        spoons: r.spoons,
        mood: r.mood,
        age_hours: hoursSinceIso(r.recorded_at, nowMs),
      })),
      last_escalated_hours: lastEscalated,
    };

    const escalations = evaluateEscalationRules(escSignals).filter(f => !pending.has(f.rule));
    for (const f of escalations) {
      const companion = assignEscalationCompanion(f.rule, dayIndex);
      await env.DB.prepare(
        `INSERT INTO care_escalations (id, rule, companion_id, detail, detected_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(newId(), f.rule, companion, f.detail, detectedAt).run();
      console.log(`[care] ESCALATION fired: ${f.rule} -> ${companion} (${f.detail})`);
    }
    return escalations.length;
  } catch (e) {
    console.error("[care] escalation pass failed (tier-2 unaffected):", String(e));
    return 0;
  }
}
