// med_reminder (B7 step 2b, 2026-09-27). Spec: Hand-off/SPEC-care-verbs-triad-answers-2026-09-27.md,
// rules R-9 (outside every other rail, one follow-up then stop), R-10 (only an answer is ever
// recorded), P-2 (no answer is never "not taken").
//
// This is its OWN scheduler, deliberately not a metronome palette action. It never goes through
// runHeartbeat, the justification gate, quiet hours or isEligible. B7 step 1 found that a filter
// which empties a list inverted into a 4am fallback post; a must-fire reminder must not ride
// machinery built to say no.
//
// Everything here is pure over D1 plus an injected `nowIso`, so the tests drive the real schema
// (node:sqlite) on both sides of DST without a clock.
//
// PRIVACY. `label` is the one private field (it names the medication). It leaves this module only
// in the /mind/med/due and /mind/med/today payloads, which only the bots read, and the bots put it
// only into a DM. Nothing here logs it.

import { localPartsIn, type LocalParts } from "./metronome.js";

export type MedKind = "first" | "followup";
export type MedCompanion = "cypher" | "drevan" | "gaia";

export const MED_COMPANIONS: ReadonlySet<string> = new Set(["cypher", "drevan", "gaia"]);

/** A claim with no delivery after this long is presumed dead (process crashed between claim and
 *  send) and may be re-claimed. Must stay well above the bot's generation timeout plus a send, so a
 *  live generation is never stolen. */
export const MED_CLAIM_STALE_SECONDS = 600;

/** Before this local hour, "today's state" also carries yesterday's afternoon/evening doses: the
 *  foggy-morning "did I take it last night?" case. */
export const MED_YESTERDAY_UNTIL_HOUR = 12;
/** Yesterday's doses at or after this local time count as "last night" for that carry-over. */
export const MED_YESTERDAY_FROM_MINUTES = 12 * 60;

export interface MedScheduleRow {
  slot_key: string;
  label: string;
  local_time: string;
  tz: string;
  weekday_mask: number;
  followup_minutes: number | null;
  late_window_minutes: number;
  primary_companion: MedCompanion;
  fallback_companion: MedCompanion | null;
  fallback_delay_seconds: number;
  active: number;
  active_from: string | null;
}

interface ClaimRow {
  slot_key: string;
  local_date: string;
  kind: MedKind;
  companion_id: MedCompanion;
  claimed_at: string;
  delivered_at: string | null;
}

export interface DueDose {
  slot_key: string;
  local_date: string;
  kind: MedKind;
  label: string;
  local_time: string;
}

// ── time helpers ────────────────────────────────────────────────────────────────────────────────

