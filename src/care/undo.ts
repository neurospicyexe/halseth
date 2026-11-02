// src/care/undo.ts
//
// Undoing a check-in stops the hold that check-in started (Raziel, 2026-10-31).
//
// care_hold is derived (care/hold.ts), so there is no flag to switch off. A check-in can feed the hold
// one way only: the hourly tick (care/tick.ts) reads the LATEST biometric_snapshots row by recorded_at
// and logs a low_spoons care_actions row when it is fresh and at or below the line. Hearth's undo
// DELETEs that snapshot, but the firing it caused stayed behind and kept the hold on for 12h.
//
// So the undo re-judges every low_spoons firing the undone row could have caused, with the undone row
// left out. A firing stays live when the tick's rule still holds for it either way:
//   then  as of the firing's detected_at, over the snapshots that existed then (logged_at <=
//         detected_at; a row cannot have been read before it was inserted, and logged_at is the server
//         clock while recorded_at is the client's tap time);
//   now   over the current latest reading, as the next tick would read it. Without this, a real low
//         reading logged after the firing (blocked from firing by its cooldown) would stop holding
//         until the next hourly claim.
// Otherwise the firing is VOIDED (mig 0155, voided_at = server now), never deleted: a companion's
// gesture_note on it stays in the record. Every reader that decides something skips voided rows (hold,
// the tick's cooldown and pending block, the pending-gesture read).
//
// The voids and the snapshot DELETE go in ONE batch: either the undo and its voids both land, or
// neither does and the request fails (Hearth keeps a failed write and retries it). Before 0155 there is
// no column to stamp: the snapshot is deleted, the void is skipped with a log line, and it never falls
// back to a delete. Any other error is thrown.
//
// Never a care_hold_events 'clear': a clear would also silence his "bad night" start, a stated missed
// dose, and any other low reading. Only the undone reading's own firing goes.

import { hoursSinceIso } from "../webmind/drives.js";
import { BIOMETRICS_FRESH_HOURS, LOW_SPOONS_MAX } from "./rules.js";
import { missingVoidedAt } from "./schema-gap.js";

export interface UndoneSnapshot {
  id: string;
  spoons: number | null;
  logged_at: string;
  recorded_at: string;
}

/** Candidates: live low_spoons firings detected after the undone row landed and while it could still
 *  be fresh. ?1 = the undone row's logged_at, ?2 = its recorded_at + BIOMETRICS_FRESH_HOURS. Fails on a
 *  DB before 0155 (no voided_at), which is the signal to skip. */
export const UNDO_CANDIDATES_SQL =
  `SELECT id, detected_at FROM care_actions
   WHERE rule = 'low_spoons' AND voided_at IS NULL AND detected_at >= ?1 AND detected_at <= ?2`;

export const VOID_FIRING_SQL =
  `UPDATE care_actions SET voided_at = ?1 WHERE id = ?2 AND rule = 'low_spoons' AND voided_at IS NULL`;

/** What the tick would have read at ?1 (a firing's detected_at), leaving out the undone row ?2. */
export const UNDO_LATEST_AT_SQL =
  `SELECT spoons, recorded_at FROM biometric_snapshots WHERE logged_at <= ?1 AND id != ?2
   AND source IS NOT 'wellness' ORDER BY recorded_at DESC LIMIT 1`;

/** What the next tick will read (its own query, tick.ts), leaving out the undone row ?1. Bridge rows
 *  (source 'wellness', mig 0162) are skipped exactly as the tick skips them: a bridge row has no spoons,
 *  and reading it would void a firing a hand reading still justifies (review 2026-11-01, W1). */
export const UNDO_LATEST_NOW_SQL =
  `SELECT spoons, recorded_at FROM biometric_snapshots WHERE id != ?1 AND source IS NOT 'wellness'
   ORDER BY recorded_at DESC LIMIT 1`;

