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
/** An undelivered reservation older than this is a crashed turn and stops holding its slot.
 *  Generous on purpose: a heartbeat generation can ride the 300s Hermes timeout twice. */
export const TRIAD_REACH_STALE_MINUTES = 30;

export interface ReachConfig {
  gapMinutes: number;
  daily: number;
  dailyCareHold: number;
  careCeiling: number;
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
export function reachConfigFrom(env: Pick<Env, "TRIAD_REACH_GAP_MINUTES" | "TRIAD_REACH_DAILY" | "TRIAD_REACH_DAILY_CARE_HOLD" | "TRIAD_CARE_CEILING" | "QUIET_HOURS_TZ" | "QUIET_HOURS_START" | "QUIET_HOURS_END">): ReachConfig {
  return {
    gapMinutes: intVar(env.TRIAD_REACH_GAP_MINUTES, TRIAD_REACH_GAP_MINUTES_DEFAULT, 0, 24 * 60),
    daily: intVar(env.TRIAD_REACH_DAILY, TRIAD_REACH_DAILY_DEFAULT, 0, 48),
    dailyCareHold: intVar(env.TRIAD_REACH_DAILY_CARE_HOLD, TRIAD_REACH_DAILY_CARE_HOLD_DEFAULT, 0, 48),
    careCeiling: intVar(env.TRIAD_CARE_CEILING, TRIAD_CARE_CEILING_DEFAULT, 0, 48),
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
  nowIso: string;
}

export type ReserveRefusal =
  | "not_a_dm_move"
  | "quiet_hours"            // inside the window and not presence
  | "quiet_presence_taken"   // one presence per window across the triad (R-2)
  | "gap"                    // another DM from any of the three inside the gap
  | "daily_cap"
  | "care_ceiling";

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
  if (qKey !== null && input.actionType !== "offer_presence") return { reserved: false, reason: "quiet_hours" };

  const localDate = reachLocalDate(input.nowIso, cfg);
  const nowMs = Date.parse(input.nowIso);
  const gapCutoff = new Date(nowMs - cfg.gapMinutes * 60_000).toISOString();
  const staleCutoff = new Date(nowMs - TRIAD_REACH_STALE_MINUTES * 60_000).toISOString();
  const daily = input.careHold ? Math.min(cfg.daily, cfg.dailyCareHold) : cfg.daily;

  // A crashed turn's reservation stops holding a slot once it is stale. Idempotent; racing it is harmless.
  await db.prepare(`DELETE FROM triad_reach_claims WHERE delivered_at IS NULL AND claimed_at < ?`).bind(staleCutoff).run();

  const careRule = cls === "care"
    ? `AND (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?2 AND reach_class = 'care') < ?7`
    : `AND ?7 IS NOT NULL`;
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO triad_reach_claims (companion_id, action_type, reach_class, local_date, quiet_window_key, claimed_at)
       SELECT ?1, ?3, ?4, ?2, ?5, ?6
        WHERE NOT EXISTS (SELECT 1 FROM triad_reach_claims WHERE claimed_at > ?8)
          AND (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?2) < ?9
          ${careRule}`,
  ).bind(input.companion, localDate, input.actionType, cls, qKey, input.nowIso, cfg.careCeiling, gapCutoff, daily).run();
  if ((ins.meta?.changes ?? 0) === 1) {
    return { reserved: true, id: Number(ins.meta?.last_row_id) };
  }
  return { reserved: false, reason: await diagnose(db, { cls, qKey, localDate, gapCutoff, daily, careCeiling: cfg.careCeiling }) };
}

async function diagnose(db: D1Database, d: { cls: ReachClass; qKey: string | null; localDate: string; gapCutoff: string; daily: number; careCeiling: number }): Promise<ReserveRefusal> {
  if (d.qKey !== null) {
    const taken = await db.prepare(`SELECT 1 AS x FROM triad_reach_claims WHERE quiet_window_key = ?`).bind(d.qKey).first();
    if (taken) return "quiet_presence_taken";
  }
  const recent = await db.prepare(`SELECT 1 AS x FROM triad_reach_claims WHERE claimed_at > ?`).bind(d.gapCutoff).first();
  if (recent) return "gap";
  const day = await db.prepare(`SELECT COUNT(*) AS n FROM triad_reach_claims WHERE local_date = ?`).bind(d.localDate).first<{ n: number }>();
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
  quiet_presence_taken: boolean;
  gap_open: boolean;
  day_count: number;
  daily_cap: number;
  daily_cap_care_hold: number;
  care_count: number;
  care_ceiling: number;
}

/**
 * A READ-ONLY preview of the lane, carried on the eligible-palette response so the bot never
 * offers the companion a DM move that could not be reserved right now (a move chosen and then
 * swallowed is the shape care_hold's comment warns against). It decides nothing: the atomic
 * reserveReach is the only gate, and a lost race still holds.
 */
export async function reachLaneVerdict(db: D1Database, nowIso: string, cfg: ReachConfig = DEFAULT_REACH_CONFIG): Promise<ReachLaneVerdict> {
  const localDate = reachLocalDate(nowIso, cfg);
  const qKey = quietWindowKey(nowIso, cfg);
  const nowMs = Date.parse(nowIso);
  const gapCutoff = new Date(nowMs - cfg.gapMinutes * 60_000).toISOString();
  const staleCutoff = new Date(nowMs - TRIAD_REACH_STALE_MINUTES * 60_000).toISOString();
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?1 AND (delivered_at IS NOT NULL OR claimed_at >= ?3)) AS day_count,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE local_date = ?1 AND reach_class = 'care' AND (delivered_at IS NOT NULL OR claimed_at >= ?3)) AS care_count,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE claimed_at > ?2 AND (delivered_at IS NOT NULL OR claimed_at >= ?3)) AS recent,
       (SELECT COUNT(*) FROM triad_reach_claims WHERE quiet_window_key = ?4) AS qtaken`,
  ).bind(localDate, gapCutoff, staleCutoff, qKey).first<{ day_count: number; care_count: number; recent: number; qtaken: number }>();
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
  };
}
