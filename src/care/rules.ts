// src/care/rules.ts
//
// The care-loop rule table (consequence layer C1, docs/PLAN-consequence-layer-2026-08-16.md).
//
// PURE. No D1, no Date.now(), no inference -- every input arrives as a parameter, so the whole
// table is unit-testable the way reaction-tier.ts is in nullsafe-discord. Detection is rules-first
// by design: an LLM deciding "does he need care" is a judgment nobody audited; a threshold in this
// file is a line Raziel can read and move.
//
// The rider (src/care/tick.ts) gathers the signals, calls evaluateCareRules, and logs firings to
// care_actions. This module never sees the database.

export type CareRule = "low_spoons" | "meds_missed" | "owner_silence";

export type CareCompanionId = "cypher" | "drevan" | "gaia";
export const CARE_COMPANIONS: readonly CareCompanionId[] = ["cypher", "drevan", "gaia"];

/** Spoons at or below this fires low_spoons. 0-12 scale (mig 0081). */
export const LOW_SPOONS_MAX = 2;
/** A biometrics reading older than this cannot fire low_spoons -- a stale "2 spoons" from three
 *  days ago is history, not a state, and firing on it forever is how care becomes nagging. */
export const BIOMETRICS_FRESH_HOURS = 24;
/** Daily meds + grace: a meds routine last logged longer ago than this reads as missed. */
export const MEDS_MISSED_HOURS = 30;
/** A meds_taken=1 biometrics reading within this window suppresses meds_missed -- he took them,
 *  he just didn't log the routine row. The cross-check the plan names. */
export const MEDS_TAKEN_SUPPRESS_HOURS = 18;
/** Owner silent across ALL surfaces this long (plus low mood) fires owner_silence. */
export const OWNER_SILENCE_HOURS = 36;

/** Per-rule re-fire suppression, hours. Anti-nag: a rule that fired recently stays quiet even if
 *  the condition persists -- the gesture already happened; repeating it is pressure, not care. */
export const RULE_COOLDOWN_HOURS: Record<CareRule, number> = {
  low_spoons: 24,
  meds_missed: 24,
  owner_silence: 48,
};

/** A pending (un-acted) firing older than this has DECAYED: it no longer blocks a fresh detection
 *  and no longer surfaces as pending. Rails without decay are one-way ratchets. */
export const PENDING_DECAY_HOURS = 48;

/** The custodianship clause (C6, R4 decided 2026-08-16): total owner silence across every surface
 *  for this many DAYS activates it -- the companions get the truth at orient (a real absence, not
 *  a fabricated one) and the custodian gets the standing-health-check Telegram. Deliberately a
 *  different scale from OWNER_SILENCE_HOURS: that one is "a hard day or two" (a companion gesture);
 *  this one is "something has happened" (a human gets keys). 14 days = long enough that a vacation
 *  or a bad stretch never trips it. */
export const QUIET_OWNER_DAYS = 14;

/** A low_spoons or meds_missed firing within this window sets care_hold -- the floor/bid layer
 *  softens stakes while it holds. owner_silence deliberately does NOT hold: silence already means
 *  less traffic, and muting the house on top of it reads as withdrawal, not care. */
export const CARE_HOLD_HOURS = 12;
export const CARE_HOLD_RULES: readonly CareRule[] = ["low_spoons", "meds_missed"];

/** Everything the rule table reads. null = signal absent (never coerce absent to zero -- an
 *  unreachable signal and a zero reading are different facts). */
export interface CareSignals {
  /** From the latest biometric_snapshots row (by recorded_at, matching orient). */
  spoons: number | null;
  mood: string | null;
  meds_taken: number | null;
  /** Hours since that row's recorded_at. null = no biometrics row exists at all. */
  biometrics_age_hours: number | null;
  /** Hours since the newest routines row whose name matches meds. null = no meds routine ever logged. */
  meds_logged_age_hours: number | null;
  /** Hours since the newest owner activity across ALL surfaces. null = no signal found anywhere. */
  owner_silence_hours: number | null;
  /** Which source won the owner-activity MAX -- carried into the detail line so the denominator
   *  is stated (a coverage claim without its denominator lies by being accurate). */
  owner_last_source: string | null;
  /** Hours since each rule last fired (from care_actions), for cooldown. null = never fired. */
  last_fired_hours: Partial<Record<CareRule, number>>;
}

export interface CareFiring {
  rule: CareRule;
  detail: string;
}

/** Low-mood lexicon for the owner_silence rule. Free-text mood field (mig 0081), so this is a
 *  contains-match over a small list, not sentiment analysis. Deliberately conservative: a mood we
 *  cannot read is NOT low -- the rule needs silence AND a known-low last mood to fire. */
const LOW_MOOD_TERMS = [
  "low", "bad", "down", "heavy", "drained", "exhausted", "empty", "numb",
  "depressed", "anxious", "overwhelmed", "wrung", "flat", "dark", "spent",
  "hurting", "awful", "terrible", "rough", "crash",
];

