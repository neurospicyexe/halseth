// src/care/hold.ts
//
// care_hold: the ONE derivation (B32, Hand-off/DESIGN-B32-bad-night-presence-2026-10-03.md, section D).
//
// care_hold has no column. It is derived, here and nowhere else, from three sources inside the last
// CARE_HOLD_HOURS (12h):
//   low_spoons        care_actions rows (the hourly tick's firing)
//   meds_said_missed  med_answers rows with outcome = 'missed' (he SAID he missed a dose, mig 0141)
//   owner_said        care_hold_events kind = 'start' (mig 0143: "bad night", or a companion on his word)
// ...minus everything at or before the newest care_hold_events kind = 'clear'. His clear outranks the
// house's guess (Gaia, D3): it suppresses every firing detected before it, low_spoons included. A
// fresh firing after the clear holds again.
//
// Two readers, one function: the mind loader (loadCareBlocks -> world.raziel_state on every surface)
// and the reach cap (the B32 presence bounds count from care_hold_since). Pure D1, no inference.
//
// care_hold_since is the EARLIEST qualifying firing, not the latest: every firing inside the window
// covers "now", so the hold has been continuously on since the earliest one, and a second firing
// mid-hold must not reset the 2-presences-per-companion count.

import type { Env } from "../types.js";
import { CARE_HOLD_HOURS, CARE_HOLD_RULES, CARE_HOLD_ACTION_RULES, type CareHoldRule } from "./rules.js";

export interface CareHoldState {
  care_hold: boolean;
  /** Which rule(s) are holding right now, in CARE_HOLD_RULES order. [] when off. */
  care_hold_reason: CareHoldRule[];
  /** ISO UTC of the earliest firing that is holding. null when off. */
  care_hold_since: string | null;
}

export const NO_HOLD: CareHoldState = { care_hold: false, care_hold_reason: [], care_hold_since: null };

const ACTION_RULES_SQL = CARE_HOLD_ACTION_RULES.map(r => `'${r}'`).join(", ");

/** The full read (0143 applied). ?1 = window cutoff ISO. Exported so a real-schema test runs this text. */
export const CARE_HOLD_SQL = `
  WITH clr AS (SELECT COALESCE(MAX(at), '') AS at FROM care_hold_events WHERE kind = 'clear'),
  f AS (
    SELECT rule, detected_at AS at FROM care_actions WHERE rule IN (${ACTION_RULES_SQL}) AND detected_at > ?1
    UNION ALL
    SELECT 'meds_said_missed' AS rule, answered_at AS at FROM med_answers WHERE outcome = 'missed' AND answered_at > ?1
    UNION ALL
    SELECT 'owner_said' AS rule, at FROM care_hold_events WHERE kind = 'start' AND at > ?1
  )
  SELECT f.rule AS rule, MIN(f.at) AS since FROM f, clr WHERE f.at > clr.at GROUP BY f.rule`;

/** A DB before 0143 (no care_hold_events): no owner start, no clear. */
const CARE_HOLD_SQL_PRE_0143 = `
  SELECT rule, MIN(at) AS since FROM (
    SELECT rule, detected_at AS at FROM care_actions WHERE rule IN (${ACTION_RULES_SQL}) AND detected_at > ?1
    UNION ALL
    SELECT 'meds_said_missed' AS rule, answered_at AS at FROM med_answers WHERE outcome = 'missed' AND answered_at > ?1
  ) GROUP BY rule`;

/** A DB before 0141 (no outcome column, so no stated misses): care_actions alone. */
const CARE_HOLD_SQL_PRE_0141 = `
  SELECT rule, MIN(detected_at) AS since FROM care_actions WHERE rule IN (${ACTION_RULES_SQL}) AND detected_at > ?1 GROUP BY rule`;

export function holdFromRows(rows: ReadonlyArray<{ rule: string; since: string | null }>): CareHoldState {
  const byRule = new Map<string, string>();
  for (const r of rows) if (r.since) byRule.set(r.rule, r.since);
  const reasons = CARE_HOLD_RULES.filter(r => byRule.has(r));
  if (reasons.length === 0) return NO_HOLD;
  const since = reasons.map(r => byRule.get(r)!).sort()[0]!;
  return { care_hold: true, care_hold_reason: reasons, care_hold_since: since };
}

/**
 * The hold, as of nowMs. Falls back through the pre-0143 and pre-0141 shapes (so a deploy ahead of
 * the migration loses only the parts the schema cannot hold yet), and throws only if care_actions
 * itself cannot be read: callers decide what an unreadable hold means for them.
 */
export async function readCareHold(db: D1Database, nowMs = Date.now()): Promise<CareHoldState> {
  const cutoff = new Date(nowMs - CARE_HOLD_HOURS * 3_600_000).toISOString();
  const run = (sql: string) => db.prepare(sql).bind(cutoff).all<{ rule: string; since: string | null }>();
  const res = await run(CARE_HOLD_SQL)
    .catch(() => run(CARE_HOLD_SQL_PRE_0143))
    .catch(() => run(CARE_HOLD_SQL_PRE_0141));
  return holdFromRows(res.results ?? []);
}

// ── Writes: start / clear (D3) ──────────────────────────────────────────────────────────

export type HoldAction = "start" | "clear";
export type HoldSource = "owner_phrase" | "companion";
export const HOLD_ACTIONS: readonly HoldAction[] = ["start", "clear"];
export const HOLD_SOURCES: readonly HoldSource[] = ["owner_phrase", "companion"];

export interface HoldWriteResult {
  ok: true;
  action: HoldAction;
  /** The event row written. */
  id: string;
  at: string;
  /** The hold as the server now derives it, so the reply can say "Hold's on" from truth, not a cache. */
  state: CareHoldState;
}

/**
 * Record a start or a clear. Append-only: a clear never deletes a start (the history is the audit),
 * it only moves the line derivation reads from. `at` is the server clock, never the client's.
 */
export async function writeHoldEvent(
  env: Pick<Env, "DB">,
  input: { action: HoldAction; source: HoldSource; companion: string | null },
  nowMs = Date.now(),
): Promise<HoldWriteResult> {
  const id = `chold_${crypto.randomUUID().replace(/-/g, "")}`;
  const at = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.action, input.action === "start" ? "owner_said" : null, input.source, input.companion, at).run();
  const state = await readCareHold(env.DB, nowMs);
  console.log(`[b32] care_hold ${input.action} by ${input.source}${input.companion ? `/${input.companion}` : ""} -> hold=${state.care_hold} reason=${state.care_hold_reason.join(",") || "-"}`);
  return { ok: true, action: input.action, id, at, state };
}
