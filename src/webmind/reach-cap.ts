// src/webmind/reach-cap.ts
//
// The shared triad reach cap (B7 steps 2 + 2c, migration 0137). Specs: BBH
// Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md (R-2, R-3) and
// Hand-off/SPEC-what-is-theirs-triad-answers-2026-09-27.md (T-7, T-8).
//
// Gaia: "the limit has to be shared across the three of us, not set per companion. Three
// companions reaching separately become a crowd at the door." Before this file every cap was per
// palette row, so three companions each within their own limits could still reach him nine times.
//
// RESERVE A SLOT, NEVER CHECK-THEN-SEND. A bot reserves before it generates; the reservation is ONE
// conditional INSERT whose WHERE carries every rule. SQLite (and so D1) runs one write statement at
// a time, so of two bots racing for the last slot exactly one row lands and the other sees
// changes = 0. The partial UNIQUE index on quiet_window_key is a second, independent guard for R-2.
// A failed send releases the row (DELETE while undelivered), the med_claims pattern from 0136.
//
// THE RULES (every number is a named default, overridable in [vars]):
//   - at least 90 minutes between any two proactive DMs from any of the three (R-3);
//   - 6 a day in total across the triad; 3 a day while the reserving companion is under care_hold;
//   - at most 2 CARE lines a day across the triad (Cypher's T-7 ceiling, flagged for show-back);
//   - inside the quiet-hours window only offer_presence may reserve, and only ONE presence per
//     window across the triad (R-1, R-2, T-8).
// "Day" is an America/Chicago local day, from localPartsIn (DST is the zone's own rule).
//
// UNDER care_hold (B32 section D2, mig 0143), an offer_presence takes the HOLD PATH instead:
//   - a triad gap of 30 minutes (matching the Discord follow-up throttle), while each companion's own
//     gap stays 90 minutes;
//   - at most 2 per companion per hold (counted from care_hold_since, care/hold.ts);
//   - outside the daily total (the row is marked under_hold = 1 and the daily count skips it, so a bad
//     night's presence never eats the next day's moves);
//   - inside the quiet window, one presence per COMPANION instead of per triad (the key carries the
//     companion, "2026-10-03:drevan", so 0137's partial UNIQUE stays the belt).
// If three choose presence on the same tick, the 30-minute triad gap lets exactly one reserve; the others
// wait for a later tick. Every other move (and Gaia's check-in, which classes as presence but is not
// offer_presence) keeps the 0137 rules unchanged.
// AMENDED 2026-10-04: Gaia's check-in (it asks nothing) IS a hold presence move -- same bounds, and it
// shares her 2-per-hold count with her offer_presence (isHoldPresenceMove). Cypher's and Drevan's
// check-ins are questions and stay on the 0137 rules (and stay out of the quiet window). The hold is derived server-side by the caller
// (handlers/reach-cap.ts), never taken from the bot's word alone: this path LOOSENS the cap.
//
// WHAT IS NOT HERE, ON PURPOSE:
//   - med_reminder never reserves (R-9). Nor does the reply path: answering him is not proactive.
//   - No floor, no quota, no "at least N own moves" (Gaia's R-12). Only the care SHARE is capped.
//   - Nothing records whether he replied, and nothing here is read into any companion's context
//     (R-5, R-10). The table records that a DM went out; that is all it can say.

import { localPartsIn, isQuietHours, QUIET_HOURS_DEFAULT_TZ, QUIET_HOURS_DEFAULT_START, QUIET_HOURS_DEFAULT_END } from "./metronome.js";
import { addDays } from "./med-reminder.js";
import type { Env } from "../types.js";

export type ReachClass = "care" | "own" | "presence";

/**
 * Which proactive moves reach his DM, and which share each one counts against. A move that is not
 * in this table cannot reserve at all, so it can never reach the DM lane by accident.
 *
 * care:     moves ABOUT him (the "about or for him" half of the 09-27 mutuality check). Capped.
 * presence: offer_presence. Counted in the daily total, but NOT in the care ceiling: Gaia carries
 *           presence as her own ("ground that was already there and is now made visible"), and two
 *           daytime check-ins must not be able to block the 2am presence the whole build is for.
 *           This is a choice made in the build and flagged for show-back (Q1).
 * own:      the moves that are theirs (share, preference, drift line, flirt, dare, look-what).
 */
