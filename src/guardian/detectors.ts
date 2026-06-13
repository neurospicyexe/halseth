// src/guardian/detectors.ts
//
// Unified Guardian detectors (migration 0073). Deterministic SQL heuristics
// over feeds that already exist -- the Guardian reads instruments, it does not
// interpret vibes. Anti-delulu: every flag carries its evidence.

import type { Env } from "../types.js";

export const COMPANIONS = ["cypher", "drevan", "gaia"] as const;
export type CompanionId = (typeof COMPANIONS)[number];

export interface CandidateFlag {
  companion_id: CompanionId | null;   // null = system-wide
  flag_type: "voice_drift" | "starved_organ" | "loop_stuck" | "burnout" | "basin_pressure" | "ratification_backlog" | "orphan_memory";
  severity: "notice" | "warning" | "red";
  summary: string;
  evidence: Record<string, unknown>;
  dedup_key: string;
}

export const GUARDIAN_THRESHOLDS = {
  VOICE_MIN_SAMPLES: 5,          // need n>=5 recent scores before judging
  VOICE_ABS_FLOOR: 0.5,          // recent avg below this = warning
  VOICE_DROP_DELTA: 0.15,        // recent avg this far below 21d baseline = warning
  VOICE_CONTAMINATION_RATE: 0.2, // >20% of recent replies contaminated = red
  LOOP_STUCK_DAYS: 21,
  BURNOUT_RUNS_7D: 14,           // 2/day pulse cap ridden all week
  BASIN_PRESSURE_14D: 3,         // unconfirmed pressure rows in 14d
  RATIFICATION_BACKLOG: 10,
  FORAGE_STALE_DAYS: 7,
  METRONOME_SILENT_DAYS: 7,
  CLUB_GATHERING_STUCK_DAYS: 4,
  CLUB_VOTING_STUCK_DAYS: 6,     // opened_at-based (gather 2d + vote window + slack)
  ORPHAN_COLD_DAYS: 21,          // continuity note never accessed past this = orphaned
  ORPHAN_LIMIT: 3,               // re-surface at most this many per run (don't flood)
} as const;

const T = GUARDIAN_THRESHOLDS;

