// The weekly budget (consequence layer C3, mig 0124).
//
// R2: 1 credit = 1 autonomous run; WEEKLY_CREDITS per week; Monday (America/Chicago) refill;
// NO rollover. The ledger is append-only; balance is derived, never stored.
//
// Self-healing replenish: ensureReplenished() is called by the scheduled rider AND by every
// read/spend, so a dead cron can delay the refill by at most one read -- the same pattern as
// the care tick ([[health-check-throttle-cannot-self-repair]]: state repairs on the way out).
// The unique partial index (companion_id, ref) WHERE reason='replenish' makes it race-safe.

import type { Env } from "../types.js";
import { COMPANION_IDS } from "../companions.js";

export const WEEKLY_CREDITS = 7;

export type SpendPurpose = "project" | "self" | `gift:${string}`;

/**
 * The current budget week's key: the date (YYYY-MM-DD) of the most recent Monday in
 * America/Chicago. Raziel said "Monday" as a lived day, not a UTC boundary.
 */
export function weekKeyChicago(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const dowNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Normalize (some ICU builds render "Mon.") and THROW on a mismatch: clamping an unknown
  // weekday to Monday would make every day its own week key -- a fresh +7 daily, silently.
  const dow = get("weekday").replace(/\W/g, "").slice(0, 3);
  const daysSinceMonday = dowNames.indexOf(dow);
  if (daysSinceMonday < 0) throw new Error(`weekKeyChicago: unrecognized weekday "${get("weekday")}"`);
  // DST-proof walk-back (migration-reviewer, 2026-08-16): subtracting 24h multiples from `now`
  // itself crossed a date line during the fall-back hour (Sun 23:xx CST shifted to TUESDAY) and
  // minted a phantom week. Anchor at noon-Chicago-ish (18:00 UTC on today's Chicago date) --
  // both DST transitions move the clock at 2am, so an 18:00 UTC anchor never crosses midnight.
  const y = Number(get("year")), m = Number(get("month")), d = Number(get("day"));
  const monday = new Date(Date.UTC(y, m - 1, d, 18) - daysSinceMonday * 24 * 3600 * 1000);
  const mfmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  return mfmt.format(monday); // en-CA gives YYYY-MM-DD
}

/** Insert this week's +WEEKLY_CREDITS credit if absent. Race-safe via the unique index. */
export async function ensureReplenished(env: Env, companionId: string, now: Date = new Date()): Promise<void> {
  const week = weekKeyChicago(now);
  const existing = await env.DB.prepare(
    "SELECT 1 AS x FROM companion_budget_entries WHERE companion_id = ? AND reason = 'replenish' AND ref = ?"
  ).bind(companionId, week).first();
  if (existing) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO companion_budget_entries (id, companion_id, delta, reason, ref) VALUES (?, ?, ?, 'replenish', ?)"
  ).bind(crypto.randomUUID(), companionId, WEEKLY_CREDITS, week).run();
}

export interface BudgetState {
  remaining: number;
  total: number;
  week: string; // the Monday this week started (Chicago)
  spent: Array<{ purpose: string; count: number }>;
}

/**
 * Balance = sum of entries at or after this week's replenish row. No rollover is a property of
 * the WINDOW, not a sweep: last week's rows simply stop being summed.
 */
export async function readBudget(env: Env, companionId: string, now: Date = new Date()): Promise<BudgetState> {
  await ensureReplenished(env, companionId, now);
  const week = weekKeyChicago(now);
  // Anchor fetched EXPLICITLY: a NULL subquery would match nothing and read as "spent" -- but
  // absent is not zero. A missing anchor right after ensureReplenished is a real failure and
  // must throw (the growth loader degrades it to budget: null, which renders nothing).
  const anchor = await env.DB.prepare(
    "SELECT created_at FROM companion_budget_entries WHERE companion_id = ? AND reason = 'replenish' AND ref = ?"
  ).bind(companionId, week).first<{ created_at: string }>();
  if (!anchor) throw new Error(`budget: replenish anchor missing for ${companionId} week ${week}`);
  const rows = await env.DB.prepare(
    "SELECT reason, delta FROM companion_budget_entries WHERE companion_id = ? AND created_at >= ?"
  ).bind(companionId, anchor.created_at).all<{ reason: string; delta: number }>();
  let remaining = 0;
  const spentBy = new Map<string, number>();
  for (const r of rows.results ?? []) {
    remaining += r.delta;
    if (r.delta < 0) spentBy.set(r.reason, (spentBy.get(r.reason) ?? 0) - r.delta);
  }
  return {
    // NOT clamped: a concurrent overspend shows as -1, and hiding it at the source would erase
    // the only evidence. Renderers treat <= 0 as spent; the raw number stays honest here.
    remaining,
    total: WEEKLY_CREDITS,
    week,
    spent: [...spentBy.entries()].map(([purpose, count]) => ({ purpose, count })),
  };
}

export type SpendResult = { ok: true; remaining: number } | { ok: false; reason: string };

/**
 * Debit one credit for an autonomous run. An empty budget REFUSES with an in-band reason --
 * scarcity must be felt and visible, never silently absorbed
 * ([[fail-open-hides-a-dead-mechanism]]: the skip carries its cause).
 */
export async function spendBudget(env: Env, companionId: string, purpose: SpendPurpose, ref?: string, now: Date = new Date()): Promise<SpendResult> {
  const state = await readBudget(env, companionId, now);
  if (state.remaining <= 0) {
    return { ok: false, reason: `budget spent -- 0 of ${WEEKLY_CREDITS} left this week; replenishes Monday` };
  }
  await env.DB.prepare(
    "INSERT INTO companion_budget_entries (id, companion_id, delta, reason, ref) VALUES (?, ?, -1, ?, ?)"
  ).bind(crypto.randomUUID(), companionId, purpose, ref ?? null).run();
  return { ok: true, remaining: state.remaining - 1 };
}

/** Scheduled rider: keep all three companions replenished. Cheap (one SELECT each when settled). */
export async function runBudgetReplenish(env: Env, now: Date = new Date()): Promise<void> {
  for (const id of COMPANION_IDS) {
    await ensureReplenished(env, id, now);
  }
}