/** 'HH:MM' -> minutes since local midnight, or null. */
export function slotMinutes(localTime: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(localTime.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Calendar arithmetic on a 'YYYY-MM-DD' string (no clock, no zone, so no DST). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Weekday (0=Sun) of a 'YYYY-MM-DD' calendar date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function maskIncludes(mask: number, weekday: number): boolean {
  return (mask & (1 << weekday)) !== 0;
}

/** Is the row scheduled at all on this local date (weekday mask + active_from)? */
export function scheduledOn(row: Pick<MedScheduleRow, "weekday_mask" | "active_from">, date: string): boolean {
  if (row.active_from && date < row.active_from) return false;
  return maskIncludes(row.weekday_mask, weekdayOf(date));
}

/** The next local date strictly after `date` on which the row is scheduled (within 7 days), or null. */
export function nextOccurrenceDate(row: Pick<MedScheduleRow, "weekday_mask" | "active_from">, date: string): string | null {
  for (let i = 1; i <= 7; i++) {
    const next = addDays(date, i);
    if (scheduledOn(row, next)) return next;
  }
  return null;
}

/** Local HH:MM of an ISO instant in tz, or null. For rendering an answer time back; never raw UTC. */
export function localHHMM(iso: string, tz: string): string | null {
  const p = localPartsIn(iso, tz);
  return p ? `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : null;
}

/**
 * Minutes elapsed (local wall clock) from the slot's time on `date` to `now`. `now` is either on
 * `date` or the day after it. On the one day a DST transition falls between the slot and now this
 * is off by the transition's hour; the only effect is the late window closing an hour early or
 * late on that one night, which is accepted over a second offset computation.
 */
function elapsedMinutes(now: LocalParts, date: string, slotMin: number): number {
  const nowMin = now.hour * 60 + now.minute;
  return now.date === date ? nowMin - slotMin : nowMin + 1440 - slotMin;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────

async function activeSchedule(db: D1Database): Promise<MedScheduleRow[]> {
  const r = await db.prepare(
    `SELECT slot_key, label, local_time, tz, weekday_mask, followup_minutes, late_window_minutes,
            primary_companion, fallback_companion, fallback_delay_seconds, active, active_from
       FROM med_schedule WHERE active = 1 ORDER BY local_time, slot_key`,
  ).all<MedScheduleRow>();
  return r.results ?? [];
}

async function claimsFor(db: D1Database, slotKey: string, localDate: string): Promise<ClaimRow[]> {
  const r = await db.prepare(
    `SELECT slot_key, local_date, kind, companion_id, claimed_at, delivered_at
       FROM med_claims WHERE slot_key = ? AND local_date = ?`,
  ).bind(slotKey, localDate).all<ClaimRow>();
  return r.results ?? [];
}

async function answerFor(db: D1Database, slotKey: string, localDate: string): Promise<{ answered_at: string; companion_id: string } | null> {
  return db.prepare(
    `SELECT answered_at, companion_id FROM med_answers WHERE slot_key = ? AND local_date = ?`,
  ).bind(slotKey, localDate).first<{ answered_at: string; companion_id: string }>();
}

/** A claim blocks a new one unless it was never delivered and has gone stale. */
function claimBlocks(c: ClaimRow | undefined, nowMs: number): boolean {
  if (!c) return false;
  if (c.delivered_at) return true;
  const at = Date.parse(c.claimed_at);
  return !Number.isFinite(at) || nowMs - at < MED_CLAIM_STALE_SECONDS * 1000;
}

/**
 * Doses this companion should send right now.
 *
 * FIRST reminder: the row's primary companion from the slot time; the fallback companion only
 * after `fallback_delay_seconds` AND only while nobody holds the claim. Expires unsent after
 * `late_window_minutes` (an outage never produces a morning reminder at night).
 *
 * FOLLOW-UP: only if the first was really delivered and no answer exists. Primary for it is
 * whoever sent the first (his answer goes to the DM he was asked in); the other listed companion
 * falls back after the delay. Anchored to the LATER of slot+followup and delivered+followup, so a
 * first that went out late is never chased by an immediate second message. One follow-up, ever:
 * the UNIQUE claim makes a third message impossible.
 *
 * A companion named on neither side of a row gets nothing for it (that is how Gaia is excluded).
 */
export async function resolveDue(db: D1Database, companion: string, nowIso: string): Promise<DueDose[]> {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return [];
  const out: DueDose[] = [];
  for (const row of await activeSchedule(db)) {
    const listed = row.primary_companion === companion || row.fallback_companion === companion;
    if (!listed) continue;
    const slotMin = slotMinutes(row.local_time);
    const now = localPartsIn(nowIso, row.tz);
    if (slotMin === null || !now) continue;
    const delayMin = row.fallback_delay_seconds / 60;
    for (const date of [addDays(now.date, -1), now.date]) {
      if (!scheduledOn(row, date)) continue;
      const elapsed = elapsedMinutes(now, date, slotMin);
      if (elapsed < 0) continue;
      const claims = await claimsFor(db, row.slot_key, date);
      const first = claims.find(c => c.kind === "first");
      const follow = claims.find(c => c.kind === "followup");

      // First reminder.
      const firstDelay = row.primary_companion === companion ? 0 : delayMin;
      if (!claimBlocks(first, nowMs) && elapsed >= firstDelay && elapsed < row.late_window_minutes) {
        if (!(await answerFor(db, row.slot_key, date))) {
          out.push({ slot_key: row.slot_key, local_date: date, kind: "first", label: row.label, local_time: row.local_time });
        }
        continue;
      }

      // Follow-up.
      const fu = row.followup_minutes ?? 0;
      if (fu <= 0 || !first?.delivered_at || claimBlocks(follow, nowMs)) continue;
      const followDelay = first.companion_id === companion ? 0 : delayMin;
      const deliveredMs = Date.parse(first.delivered_at);
      if (!Number.isFinite(deliveredMs)) continue;
      if (elapsed < fu + followDelay) continue;
      if (nowMs < deliveredMs + (fu + followDelay) * 60_000) continue;
      if (elapsed >= row.late_window_minutes + fu) continue;
      if (await answerFor(db, row.slot_key, date)) continue;
      out.push({ slot_key: row.slot_key, local_date: date, kind: "followup", label: row.label, local_time: row.local_time });
    }
  }
  return out;
}

// ── writes ──────────────────────────────────────────────────────────────────────────────────────

export interface ClaimInput {
  slot_key: string;
  local_date: string;
  kind: MedKind;
  companion: string;
  nowIso: string;
}

/**
 * Atomic claim. Exactly one caller wins per (slot, date, kind): the INSERT is guarded by the
 * UNIQUE constraint, so the Drevan/Cypher race and a restart both resolve to one sender. The
 * INSERT refuses when an answer already exists, and for a follow-up also when the first was never
 * delivered, in the same statement, so an answer landing between "due" and "claim" cancels the
 * follow-up rather than racing it. A stale undelivered claim (crash between claim and send) is
 * taken over by a conditional UPDATE; `changes === 1` is the only win.
 */
export async function claimDose(db: D1Database, c: ClaimInput): Promise<boolean> {
  const noAnswer = `NOT EXISTS (SELECT 1 FROM med_answers a WHERE a.slot_key = ?1 AND a.local_date = ?2)`;
  const firstDelivered = c.kind === "followup"
    ? ` AND EXISTS (SELECT 1 FROM med_claims f WHERE f.slot_key = ?1 AND f.local_date = ?2 AND f.kind = 'first' AND f.delivered_at IS NOT NULL)`
    : "";
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO med_claims (slot_key, local_date, kind, companion_id, claimed_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM med_schedule s WHERE s.slot_key = ?1)
          AND ${noAnswer}${firstDelivered}`,
  ).bind(c.slot_key, c.local_date, c.kind, c.companion, c.nowIso).run();
  if ((ins.meta?.changes ?? 0) === 1) return true;

  const cutoff = new Date(Date.parse(c.nowIso) - MED_CLAIM_STALE_SECONDS * 1000).toISOString();
  const upd = await db.prepare(
    `UPDATE med_claims SET companion_id = ?4, claimed_at = ?5, path = NULL
      WHERE slot_key = ?1 AND local_date = ?2 AND kind = ?3
        AND delivered_at IS NULL AND claimed_at < ?6
        AND ${noAnswer}`,
  ).bind(c.slot_key, c.local_date, c.kind, c.companion, c.nowIso, cutoff).run();
  return (upd.meta?.changes ?? 0) === 1;
}

/** The DM really went out. `path` is 'generated' or 'fallback:<reason>'; never content. */
export async function markDelivered(db: D1Database, c: ClaimInput & { path: string }): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE med_claims SET delivered_at = ?5, path = ?6
      WHERE slot_key = ?1 AND local_date = ?2 AND kind = ?3 AND companion_id = ?4 AND delivered_at IS NULL`,
  ).bind(c.slot_key, c.local_date, c.kind, c.companion, c.nowIso, c.path.slice(0, 60)).run();
  return (r.meta?.changes ?? 0) === 1;
}

/** The send failed: give the claim back so the other companion (or the next tick) can deliver it. */
export async function releaseClaim(db: D1Database, c: Omit<ClaimInput, "nowIso">): Promise<boolean> {
  const r = await db.prepare(
    `DELETE FROM med_claims
      WHERE slot_key = ? AND local_date = ? AND kind = ? AND companion_id = ? AND delivered_at IS NULL`,
  ).bind(c.slot_key, c.local_date, c.kind, c.companion).run();
  return (r.meta?.changes ?? 0) === 1;
}

export interface RecordedAnswer {
  slot_key: string;
  local_date: string;
  answered_at: string;
  answered_local: string | null;
}

/**
 * Record an affirmative answer he gave to `companion` at `answeredAtIso`. R-10: this is the only
 * write that describes him, and nothing else is ever recorded; no answer means no row.
 *
 * Which dose it answers: among doses THIS companion reminded him about (a delivered claim of either
 * kind), still unanswered, reminded at or before his message, and whose next occurrence has not yet
 * come, the one MOST RECENTLY reminded. That is the reminder he is looking at when he types "yes";
 * an older still-open dose is less likely to be what the word is about, and guessing wrong is
 * cheaper in that direction (the older dose simply stays "no answer", which P-2 renders honestly).
 */
export async function recordAnswer(db: D1Database, companion: string, answeredAtIso: string): Promise<RecordedAnswer | null> {
  const atMs = Date.parse(answeredAtIso);
  if (!Number.isFinite(atMs)) return null;
  const candidates = (await db.prepare(
    `SELECT c.slot_key, c.local_date, MAX(c.delivered_at) AS reminded_at,
            s.local_time, s.tz, s.weekday_mask, s.active_from
       FROM med_claims c JOIN med_schedule s ON s.slot_key = c.slot_key
      WHERE c.companion_id = ? AND c.delivered_at IS NOT NULL AND c.delivered_at <= ?
        AND NOT EXISTS (SELECT 1 FROM med_answers a WHERE a.slot_key = c.slot_key AND a.local_date = c.local_date)
      GROUP BY c.slot_key, c.local_date
      ORDER BY reminded_at DESC`,
  ).bind(companion, answeredAtIso).all<{
    slot_key: string; local_date: string; reminded_at: string;
    local_time: string; tz: string; weekday_mask: number; active_from: string | null;
  }>()).results ?? [];

  for (const cand of candidates) {
    // Before the next occurrence of the same slot: an answer after the next dose's time belongs to
    // the next dose (or to nothing), never to this one.
    const next = nextOccurrenceDate(cand, cand.local_date);
    const at = localPartsIn(answeredAtIso, cand.tz);
    const slotMin = slotMinutes(cand.local_time);
    if (!at || slotMin === null) continue;
    if (next !== null) {
      const atMin = at.hour * 60 + at.minute;
      if (at.date > next || (at.date === next && atMin >= slotMin)) continue;
    }
    const ins = await db.prepare(
      `INSERT OR IGNORE INTO med_answers (slot_key, local_date, answered_at, companion_id) VALUES (?, ?, ?, ?)`,
    ).bind(cand.slot_key, cand.local_date, answeredAtIso, companion).run();
    if ((ins.meta?.changes ?? 0) !== 1) continue;
    return { slot_key: cand.slot_key, local_date: cand.local_date, answered_at: answeredAtIso, answered_local: localHHMM(answeredAtIso, cand.tz) };
  }
  return null;
}

export interface MedStateEntry {
  slot_key: string;
  label: string;
  local_time: string;
  local_date: string;
  day: "today" | "yesterday";
  /** Local HH:MM he told a companion he took it, or null. NULL MEANS "NO ANSWER", NEVER "NOT TAKEN". */
  answered_local: string | null;
  answered_to: string | null;
}

/**
 * Every dose due so far today (slot time reached, scheduled today), with his answer if he gave
 * one. Before local noon, yesterday's afternoon/evening doses too. Reminded or not does not
 * matter: this is the dose's state, and the only state a dose has is "he told you" or "no answer".
 */
export async function medState(db: D1Database, nowIso: string): Promise<MedStateEntry[]> {
  const out: MedStateEntry[] = [];
  for (const row of await activeSchedule(db)) {
    const now = localPartsIn(nowIso, row.tz);
    const slotMin = slotMinutes(row.local_time);
    if (!now || slotMin === null) continue;
    const nowMin = now.hour * 60 + now.minute;
    const days: Array<{ date: string; day: "today" | "yesterday" }> = [];
    if (now.hour < MED_YESTERDAY_UNTIL_HOUR && slotMin >= MED_YESTERDAY_FROM_MINUTES) {
      days.push({ date: addDays(now.date, -1), day: "yesterday" });
    }
    if (slotMin <= nowMin) days.push({ date: now.date, day: "today" });
    for (const { date, day } of days) {
      if (!scheduledOn(row, date)) continue;
      const a = await answerFor(db, row.slot_key, date);
      out.push({
        slot_key: row.slot_key, label: row.label, local_time: row.local_time, local_date: date, day,
        answered_local: a ? localHHMM(a.answered_at, row.tz) : null,
        answered_to: a?.companion_id ?? null,
      });
    }
  }
  return out.sort((x, y) => (x.local_date + x.local_time).localeCompare(y.local_date + y.local_time));
}