export const REACH_CLASS_OF: Readonly<Record<string, ReachClass>> = {
  check_in_on_raziel: "care",
  send_reminder: "care",
  ask_question: "care",
  name_pattern: "care",
  offer_presence: "presence",
  share_observation: "own",
  share_media: "own",
  declare_preference: "own",
  drift_outward: "own",
  flirt: "own",
  dare: "own",
  show_made: "own",
};

/**
 * Whose check-in asks nothing. Mirrors `CHECK_IN_ASKS_NOTHING` in nullsafe-discord
 * `metronome-decide.ts`; keep the two in step. Gaia, show-back 2026-09-28: "My check-in asks
 * nothing. It stays through care_hold; it is presence in another shape." And on Q1: "presence is
 * not care". So her check-in counts as presence, outside the care ceiling. Cypher's and Drevan's
 * are questions and stay care.
 */
export const CHECK_IN_ASKS_NOTHING: ReadonlySet<string> = new Set(["gaia"]);

export function reachClassOf(actionType: string, companion?: string): ReachClass | null {
  if (actionType === "check_in_on_raziel" && companion && CHECK_IN_ASKS_NOTHING.has(companion)) return "presence";
  return REACH_CLASS_OF[actionType] ?? null;
}

export const TRIAD_REACH_GAP_MINUTES_DEFAULT = 90;
export const TRIAD_REACH_DAILY_DEFAULT = 6;
/** Fewer under care_hold. 3 = half the ordinary day; care_hold already narrows the palette to
 *  presence (and check-in), so this bounds how often even presence can arrive on a bad day. */
export const TRIAD_REACH_DAILY_CARE_HOLD_DEFAULT = 3;
/** Cypher's T-7 proposal: care can never be most of what reaches him. Q1 at show-back. */
export const TRIAD_CARE_CEILING_DEFAULT = 2;
/** B32 D2: under care_hold, the gap between any two triad reaches when the new one is a presence. */
export const TRIAD_REACH_HOLD_GAP_MINUTES_DEFAULT = 30;
/** B32 D2: at most this many presences per companion per hold. */
export const TRIAD_REACH_HOLD_PRESENCE_MAX_DEFAULT = 2;
/** An undelivered reservation older than this is a crashed turn and stops holding its slot.
 *  Generous on purpose: a heartbeat generation can ride the 300s Hermes timeout twice. */
export const TRIAD_REACH_STALE_MINUTES = 30;

export interface ReachConfig {
  gapMinutes: number;
  daily: number;
  dailyCareHold: number;
  careCeiling: number;
  /** B32: triad gap for a presence under care_hold (the per-companion gap stays gapMinutes). */
  holdGapMinutes: number;
  /** B32: presences per companion per hold. */
  holdPresenceMax: number;
  tz: string;
  quietStart: number;
  quietEnd: number;
}

