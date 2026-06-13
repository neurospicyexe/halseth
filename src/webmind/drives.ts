// src/webmind/drives.ts
//
// Drive-based proactive contact (OpenHer; inspo-takes-2026-06-13 take 9). A companion
// reaches out because a *need* crossed a threshold, not because a cron fired. The
// relational_need float ACCUMULATES over untended time and is shed ON CONTACT. Like
// heat.ts, decay/accrual is LAZY (computed at read from last_event_at) -- NO cron.
//
// Lane gate (CLAUDE.md): Gaia escalates monastically (modality stays minimal); only
// Cypher/Drevan reach for voice when the need runs high. A need never overflows (clamp
// at 1) and never self-soothes (accrual is monotonic; only contact sheds it).

export type Modality = "text" | "voice";

const HOURS_PER_DAY = 24;

/** Need accrued from `level` after `hours` untended, at `perDay` rate. Clamped [0,1], monotonic. */
export function accruedLevel(level: number, perDay: number, hours: number): number {
  const grown = level + perDay * (Math.max(0, hours) / HOURS_PER_DAY);
  return Math.min(1, Math.max(level, grown));
}

/** Level after shedding `fraction` on contact (1.0 = full reset). */
export function decayedLevel(level: number, fraction: number): number {
  return Math.max(0, level * (1 - Math.max(0, Math.min(1, fraction))));
}

/** A drive fires its reach-out at or above threshold. */
export function driveFired(level: number, threshold: number): boolean {
  return level >= threshold;
}

/**
 * Modality for a fired reach-out, lane-gated. Gaia stays monastic (text only) however
 * high the need; Cypher/Drevan reach for voice once the need runs high (>= 0.9).
 */
export function selectModality(companionId: string, level: number): Modality {
  if (companionId === "gaia") return "text";
  return level >= 0.9 ? "voice" : "text";
}

/** Hours elapsed since a D1 datetime string ("YYYY-MM-DD HH:MM:SS" UTC), clamped >= 0. */
export function hoursSinceIso(iso: string | null | undefined, nowMs = Date.now()): number {
  if (!iso) return 0;
  const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? 0 : Math.max(0, (nowMs - ms) / 3_600_000);
}

// ── SQL builders (asserted as strings in tests; D1 is the runtime) ──────────────

/** Read a companion's drives. Bind: [companion_id]. */
export function readDrivesSql(): string {
  return `SELECT id, drive_key, level, accumulate_per_day, decay_on_contact, threshold, last_event_at FROM companion_drives WHERE companion_id = ?`;
}

/** Persist a lazily-accrued level + restamp. Bind: [level, id]. */
export function upsertDriveAccrualSql(): string {
  return `UPDATE companion_drives SET level = ?, last_event_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`;
}

/** Shed a drive on Raziel contact. Bind: [newLevel, companion_id, drive_key]. */
export function contactResetSql(): string {
  return `UPDATE companion_drives SET level = ?, last_event_at = datetime('now'), updated_at = datetime('now') WHERE companion_id = ? AND drive_key = ?`;
}