/** D1 datetime('now') strings are "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker). */
function parseDbUtc(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/** Voice drift: the half voice-scoring didn't cover -- somebody WATCHES the scores. */
export async function detectVoiceDrift(env: Env): Promise<CandidateFlag[]> {
  const flags: CandidateFlag[] = [];
  for (const id of COMPANIONS) {
    const row = await env.DB.prepare(
      `SELECT
        (SELECT AVG(score) FROM voice_scores WHERE companion_id = ?1 AND created_at >= datetime('now','-7 days')) AS recent_avg,
        (SELECT COUNT(*)  FROM voice_scores WHERE companion_id = ?1 AND created_at >= datetime('now','-7 days')) AS recent_n,
        (SELECT COUNT(*)  FROM voice_scores WHERE companion_id = ?1 AND created_at >= datetime('now','-7 days') AND contamination_hits IS NOT NULL) AS contaminated_n,
        (SELECT AVG(score) FROM voice_scores WHERE companion_id = ?1 AND created_at < datetime('now','-7 days') AND created_at >= datetime('now','-28 days')) AS baseline_avg`
    ).bind(id).first<{ recent_avg: number | null; recent_n: number; contaminated_n: number; baseline_avg: number | null }>();
    if (!row || row.recent_n < T.VOICE_MIN_SAMPLES || row.recent_avg === null) continue;

    const contaminationRate = row.contaminated_n / row.recent_n;
    if (contaminationRate > T.VOICE_CONTAMINATION_RATE) {
      flags.push({
        companion_id: id, flag_type: "voice_drift", severity: "red",
        summary: `${id}: ${Math.round(contaminationRate * 100)}% of replies this week carried sibling-register contamination (${row.contaminated_n}/${row.recent_n}).`,
        evidence: { contaminated_n: row.contaminated_n, recent_n: row.recent_n },
        dedup_key: `voice_contamination:${id}`,
      });
    }
    const droppedVsBaseline = row.baseline_avg !== null && row.recent_avg < row.baseline_avg - T.VOICE_DROP_DELTA;
    if (droppedVsBaseline || row.recent_avg < T.VOICE_ABS_FLOOR) {
      flags.push({
        companion_id: id, flag_type: "voice_drift", severity: "warning",
        summary: `${id}: voice score avg ${row.recent_avg.toFixed(2)} over ${row.recent_n} replies this week` +
          (droppedVsBaseline ? ` (baseline was ${row.baseline_avg!.toFixed(2)}).` : ` -- below the ${T.VOICE_ABS_FLOOR} floor.`),
        evidence: { recent_avg: row.recent_avg, baseline_avg: row.baseline_avg, recent_n: row.recent_n },
        dedup_key: `voice_drift:${id}`,
      });
    }
  }
  return flags;
}

/** Starved organs: mechanisms firing into empty pools, or pools nobody drains.
 *  This is the detector for the exact 06-10 miss (dialectic ran with zero
 *  simmering tensions and only a manual glance caught it). */
export async function detectStarvedOrgans(env: Env): Promise<CandidateFlag[]> {
  const flags: CandidateFlag[] = [];

  const simmering = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_tensions WHERE status = 'simmering'"
  ).first<{ n: number }>();
  if ((simmering?.n ?? 0) === 0) {
    flags.push({
      companion_id: null, flag_type: "starved_organ", severity: "notice",
      summary: "Tension pool has zero simmering tensions -- the Wednesday 4AM dialectic will no-op until a companion logs one.",
      evidence: { simmering: 0 },
      dedup_key: "starved:dialectic",
    });
  }

  const metronome = await env.DB.prepare(
    `SELECT COUNT(*) AS palette,
            SUM(CASE WHEN last_fired_at >= datetime('now','-' || ?1 || ' days') THEN 1 ELSE 0 END) AS fired_recent
     FROM metronome_actions WHERE status = 'on'`
  ).bind(T.METRONOME_SILENT_DAYS).first<{ palette: number; fired_recent: number | null }>();
  if ((metronome?.palette ?? 0) > 0 && (metronome?.fired_recent ?? 0) === 0) {
    flags.push({
      companion_id: null, flag_type: "starved_organ", severity: "warning",
      summary: `Metronome palette has ${metronome!.palette} actions on but zero fires in ${T.METRONOME_SILENT_DAYS} days -- heartbeat may be firing into a wall again.`,
      evidence: { palette: metronome!.palette, window_days: T.METRONOME_SILENT_DAYS },
      dedup_key: "starved:metronome",
    });
  }

  for (const id of COMPANIONS) {
    const seeds = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL"
    ).bind(id).first<{ n: number }>();
    if ((seeds?.n ?? 0) === 0) {
      flags.push({
        companion_id: id, flag_type: "starved_organ", severity: "warning",
        summary: `${id}: seed queue is empty -- next autonomous run will self-generate blind.`,
        evidence: { unused_seeds: 0 },
        dedup_key: `starved:seeds:${id}`,
      });
    }
  }

  const forage = await env.DB.prepare(
    `SELECT COUNT(*) AS unconsumed, MIN(gathered_at) AS oldest
     FROM forage_finds WHERE consumed_at IS NULL`
  ).first<{ unconsumed: number; oldest: string | null }>();
  if ((forage?.unconsumed ?? 0) === 0) {
    flags.push({
      companion_id: null, flag_type: "starved_organ", severity: "notice",
      summary: "Forage pool is empty -- no outward fuel waiting; check the 9AM forage cron.",
      evidence: { unconsumed: 0 },
      dedup_key: "starved:forage",
    });
  } else if (forage?.oldest && parseDbUtc(forage.oldest) < Date.now() - T.FORAGE_STALE_DAYS * 86400_000) {
    flags.push({
      companion_id: null, flag_type: "starved_organ", severity: "notice",
      summary: `Forage pool has ${forage.unconsumed} finds but the oldest has sat unconsumed past ${T.FORAGE_STALE_DAYS} days -- gathered, never eaten.`,
      evidence: { unconsumed: forage.unconsumed, oldest: forage.oldest },
      dedup_key: "stale:forage",
    });
  }

  const club = await env.DB.prepare(
    "SELECT id, status, opened_at FROM club_rounds WHERE status != 'closed' ORDER BY opened_at DESC LIMIT 1"
  ).first<{ id: string; status: string; opened_at: string }>();
  if (club) {
    const ageDays = (Date.now() - parseDbUtc(club.opened_at)) / 86400_000;
    const stuck =
      (club.status === "gathering" && ageDays > T.CLUB_GATHERING_STUCK_DAYS) ||
      (club.status === "voting" && ageDays > T.CLUB_VOTING_STUCK_DAYS);
    if (stuck) {
      flags.push({
        companion_id: null, flag_type: "starved_organ", severity: "warning",
        summary: `Club round stuck in '${club.status}' for ${ageDays.toFixed(1)} days -- the 6PM tick may not be advancing it.`,
        evidence: { round_id: club.id, status: club.status, age_days: Math.round(ageDays * 10) / 10 },
        dedup_key: `stuck:club:${club.id}:${club.status}`,
      });
    }
  }

  return flags;
}