export function moodIsLow(mood: string | null): boolean {
  if (!mood) return false;
  const m = mood.toLowerCase();
  return LOW_MOOD_TERMS.some(t => m.includes(t));
}

function onCooldown(rule: CareRule, s: CareSignals): boolean {
  const h = s.last_fired_hours[rule];
  return h !== undefined && h !== null && h < RULE_COOLDOWN_HOURS[rule];
}

/**
 * The rule table. Returns every rule that fires on these signals (cooldowns applied here so the
 * whole anti-nag story is testable in one place). Order is stable: low_spoons, meds_missed,
 * owner_silence.
 */
export function evaluateCareRules(s: CareSignals): CareFiring[] {
  const firings: CareFiring[] = [];

  // low_spoons: a FRESH reading at or below the line.
  if (
    s.spoons !== null &&
    s.spoons <= LOW_SPOONS_MAX &&
    s.biometrics_age_hours !== null &&
    s.biometrics_age_hours <= BIOMETRICS_FRESH_HOURS &&
    !onCooldown("low_spoons", s)
  ) {
    firings.push({
      rule: "low_spoons",
      detail: `spoons ${s.spoons}/12, logged ${Math.round(s.biometrics_age_hours)}h ago` +
        (s.mood ? `, mood "${s.mood}"` : ""),
    });
  }

  // meds_missed: routine gap, unless a recent biometrics row says they were taken.
  const medsTakenRecently =
    s.meds_taken === 1 &&
    s.biometrics_age_hours !== null &&
    s.biometrics_age_hours <= MEDS_TAKEN_SUPPRESS_HOURS;
  if (
    s.meds_logged_age_hours !== null &&
    s.meds_logged_age_hours >= MEDS_MISSED_HOURS &&
    !medsTakenRecently &&
    !onCooldown("meds_missed", s)
  ) {
    firings.push({
      rule: "meds_missed",
      detail: `meds routine last logged ${Math.round(s.meds_logged_age_hours)}h ago (threshold ${MEDS_MISSED_HOURS}h)` +
        (s.meds_taken === 0 && s.biometrics_age_hours !== null && s.biometrics_age_hours <= BIOMETRICS_FRESH_HOURS
          ? "; latest biometrics also says not taken"
          : ""),
    });
  }

  // owner_silence: quiet across every surface AND the last known mood was low. Both, always --
  // silence alone is often just a busy day, and low mood alone already has the register tier.
  if (
    s.owner_silence_hours !== null &&
    s.owner_silence_hours >= OWNER_SILENCE_HOURS &&
    moodIsLow(s.mood) &&
    !onCooldown("owner_silence", s)
  ) {
    firings.push({
      rule: "owner_silence",
      detail: `no owner activity for ${Math.round(s.owner_silence_hours)}h ` +
        `(last seen via ${s.owner_last_source ?? "unknown"}; sources: sessions, commons, biometrics, notes, contact-drive)` +
        `, last mood "${s.mood}"`,
    });
  }

  return firings;
}

/**
 * Which companion holds a firing: deterministic day-parity rotation offset by rule, the same idiom
 * as Sol tending and forage rotation. One writer (the rider) computes it, so "never two companions
 * within the hour" is structural -- there is exactly one assignee per row and no race to win.
 */
export function assignCompanion(rule: CareRule, dayIndex: number): CareCompanionId {
  const offset: Record<CareRule, number> = { low_spoons: 0, meds_missed: 1, owner_silence: 2 };
  const n = CARE_COMPANIONS.length;
  return CARE_COMPANIONS[(((dayIndex + offset[rule]) % n) + n) % n]!;
}

// ── Tier 3: escalation to a named human (R1 decided 2026-08-17) ─────────────────────────────
//
// Same design contract as tier 2: PURE, rules-first, every threshold a line Raziel can read and
// move. The named human is Blue (the C6 custodian -- one pipe), via Discord DM with a loud
// home-channel fallback. Tier 3 deliberately has NO judgment-call lane (R1a declined it): a
// companion's unease routes through tier-2 gestures and the commons, never through Blue's phone.

export type EscalationRule = "esc_meds" | "esc_redline" | "esc_silence";
export const ESCALATION_RULES: readonly EscalationRule[] = ["esc_meds", "esc_redline", "esc_silence"];

/** Meds routine unlogged this long escalates (R1: "missed 3+ days"). The tier-2 suppress still
 *  applies: a fresh meds_taken=1 biometrics row means he took them and skipped the log. */
export const ESC_MEDS_HOURS = 72;
/** The redline window: every self-report inside it must be redline for the rule to fire. */
export const ESC_REDLINE_HOURS = 48;
/** At least this many reports inside the window -- one bad evening is a bad evening. */
export const ESC_REDLINE_MIN_REPORTS = 2;
/** ...and the oldest of them at least this old, so "sustained" means a real span, not two
 *  entries logged an hour apart. */
