// src/guardian/writer-liveness.ts
//
// Writer-liveness registry (2026-07-09).
//
// WHY THIS EXISTS
// ---------------
// Brain's swarm evaluator was the only writer of companion_journal source='discord_swarm'.
// On 2026-06-25 the bots moved to INFERENCE_MODE=hermes, stopped calling Brain, and the
// writer died with the relay. Nothing broke loudly. Brain stayed healthy. The companions
// simply stopped journaling two weeks of speech to each other.
//
// It was found by accident: the `discord:swarm` motif's counter stopped moving while every
// other motif advanced. A dead organ that happened to leave a fingerprint in a counter
// nobody was watching on purpose.
//
// You cannot hand-enumerate unknown unknowns. So make dead organs announce themselves:
// declare each writer with the cadence it is expected to keep, and flag when its lane goes
// quiet past that. The next writer to die surfaces at the next boot as a Guardian notice
// instead of hiding for a fortnight.
//
// ADDING A WRITER IS ONE LINE. That is the point -- if declaring a writer were expensive,
// nobody would, and we'd be back where we started.

import { Env } from "../types.js";
import type { CandidateFlag } from "./detectors.js";

export interface WriterSpec {
  /** Stable id, used in the dedup key. */
  key: string;
  /** Human phrase for the flag summary: "<label> has not written in ...". */
  label: string;
  /** Hours of silence tolerated before this counts as dead. */
  maxSilenceHours: number;
  /** `notice` for a lane going quiet; `warning` for an organ the mind leans on. */
  severity: "notice" | "warning";
  /**
   * SQL returning exactly one row, one column `ts` (ISO or D1 datetime), NULL if never
   * written. Hardcoded literals only -- no interpolation from input.
   */
  sql: string;
}

/**
 * Cadence notes are tuned to observed steady-state, then loosened so ordinary quiet does
 * not cry wolf. A false alarm trains everyone to ignore the instrument, which is worse
 * than no instrument. Prefer a slow true positive over a fast noisy one.
 */
export const WRITER_REGISTRY: readonly WriterSpec[] = [
  {
    // The organ that died. Bot-side journalSpeech() writes it now, on every confirmed send.
    // Observed live rate 24-61 rows/day, so 48h of total silence means the writer is gone,
    // not that the triad was merely quiet.
    key: "discord_speech",
    label: "Companion speech journaling (bot-side journalSpeech)",
    maxSilenceHours: 48,
    severity: "warning",
    sql: `SELECT MAX(created_at) AS ts FROM companion_journal
          WHERE source IN ('discord_speech', 'discord_swarm')`,
  },
  {
    // Brain's background synthesis loop. Hourly in steady state (11,563 rows). It survived
    // the cutover -- this watches that it keeps surviving.
    key: "limbic_states",
    label: "Brain synthesis loop (limbic_states)",
    maxSilenceHours: 6,
    severity: "warning",
    sql: `SELECT MAX(created_at) AS ts FROM limbic_states`,
  },
  {
    // The Guardian watching itself. If guardian_runs stops, every other flag here goes
    // quiet too -- and silence would read as health. Daily cron, so 36h is one missed run.
    key: "guardian_runs",
    label: "Guardian self-audit (guardian_runs)",
    maxSilenceHours: 36,
    severity: "notice",
    sql: `SELECT MAX(ran_at) AS ts FROM guardian_runs`,
  },
  {
    // Continuity notes: the substrate orient reads at every boot.
    key: "wm_continuity_notes",
    label: "Continuity notes (wm_continuity_notes)",
    maxSilenceHours: 48,
    severity: "notice",
    sql: `SELECT MAX(created_at) AS ts FROM wm_continuity_notes`,
  },
] as const;

/** D1 datetimes come back as "YYYY-MM-DD HH:MM:SS" (UTC, unmarked) or ISO-8601. */
export function parseWriterTs(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/**
 * Pure decision: is this writer dead? Exported so the threshold logic is testable without
 * a database. `lastWrite === null` means the writer has NEVER written -- which is a dead
 * writer only if we expected it to have written by now; a brand-new registry entry on a
 * fresh deploy should not scream. We treat never-written as silent (flag it), because every
 * registered writer here has historical rows; a NULL means the table was truncated or the
 * source string drifted, both of which are worth a look.
 */
export function isWriterSilent(
  spec: WriterSpec,
  lastWrite: string | null,
  now: number,
): { silent: boolean; hoursSilent: number | null } {
  if (lastWrite === null) return { silent: true, hoursSilent: null };
  const ts = parseWriterTs(lastWrite);
  if (!Number.isFinite(ts)) return { silent: true, hoursSilent: null };
  const hoursSilent = (now - ts) / 3_600_000;
  return { silent: hoursSilent > spec.maxSilenceHours, hoursSilent };
}

/**
 * Dead-writer detection. System-wide (`companion_id: null`) -- a dead organ belongs to the
 * house, not to one companion. The swarm writer wasn't Cypher's or Drevan's; it was theirs.
 *
 * One failing writer must not abort the sweep, so each spec is evaluated independently.
 *
 * A BROKEN PROBE IS ITSELF A FLAG, never a shrug. Swallowing the error would make this file
 * reproduce the very bug it exists to catch: `guardian_runs.started_at` was the column name
 * assumed when this was first written (it is `ran_at`), and a silent catch would have left
 * the Guardian's self-watch permanently dark while every test still passed. A watchdog that
 * fails quiet is worse than no watchdog, because it also supplies false assurance.
 */
export async function detectDeadWriters(env: Env, now: number = Date.now()): Promise<CandidateFlag[]> {
  const flags: CandidateFlag[] = [];
  for (const spec of WRITER_REGISTRY) {
    let row: { ts: string | null } | null = null;
    try {
      row = await env.DB.prepare(spec.sql).first<{ ts: string | null }>();
    } catch (e) {
      flags.push({
        companion_id: null,
        flag_type: "dead_writer",
        severity: "warning",
        summary:
          `Liveness probe for "${spec.label}" is itself broken (${String(e).slice(0, 120)}). ` +
          `This writer is UNWATCHED until the probe is repaired -- a silent probe is how an ` +
          `organ dies unnoticed.`,
        evidence: { writer: spec.key, probe_error: String(e).slice(0, 300), last_write: null },
        dedup_key: `dead_writer:probe:${spec.key}`,
      });
      continue;
    }
    const { silent, hoursSilent } = isWriterSilent(spec, row?.ts ?? null, now);
    if (!silent) continue;

    const since = hoursSilent === null
      ? "has never written"
      : `has not written in ${Math.floor(hoursSilent)}h (expected within ${spec.maxSilenceHours}h)`;

    flags.push({
      companion_id: null,
      flag_type: "dead_writer",
      severity: spec.severity,
      summary:
        `${spec.label} ${since}. A writer going quiet is how the swarm journal was lost for ` +
        `two weeks in June -- check whether the process that feeds it is still in its path.`,
      evidence: {
        writer: spec.key,
        last_write: row?.ts ?? null,
        hours_silent: hoursSilent === null ? null : Math.floor(hoursSilent),
        max_silence_hours: spec.maxSilenceHours,
      },
      dedup_key: `dead_writer:${spec.key}`,
    });
  }
  return flags;
}