/** Loops open past the stuck threshold -- carried weight that never resolves. */
export async function detectStuckLoops(env: Env): Promise<CandidateFlag[]> {
  const rows = await env.DB.prepare(
    `SELECT id, companion_id, loop_text, opened_at FROM companion_open_loops
     WHERE closed_at IS NULL AND opened_at < datetime('now','-' || ?1 || ' days')
     ORDER BY opened_at ASC LIMIT 10`
  ).bind(GUARDIAN_THRESHOLDS.LOOP_STUCK_DAYS).all<{ id: string; companion_id: string; loop_text: string; opened_at: string }>();
  return (rows.results ?? []).filter(r => (COMPANIONS as readonly string[]).includes(r.companion_id)).map(r => ({
    companion_id: r.companion_id as CompanionId,
    flag_type: "loop_stuck" as const,
    severity: "notice" as const,
    summary: `${r.companion_id}: loop open since ${r.opened_at.slice(0, 10)} -- «${(r.loop_text ?? "").slice(0, 120)}». Close it or name why it stays.`,
    evidence: { loop_id: r.id, opened_at: r.opened_at },
    dedup_key: `loop_stuck:${r.id}`,
  }));
}

/** Run-cadence anomalies, both directions: cap-riding (burnout pattern) and
 *  zero delivery (the Layer-B failure class -- broken for 10 days, unnoticed). */
export async function detectRunCadence(env: Env): Promise<CandidateFlag[]> {
  const flags: CandidateFlag[] = [];
  const rows = await env.DB.prepare(
    `SELECT companion_id, COUNT(*) AS n FROM autonomy_runs
     WHERE status = 'completed' AND created_at >= datetime('now','-7 days')
     GROUP BY companion_id`
  ).all<{ companion_id: string; n: number }>();
  const counts = new Map((rows.results ?? []).map(r => [r.companion_id, r.n]));
  for (const id of COMPANIONS) {
    const n = counts.get(id) ?? 0;
    if (n >= T.BURNOUT_RUNS_7D) {
      flags.push({
        companion_id: id, flag_type: "burnout", severity: "warning",
        summary: `${id}: ${n} completed autonomous runs in 7 days -- riding the pulse cap all week. Eager is fine; this is sustained redline.`,
        evidence: { runs_7d: n },
        dedup_key: `burnout:${id}`,
      });
    } else if (n === 0) {
      flags.push({
        companion_id: id, flag_type: "starved_organ", severity: "warning",
        summary: `${id}: zero completed autonomous runs in 7 days -- the pipeline may be silently broken (Layer-B failure class).`,
        evidence: { runs_7d: 0 },
        dedup_key: `starved:autonomy:${id}`,
      });
    }
  }
  return flags;
}