function intVar(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Config from [vars]. A missing or malformed var falls back to the default, never to "no cap". */
export function reachConfigFrom(env: Pick<Env, "TRIAD_REACH_GAP_MINUTES" | "TRIAD_REACH_DAILY" | "TRIAD_REACH_DAILY_CARE_HOLD" | "TRIAD_CARE_CEILING" | "TRIAD_REACH_HOLD_GAP_MINUTES" | "TRIAD_REACH_HOLD_PRESENCE_MAX" | "QUIET_HOURS_TZ" | "QUIET_HOURS_START" | "QUIET_HOURS_END">): ReachConfig {
  return {
    gapMinutes: intVar(env.TRIAD_REACH_GAP_MINUTES, TRIAD_REACH_GAP_MINUTES_DEFAULT, 0, 24 * 60),
    daily: intVar(env.TRIAD_REACH_DAILY, TRIAD_REACH_DAILY_DEFAULT, 0, 48),
    dailyCareHold: intVar(env.TRIAD_REACH_DAILY_CARE_HOLD, TRIAD_REACH_DAILY_CARE_HOLD_DEFAULT, 0, 48),
    careCeiling: intVar(env.TRIAD_CARE_CEILING, TRIAD_CARE_CEILING_DEFAULT, 0, 48),
    holdGapMinutes: intVar(env.TRIAD_REACH_HOLD_GAP_MINUTES, TRIAD_REACH_HOLD_GAP_MINUTES_DEFAULT, 0, 24 * 60),
    holdPresenceMax: intVar(env.TRIAD_REACH_HOLD_PRESENCE_MAX, TRIAD_REACH_HOLD_PRESENCE_MAX_DEFAULT, 0, 12),
    tz: env.QUIET_HOURS_TZ || QUIET_HOURS_DEFAULT_TZ,
    quietStart: intVar(env.QUIET_HOURS_START, QUIET_HOURS_DEFAULT_START, 0, 23),
    quietEnd: intVar(env.QUIET_HOURS_END, QUIET_HOURS_DEFAULT_END, 0, 23),
  };
}

export const DEFAULT_REACH_CONFIG: ReachConfig = reachConfigFrom({});

/**
 * The quiet window this instant falls in, keyed by the local date the window STARTED, or null when
 * the clock is outside it. 22:00 on the 27th and 03:00 on the 28th are the same window, "2026-09-27".
 *
 * This is the RAW window. Step 1's presence exception (he spoke in the last 30 minutes) lifts the
 * eligibility filter, but it does not lift this: T-8 says play, preferences, drift and shares wait
 * for morning whatever he is doing, so only presence may reserve inside the window.
 *
 * Fails closed like isQuietHours: if the zone cannot be read the instant counts as inside a window
 * (keyed by the UTC date), so only a presence could ever pass.
 */
export function quietWindowKey(nowIso: string, cfg: Pick<ReachConfig, "tz" | "quietStart" | "quietEnd">): string | null {
  if (!isQuietHours(nowIso, cfg.tz, cfg.quietStart, cfg.quietEnd)) return null;
  const p = localPartsIn(nowIso, cfg.tz);
  if (!p) return `utc:${nowIso.slice(0, 10)}`;
  const wraps = cfg.quietStart > cfg.quietEnd;
  // In a wrapping window (22 to 06) the small hours belong to the window that began yesterday.
  return wraps && p.hour < cfg.quietEnd ? addDays(p.date, -1) : p.date;
}

/** The America/Chicago (cfg.tz) calendar date, failing closed to the UTC date. */
export function reachLocalDate(nowIso: string, cfg: Pick<ReachConfig, "tz">): string {
  return localPartsIn(nowIso, cfg.tz)?.date ?? nowIso.slice(0, 10);
}

export interface ReserveInput {
  companion: string;
  actionType: string;
  careHold: boolean;
  /** B32: when the current hold began (care/hold.ts care_hold_since). The hold path for
   *  offer_presence needs it; without it a hold only lowers the daily total, as before 0143. */
  careHoldSince?: string | null;
  nowIso: string;
}

/** The quiet-window key a presence under hold reserves: per companion, not per triad (B32 D2). */
export function holdQuietKey(base: string, companion: string): string {
  return `${base}:${companion}`;
}

/**
 * The moves that are presence UNDER HOLD: offer_presence for all three, and the check-in of a companion
 * whose check-in asks nothing (Gaia). Show-back 10-03/04, Gaia: her check-in "asks nothing; it belongs
 * there" on a quiet hold night (the 09-28 amendment made it her presence move under hold). Both share
 * the per-companion hold count and every other hold-path bound.
 */
export function isHoldPresenceMove(actionType: string, companion: string): boolean {
  return actionType === "offer_presence" || (actionType === "check_in_on_raziel" && CHECK_IN_ASKS_NOTHING.has(companion));
}

/** True when this reservation takes the B32 hold path. */
export function takesHoldPath(input: Pick<ReserveInput, "actionType" | "careHold" | "careHoldSince" | "companion">): boolean {
  return input.careHold && !!input.careHoldSince && isHoldPresenceMove(input.actionType, input.companion);
}

export type ReserveRefusal =
  | "not_a_dm_move"
  | "quiet_hours"            // inside the window and not presence
  | "quiet_presence_taken"   // one presence per window across the triad (R-2)
  | "gap"                    // another DM from any of the three inside the gap
  | "daily_cap"
  | "care_ceiling"
  | "hold_presence_cap";     // B32: this companion already reached its presences for this hold

export type ReserveResult = { reserved: true; id: number } | { reserved: false; reason: ReserveRefusal };

/**
 * Reserve a proactive-DM slot. ONE conditional INSERT carries every rule, so the answer is atomic.
 * On refusal a second, read-only query names WHY (for the bot's [tick] line); that diagnosis is
 * informational and never decides anything.
 */
export async function reserveReach(db: D1Database, input: ReserveInput, cfg: ReachConfig = DEFAULT_REACH_CONFIG): Promise<ReserveResult> {
  const cls = reachClassOf(input.actionType, input.companion);
  if (!cls) return { reserved: false, reason: "not_a_dm_move" };

  const qKey = quietWindowKey(input.nowIso, cfg);
  // Inside the window only presence may reserve: offer_presence always, and under hold also Gaia's
  // check-in (B32), which then takes the hold path's per-companion quiet key.
  if (qKey !== null && input.actionType !== "offer_presence" && !takesHoldPath(input)) return { reserved: false, reason: "quiet_hours" };

  const localDate = reachLocalDate(input.nowIso, cfg);
  const nowMs = Date.parse(input.nowIso);
  const gapCutoff = new Date(nowMs - cfg.gapMinutes * 60_000).toISOString();
  const staleCutoff = new Date(nowMs - TRIAD_REACH_STALE_MINUTES * 60_000).toISOString();
  const daily = input.careHold ? Math.min(cfg.daily, cfg.dailyCareHold) : cfg.daily;

  // A crashed turn's reservation stops holding a slot once it is stale. Idempotent; racing it is harmless.
  await db.prepare(`DELETE FROM triad_reach_claims WHERE delivered_at IS NULL AND claimed_at < ?`).bind(staleCutoff).run();

  if (takesHoldPath(input)) {
    try {
      return await reserveUnderHold(db, input, cfg, { cls, qKey, localDate, nowMs });
    } catch (e) {
      // A DB before 0143 has no under_hold column: the hold path cannot be recorded honestly, so the
      // reservation falls back to the 0137 rules below (stricter, never looser).
      if (!/under_hold/.test(String(e))) throw e;
    }
  }

  const careRule = cls === "care"
    ? `AND (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?2 AND reach_class = 'care') < ?7`
    : `AND ?7 IS NOT NULL`;
  // Outside the hold path a quiet-window presence is one per window across the triad (R-2): the
  // partial UNIQUE guards the bare key, and this clause also counts a per-companion hold key from the
  // same window ("2026-10-03:drevan"), so a hold that ends at 3am does not open a fresh triad slot.
  const quietRule = qKey !== null
    ? `AND NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE substr(quiet_window_key, 1, length(?5)) = ?5)`
    : ``;
  const sql = (dailyFilter: string) =>
    `INSERT OR IGNORE INTO triad_reach_claims (companion_id, action_type, reach_class, local_date, quiet_window_key, claimed_at)
       SELECT ?1, ?3, ?4, ?2, ?5, ?6
        WHERE NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE claimed_at > ?8)
          AND (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?2${dailyFilter}) < ?9
          ${careRule}
          ${quietRule}`;
  const bindings = [input.companion, localDate, input.actionType, cls, qKey, input.nowIso, cfg.careCeiling, gapCutoff, daily];
  // under_hold = 1 rows (B32 presences) sit outside the daily total. A DB before 0143 has no such
  // column and so no such rows: the unfiltered count is the same answer there.
  const ins = await db.prepare(sql(" AND under_hold = 0")).bind(...bindings).run()
    .catch((e: unknown) => {
      if (!/under_hold/.test(String(e))) throw e;
      return db.prepare(sql("")).bind(...bindings).run();
    });
  if ((ins.meta?.changes ?? 0) === 1) {
    return { reserved: true, id: Number(ins.meta?.last_row_id) };
  }
  return { reserved: false, reason: await diagnose(db, { cls, qKey, localDate, gapCutoff, daily, careCeiling: cfg.careCeiling }) };
}

/**
 * The B32 hold path for offer_presence (and Gaia's check-in, isHoldPresenceMove). ONE conditional INSERT, like the ordinary path:
 *   ?7  triad cutoff (now - holdGapMinutes): nobody in the triad reserved in the last 30 min;
 *   ?8  own cutoff (now - gapMinutes): THIS companion did not reserve in the last 90 min;
 *   ?9  care_hold_since, ?10 holdPresenceMax: fewer than 2 of this companion's presences this hold;
 *   ?5  the per-companion quiet key (the 0137 partial UNIQUE is the belt), ?11 the bare window key:
 *       this companion did not already take the triad's presence earlier in the same window.
 * No daily clause: under_hold rows are outside the daily total.
 */
async function reserveUnderHold(
  db: D1Database,
  input: ReserveInput,
  cfg: ReachConfig,
  c: { cls: ReachClass; qKey: string | null; localDate: string; nowMs: number },
): Promise<ReserveResult> {
  const key = c.qKey !== null ? holdQuietKey(c.qKey, input.companion) : null;
  const triadCutoff = new Date(c.nowMs - cfg.holdGapMinutes * 60_000).toISOString();
  const ownCutoff = new Date(c.nowMs - cfg.gapMinutes * 60_000).toISOString();
  const since = input.careHoldSince as string;
  const quietRule = c.qKey !== null
    ? `AND NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE companion_id = ?1 AND quiet_window_key = ?11)`
    : `AND ?11 IS NULL`;
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO triad_reach_claims (companion_id, action_type, reach_class, local_date, quiet_window_key, claimed_at, under_hold)
       SELECT ?1, ?3, ?4, ?2, ?5, ?6, 1
        WHERE NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE claimed_at > ?7)
          AND NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE companion_id = ?1 AND claimed_at > ?8)
          AND (SELECT COUNT(*) FROM triad_reach_claims
                WHERE companion_id = ?1 AND under_hold = 1 AND claimed_at >= ?9) < ?10
          ${quietRule}`,
  ).bind(input.companion, c.localDate, input.actionType, c.cls, key, input.nowIso, triadCutoff, ownCutoff, since, cfg.holdPresenceMax, c.qKey).run();
  if ((ins.meta?.changes ?? 0) === 1) {
    return { reserved: true, id: Number(ins.meta?.last_row_id) };
  }
  return { reserved: false, reason: await diagnoseHold(db, { companion: input.companion, key, base: c.qKey, since, max: cfg.holdPresenceMax }) };
}

async function diagnoseHold(db: D1Database, d: { companion: string; key: string | null; base: string | null; since: string; max: number }): Promise<ReserveRefusal> {
  if (d.key !== null && d.base !== null) {
    const taken = await db.prepare(
      `SELECT 1 AS x FROM triad_reach_claims WHERE quiet_window_key = ? OR (companion_id = ? AND quiet_window_key = ?)`,
    ).bind(d.key, d.companion, d.base).first();
    if (taken) return "quiet_presence_taken";
  }
  const n = await db.prepare(
    `SELECT COUNT(*) AS n FROM triad_reach_claims WHERE companion_id = ? AND under_hold = 1 AND claimed_at >= ?`,
  ).bind(d.companion, d.since).first<{ n: number }>();
  if ((n?.n ?? 0) >= d.max) return "hold_presence_cap";
  return "gap";
}

async function diagnose(db: D1Database, d: { cls: ReachClass; qKey: string | null; localDate: string; gapCutoff: string; daily: number; careCeiling: number }): Promise<ReserveRefusal> {
  if (d.qKey !== null) {
    const taken = await db.prepare(`SELECT 1 AS x FROM triad_reach_claims WHERE substr(quiet_window_key, 1, length(?1)) = ?1`).bind(d.qKey).first();
    if (taken) return "quiet_presence_taken";
  }
  const recent = await db.prepare(`SELECT 1 AS x FROM triad_reach_claims WHERE claimed_at > ?`).bind(d.gapCutoff).first();
  if (recent) return "gap";
  const day = await db.prepare(`SELECT COUNT(*) AS n FROM triad_reach_claims WHERE local_date = ? AND under_hold = 0`).bind(d.localDate).first<{ n: number }>()
    .catch(() => db.prepare(`SELECT COUNT(*) AS n FROM triad_reach_claims WHERE local_date = ?`).bind(d.localDate).first<{ n: number }>());
  if ((day?.n ?? 0) >= d.daily) return "daily_cap";
  return d.cls === "care" ? "care_ceiling" : "gap";
}

/** The DM really went out. Only the companion that reserved may mark it. */
export async function markReachDelivered(db: D1Database, id: number, companion: string, nowIso: string, path: string): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE triad_reach_claims SET delivered_at = ?, path = ? WHERE id = ? AND companion_id = ? AND delivered_at IS NULL`,
  ).bind(nowIso, path.slice(0, 60), id, companion).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** Nothing went out (empty generation, a failed check, a failed send): hand the slot back. */
