// src/care/undo.ts
//
// Undoing a check-in stops the hold that check-in started (Raziel, 2026-10-31).
//
// care_hold is derived (care/hold.ts), so there is no flag to switch off. A check-in can feed the hold
// one way only: the hourly tick (care/tick.ts) reads the LATEST biometric_snapshots row by recorded_at
// and logs a low_spoons care_actions row when it is fresh and at or below the line. Hearth's undo
// DELETEs that snapshot, but the firing it caused stayed behind and kept the hold on for 12h.
//
// So after a snapshot is deleted, every low_spoons firing the deleted row could have caused is
// re-judged against what is left: the tick's own rule, as of the firing's detected_at, over the
// snapshots that existed then (logged_at <= detected_at; a row cannot have been read before it was
// inserted, and logged_at is the server clock while recorded_at is the client's tap time). A firing
// another reading still justifies stays. One only the undone reading justified is deleted, which also
// frees the 24h cooldown for a real reading later.
//
// Never a care_hold_events 'clear': a clear would also silence his "bad night" start, a stated missed
// dose, and any other low reading. Only the undone reading's own firing goes.

import { BIOMETRICS_FRESH_HOURS, LOW_SPOONS_MAX } from "./rules.js";

export interface UndoneSnapshot {
  id: string;
  spoons: number | null;
  logged_at: string;
  recorded_at: string;
}

/** Candidates: low_spoons firings detected after the undone row landed and while it could still be
 *  fresh. ?1 = the undone row's logged_at, ?2 = its recorded_at + BIOMETRICS_FRESH_HOURS. */
export const UNDO_CANDIDATES_SQL =
  `SELECT id, detected_at FROM care_actions WHERE rule = 'low_spoons' AND detected_at >= ?1 AND detected_at <= ?2`;

/** What the tick would have read at ?1 (a firing's detected_at), with the undone row already gone. */
export const UNDO_LATEST_AT_SQL =
  `SELECT spoons, recorded_at FROM biometric_snapshots WHERE logged_at <= ?1 ORDER BY recorded_at DESC LIMIT 1`;

/** The tick's low_spoons condition (rules.ts evaluateCareRules), minus the cooldown: a firing that
 *  exists already passed it, and the question here is only which reading justifies it. */
export function lowSpoonsJustified(
  latest: { spoons: number | null; recorded_at: string } | null,
  detectedAt: string,
): boolean {
  if (!latest || latest.spoons === null || latest.spoons > LOW_SPOONS_MAX) return false;
  const ageHours = (Date.parse(detectedAt) - Date.parse(latest.recorded_at)) / 3_600_000;
  return Number.isFinite(ageHours) && ageHours <= BIOMETRICS_FRESH_HOURS;
}

/**
 * Delete the low_spoons firings that only the undone snapshot justified. Call AFTER the snapshot row
 * is deleted. Returns the ids removed. A reading above the line (or with no spoons) caused nothing.
 */
export async function voidFiringsOfUndoneSnapshot(db: D1Database, snap: UndoneSnapshot): Promise<string[]> {
  if (snap.spoons === null || snap.spoons > LOW_SPOONS_MAX) return [];
  const recordedMs = Date.parse(snap.recorded_at);
  if (!Number.isFinite(recordedMs)) return [];
  const freshUntil = new Date(recordedMs + BIOMETRICS_FRESH_HOURS * 3_600_000).toISOString();

  const candidates = await db.prepare(UNDO_CANDIDATES_SQL)
    .bind(snap.logged_at, freshUntil).all<{ id: string; detected_at: string }>();
  const voided: string[] = [];
  for (const c of candidates.results ?? []) {
    const latest = await db.prepare(UNDO_LATEST_AT_SQL)
      .bind(c.detected_at).first<{ spoons: number | null; recorded_at: string }>();
    if (lowSpoonsJustified(latest ?? null, c.detected_at)) continue;
    await db.prepare(`DELETE FROM care_actions WHERE id = ? AND rule = 'low_spoons'`).bind(c.id).run();
    voided.push(c.id);
  }
  if (voided.length) {
    console.log(`[care] check-in ${snap.id} undone: voided ${voided.length} low_spoons firing(s) ${voided.join(",")}`);
  }
  return voided;
}