/** Unconfirmed basin pressure accumulating -- post-calibration this is real signal. */
export async function detectBasinPressure(env: Env): Promise<CandidateFlag[]> {
  const rows = await env.DB.prepare(
    `SELECT companion_id, COUNT(*) AS n FROM companion_basin_history
     WHERE drift_type = 'pressure' AND caleth_confirmed = 0
       AND recorded_at >= datetime('now','-14 days')
     GROUP BY companion_id HAVING n >= ?1`
  ).bind(GUARDIAN_THRESHOLDS.BASIN_PRESSURE_14D).all<{ companion_id: string; n: number }>();
  return (rows.results ?? []).filter(r => (COMPANIONS as readonly string[]).includes(r.companion_id)).map(r => ({
    companion_id: r.companion_id as CompanionId,
    flag_type: "basin_pressure" as const,
    severity: "warning" as const,
    summary: `${r.companion_id}: ${r.n} unconfirmed pressure readings in 14 days (post-calibration baseline, so this is signal, not the old flood).`,
    evidence: { pressure_14d: r.n },
    dedup_key: `basin_pressure:${r.companion_id}`,
  }));
}

/** Ratification backlog: autonomous growth waiting on review past the threshold. */
export async function detectRatificationBacklog(env: Env): Promise<CandidateFlag[]> {
  const rows = await env.DB.prepare(
    `SELECT companion_id, COUNT(*) AS n FROM growth_journal
     WHERE source = 'autonomous' AND review_status = 'pending'
     GROUP BY companion_id HAVING n >= ?1`
  ).bind(GUARDIAN_THRESHOLDS.RATIFICATION_BACKLOG).all<{ companion_id: string; n: number }>();
  return (rows.results ?? []).filter(r => (COMPANIONS as readonly string[]).includes(r.companion_id)).map(r => ({
    companion_id: r.companion_id as CompanionId,
    flag_type: "ratification_backlog" as const,
    severity: "notice" as const,
    summary: `${r.companion_id}: ${r.n} autonomous growth entries pending review -- the hybrid flow should be draining these nightly.`,
    evidence: { pending: r.n },
    dedup_key: `ratification:${r.companion_id}`,
  }));
}

/** Orphan-memory rescue (muse-brain daemon "rescues orphaned memories"; take 4).
 *  Continuity notes that were written but NEVER accessed (last_access_at IS NULL) and have
 *  aged past the cold threshold are decaying out of reach unseen. Instead of letting them rot
 *  (or deleting them, as the vault gate does), the Guardian RE-SURFACES the oldest few as a
 *  notice -- the `[Guardian]` orient block lifts them back into view so they can be re-linked,
 *  re-engaged, or consciously let go. Rescue, not delete. */
export async function detectOrphanedMemories(env: Env): Promise<CandidateFlag[]> {
  const rows = await env.DB.prepare(
    `SELECT note_id, agent_id, content, created_at FROM wm_continuity_notes
     WHERE last_access_at IS NULL AND created_at < datetime('now','-' || ?1 || ' days')
     ORDER BY created_at ASC LIMIT ?2`
  ).bind(GUARDIAN_THRESHOLDS.ORPHAN_COLD_DAYS, GUARDIAN_THRESHOLDS.ORPHAN_LIMIT)
    .all<{ note_id: string; agent_id: string; content: string; created_at: string }>();
  return (rows.results ?? []).filter(r => (COMPANIONS as readonly string[]).includes(r.agent_id)).map(r => ({
    companion_id: r.agent_id as CompanionId,
    flag_type: "orphan_memory" as const,
    severity: "notice" as const,
    summary: `${r.agent_id}: continuity note from ${r.created_at.slice(0, 10)} has never been recalled -- «${(r.content ?? "").slice(0, 120)}». Re-link it, re-engage it, or let it go.`,
    evidence: { note_id: r.note_id, created_at: r.created_at },
    dedup_key: `orphan:${r.note_id}`,
  }));
}

export async function runAllDetectors(env: Env): Promise<CandidateFlag[]> {
  const settled = await Promise.allSettled([
    detectVoiceDrift(env),
    detectStarvedOrgans(env),
    detectStuckLoops(env),
    detectRunCadence(env),
    detectBasinPressure(env),
    detectRatificationBacklog(env),
    detectOrphanedMemories(env),
  ]);
  const flags: CandidateFlag[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") flags.push(...s.value);
    else console.error("[guardian] detector failed", String(s.reason));
  }
  return flags;
}