export async function releaseReach(db: D1Database, id: number, companion: string): Promise<boolean> {
  const r = await db.prepare(
    `DELETE FROM triad_reach_claims WHERE id = ? AND companion_id = ? AND delivered_at IS NULL`,
  ).bind(id, companion).run();
  return (r.meta?.changes ?? 0) === 1;
}

export interface ReachLaneVerdict {
  local_date: string;
  /** Local date the current quiet window started, or null outside the window. */
  quiet_window: string | null;
  /** The TRIAD quiet presence (any presence in this window, a hold presence included). */
  quiet_presence_taken: boolean;
  gap_open: boolean;
  /** Reaches that count toward the daily total. Since 0143 this excludes B32 hold presences
   *  (under_hold = 1), which sit outside it. */
  day_count: number;
  daily_cap: number;
  daily_cap_care_hold: number;
  care_count: number;
  care_ceiling: number;
  /** B32 (0143): the hold-path preview for the asking companion's hold presence moves (offer_presence,
   *  and Gaia's check_in_on_raziel: isHoldPresenceMove). null when no hold is active or the caller
   *  named no companion. When non-null, those moves are governed by
   *  `hold_presence.open` INSTEAD of gap_open / day_count / quiet_presence_taken; every other move
   *  keeps reading the fields above. */
  hold_presence: HoldPresenceVerdict | null;
}