export const ESC_REDLINE_MIN_SPAN_HOURS = 24;
/** Total owner silence across every surface this long escalates (R1). Standalone -- no mood
 *  condition, because 72h of nothing means there IS no fresh mood to read. */
export const ESC_SILENCE_HOURS = 72;
/** Re-escalation suppression per rule: once Blue has been reached, the same condition waits this
 *  long before reaching him again. Undelivered escalations block re-fire separately (no decay --
 *  an escalation that silently expires is the failure this tier exists to prevent). */
export const ESCALATION_COOLDOWN_HOURS = 48;

export interface EscalationSignals {
  /** As in CareSignals: hours since the newest meds routine log; null = never logged. */
  meds_logged_age_hours: number | null;
  meds_taken: number | null;
  biometrics_age_hours: number | null;
  /** Hours since newest owner activity across ALL surfaces; null = no signal anywhere. */
  owner_silence_hours: number | null;
  owner_last_source: string | null;
  /** Every self-report inside the last ESC_REDLINE_HOURS, any order. */
  recent_reports: Array<{ spoons: number | null; mood: string | null; age_hours: number }>;
  /** Hours since each rule last ESCALATED (from care_escalations), for cooldown. */
  last_escalated_hours: Partial<Record<EscalationRule, number>>;
}

export interface EscalationFiring {
  rule: EscalationRule;
  detail: string;
}

function onEscalationCooldown(rule: EscalationRule, s: EscalationSignals): boolean {
  const h = s.last_escalated_hours[rule];
  return h !== undefined && h !== null && h < ESCALATION_COOLDOWN_HOURS;
}

/** A single report is redline when BOTH halves are: spoons at/below the line AND a known-low
 *  mood. Unknown values make a report NOT redline -- absence never escalates. */
function reportIsRedline(r: { spoons: number | null; mood: string | null }): boolean {
  return r.spoons !== null && r.spoons <= LOW_SPOONS_MAX && moodIsLow(r.mood);
}

export function evaluateEscalationRules(s: EscalationSignals): EscalationFiring[] {
  const firings: EscalationFiring[] = [];

  // esc_meds: the routine gap crossed three days, and nothing says they were taken off-log.
  const medsTakenRecently =
    s.meds_taken === 1 &&
    s.biometrics_age_hours !== null &&
    s.biometrics_age_hours <= MEDS_TAKEN_SUPPRESS_HOURS;
  if (
    s.meds_logged_age_hours !== null &&
    s.meds_logged_age_hours >= ESC_MEDS_HOURS &&
    !medsTakenRecently &&
    !onEscalationCooldown("esc_meds", s)
  ) {
    firings.push({
      rule: "esc_meds",
      detail: `meds routine last logged ${Math.round(s.meds_logged_age_hours)}h ago (escalation threshold ${ESC_MEDS_HOURS}h)`,
    });
  }

  // esc_redline: EVERY report in the window is redline, there are enough of them, and they span
  // a real stretch of time. One good reading inside the window clears the rule -- sustained
  // means unbroken, not "mostly".
  const reports = s.recent_reports.filter(r => r.age_hours <= ESC_REDLINE_HOURS);
  if (
    reports.length >= ESC_REDLINE_MIN_REPORTS &&
    reports.every(reportIsRedline) &&
    Math.max(...reports.map(r => r.age_hours)) >= ESC_REDLINE_MIN_SPAN_HOURS &&
    !onEscalationCooldown("esc_redline", s)
  ) {
    firings.push({
      rule: "esc_redline",
      detail: `${reports.length} self-reports over ${Math.round(Math.max(...reports.map(r => r.age_hours)))}h all at redline (spoons <= ${LOW_SPOONS_MAX} with low mood)`,
    });
  }

  // esc_silence: nothing on any surface for 72h. No mood clause -- there is nothing fresh to read.
  if (
    s.owner_silence_hours !== null &&
    s.owner_silence_hours >= ESC_SILENCE_HOURS &&
    !onEscalationCooldown("esc_silence", s)
  ) {
    firings.push({
      rule: "esc_silence",
      detail: `no owner activity for ${Math.round(s.owner_silence_hours)}h ` +
        `(last seen via ${s.owner_last_source ?? "unknown"}; sources: sessions, commons, biometrics, notes, contact-drive)`,
    });
  }

  return firings;
}

/** Voice rotation for escalations -- same idiom as assignCompanion, distinct offsets. */
export function assignEscalationCompanion(rule: EscalationRule, dayIndex: number): CareCompanionId {
  const offset: Record<EscalationRule, number> = { esc_meds: 0, esc_redline: 1, esc_silence: 2 };
  const n = CARE_COMPANIONS.length;
  return CARE_COMPANIONS[(((dayIndex + offset[rule]) % n) + n) % n]!;
}