/** The tick's low_spoons condition (rules.ts evaluateCareRules) with the tick's own age arithmetic
 *  (hoursSinceIso), minus the cooldown: a firing that exists already passed it, and the question here
 *  is only which reading justifies it. */
export function lowSpoonsJustified(
  latest: { spoons: number | null; recorded_at: string } | null,
  atIso: string,
): boolean {
  if (!latest || latest.spoons === null || latest.spoons > LOW_SPOONS_MAX) return false;
  return hoursSinceIso(latest.recorded_at, Date.parse(atIso)) <= BIOMETRICS_FRESH_HOURS;
}

type Latest = { spoons: number | null; recorded_at: string };

/**
 * The firings only the undone snapshot justified. Reads only; the row may still exist (it is left out
 * by id). null = a DB before 0155 (nothing can be voided). Any other error is thrown.
 */
export async function firingsToVoid(db: D1Database, snap: UndoneSnapshot, nowMs = Date.now()): Promise<string[] | null> {
  if (snap.spoons === null || snap.spoons > LOW_SPOONS_MAX) return [];
  const recordedMs = Date.parse(snap.recorded_at);
  if (!Number.isFinite(recordedMs)) return [];
  const freshUntil = new Date(recordedMs + BIOMETRICS_FRESH_HOURS * 3_600_000).toISOString();

  let candidates: D1Result<{ id: string; detected_at: string }>;
  try {
    candidates = await db.prepare(UNDO_CANDIDATES_SQL)
      .bind(snap.logged_at, freshUntil).all<{ id: string; detected_at: string }>();
  } catch (e) {
    if (missingVoidedAt(e)) return null;
    throw e;
  }
  const rows = candidates.results ?? [];
  if (rows.length === 0) return [];

  // A reading that stands now keeps every firing: the next tick would fire for it anyway.
  const current = await db.prepare(UNDO_LATEST_NOW_SQL).bind(snap.id).first<Latest>();
  if (lowSpoonsJustified(current ?? null, new Date(nowMs).toISOString())) return [];

  const ids: string[] = [];
  for (const c of rows) {
    const then = await db.prepare(UNDO_LATEST_AT_SQL).bind(c.detected_at, snap.id).first<Latest>();
    if (!lowSpoonsJustified(then ?? null, c.detected_at)) ids.push(c.id);
  }
  return ids;
}

export type UndoResult = { found: false } | { found: true; voided: string[] };

/**
 * Undo a check-in: delete the snapshot and void the firings only it justified, in one batch. Throws on
 * any failure other than "0155 not applied", leaving both untouched so the caller's retry redoes both.
 */
export async function undoCheckin(db: D1Database, id: string, nowMs = Date.now()): Promise<UndoResult> {
  const snap = await db.prepare(
    "SELECT id, spoons, logged_at, recorded_at FROM biometric_snapshots WHERE id = ?",
  ).bind(id).first<UndoneSnapshot>();
  if (!snap) return { found: false };

  const ids = await firingsToVoid(db, snap, nowMs);
  if (ids === null) console.warn(`[care] check-in ${id} undone, firings not voided: 0155 not applied`);
  const voidedAt = new Date(nowMs).toISOString();
  const voids = (ids ?? []).map(fid => db.prepare(VOID_FIRING_SQL).bind(voidedAt, fid));
  const results = await db.batch([...voids, db.prepare("DELETE FROM biometric_snapshots WHERE id = ?").bind(id)]);

  const deleted = results[results.length - 1]?.meta?.changes ?? 0;
  // Another undo of the same row won the race between our read and the batch: its own run judged the
  // same firings, so ours report nothing.
  if (!deleted) return { found: false };
  const voided = (ids ?? []).filter((_, i) => (results[i]?.meta?.changes ?? 0) > 0);
  if (voided.length) {
    console.log(`[care] check-in ${id} undone: voided ${voided.length} low_spoons firing(s) ${voided.join(",")}`);
  }
  return { found: true, voided };
}