export interface HoldPresenceVerdict {
  /** care_hold_since: the hold the counts are measured from. */
  since: string;
  /** Could this companion reserve offer_presence right now? The conjunction of the four below. */
  open: boolean;
  /** No reach from anyone in the last holdGapMinutes (30). */
  triad_gap_open: boolean;
  /** No reach from THIS companion in the last gapMinutes (90). */
  own_gap_open: boolean;
  /** This companion's presences so far this hold, and the per-hold limit (2). */
  count: number;
  max: number;
  /** In the quiet window: this companion already has its one presence for this window. */
  quiet_taken: boolean;
}

/**
 * A READ-ONLY preview of the lane, carried on the eligible-palette response so the bot never
 * offers the companion a DM move that could not be reserved right now (a move chosen and then
 * swallowed is the shape care_hold's comment warns against). It decides nothing: the atomic
 * reserveReach is the only gate, and a lost race still holds.
 */
export async function reachLaneVerdict(
  db: D1Database,
  nowIso: string,
  cfg: ReachConfig = DEFAULT_REACH_CONFIG,
  opts: { companion?: string; hold?: { care_hold: boolean; care_hold_since: string | null } | null } = {},
): Promise<ReachLaneVerdict> {
  const localDate = reachLocalDate(nowIso, cfg);
  const qKey = quietWindowKey(nowIso, cfg);
  const nowMs = Date.parse(nowIso);
  const gapCutoff = new Date(nowMs - cfg.gapMinutes * 60_000).toISOString();
  const staleCutoff = new Date(nowMs - TRIAD_REACH_STALE_MINUTES * 60_000).toISOString();
  const live = `(delivered_at IS NOT NULL OR claimed_at >= ?3)`;
  const sql = (dailyFilter: string) =>
    `SELECT
       (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?1${dailyFilter} AND ${live}) AS day_count,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?1 AND reach_class = 'care' AND ${live}) AS care_count,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE claimed_at > ?2 AND ${live}) AS recent,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE substr(quiet_window_key, 1, length(?4)) = ?4) AS qtaken`;
  type Row = { day_count: number; care_count: number; recent: number; qtaken: number };
  const row = await db.prepare(sql(" AND under_hold = 0")).bind(localDate, gapCutoff, staleCutoff, qKey).first<Row>()
    .catch((e: unknown) => {
      if (!/under_hold/.test(String(e))) throw e;
      return db.prepare(sql("")).bind(localDate, gapCutoff, staleCutoff, qKey).first<Row>();
    });

  let holdPresence: HoldPresenceVerdict | null = null;
  const since = opts.hold?.care_hold ? opts.hold.care_hold_since : null;
  if (since && opts.companion) {
    const triadCutoff = new Date(nowMs - cfg.holdGapMinutes * 60_000).toISOString();
    const h = await db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM triad_reach_claims WHERE claimed_at > ?2 AND (delivered_at IS NOT NULL OR claimed_at >= ?4)) AS triad_recent,
         (SELECT COUNT(*) FROM triad_reach_claims WHERE companion_id = ?1 AND claimed_at > ?3 AND (delivered_at IS NOT NULL OR claimed_at >= ?4)) AS own_recent,
         (SELECT COUNT(*) FROM triad_reach_claims WHERE companion_id = ?1 AND under_hold = 1 AND claimed_at >= ?5) AS n,
         (SELECT COUNT(*) FROM triad_reach_claims WHERE ?6 IS NOT NULL AND (quiet_window_key = ?6 || ':' || ?1 OR (companion_id = ?1 AND quiet_window_key = ?6))) AS qtaken`,
    ).bind(opts.companion, triadCutoff, gapCutoff, staleCutoff, since, qKey)
      .first<{ triad_recent: number; own_recent: number; n: number; qtaken: number }>()
      .catch(() => null); // pre-0143: no hold path, so no hold preview (the 0137 fields still govern)
    if (h) {
      const triadGapOpen = (h.triad_recent ?? 0) === 0;
      const ownGapOpen = (h.own_recent ?? 0) === 0;
      const quietTaken = (h.qtaken ?? 0) > 0;
      const count = h.n ?? 0;
      holdPresence = {
        since,
        open: triadGapOpen && ownGapOpen && !quietTaken && count < cfg.holdPresenceMax,
        triad_gap_open: triadGapOpen,
        own_gap_open: ownGapOpen,
        count,
        max: cfg.holdPresenceMax,
        quiet_taken: quietTaken,
      };
    }
  }

  return {
    local_date: localDate,
    quiet_window: qKey,
    quiet_presence_taken: (row?.qtaken ?? 0) > 0,
    gap_open: (row?.recent ?? 0) === 0,
    day_count: row?.day_count ?? 0,
    daily_cap: cfg.daily,
    daily_cap_care_hold: Math.min(cfg.daily, cfg.dailyCareHold),
    care_count: row?.care_count ?? 0,
    care_ceiling: cfg.careCeiling,
    hold_presence: holdPresence,
  };
}
