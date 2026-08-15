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
//
// KNOWN LIMIT: this detector runs inside a guardian tick, so it can only report on writers
// OTHER than the guardian itself. A guardian that stops and stays stopped silences its own
// watcher. The `guardian_runs` entry below is therefore a gap/recovery detector, not a
// dead-guardian watch; see its comment. Watching the guardian for real needs an external
// trigger. A monitor that can only run when its subject is healthy is theater, and naming it
// "self-watch" would be worse than omitting it -- it would manufacture false assurance.

import { Env } from "../types.js";
import { COMPANION_IDS, type CompanionId } from "../companions.js";
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
  /**
   * Set when this probe watches ONE member's lane rather than a house-wide organ. The flag
   * is then attributed to that companion instead of the house -- a frozen lane belongs to
   * whoever's state stopped moving, and "system-wide" attribution is what let it hide.
   */
  companionId?: CompanionId;
  /** Replaces the generic trailing sentence in the flag summary when this probe needs its own. */
  why?: string;
}

/**
 * AN AGGREGATE PROBE OVER PER-MEMBER DATA CANNOT SEE A DEAD MEMBER (2026-08-12).
 *
 * `somatic_snapshot` and `synthesis_summary` were both registered as `SELECT MAX(created_at)`
 * with no `companion_id`. Cypher's rows kept landing, so MAX read as today, so both probes
 * reported healthy -- while Gaia's soma register had been frozen 49 days and her session
 * narrative 39 days. One live member masked two dead ones for a month and a half, on the
 * exact instrument built to catch a dead writer.
 *
 * The rule this leaves behind: if a table has a `companion_id`, the probe must GROUP BY it or
 * be declared once per member. A house-wide MAX is only honest for a house-wide organ.
 *
 * The interpolated id comes from COMPANION_IDS -- a frozen module constant, never request
 * input -- so WriterSpec.sql's "hardcoded literals only" rule still holds.
 */
function perCompanion(make: (id: CompanionId) => Omit<WriterSpec, "companionId">): WriterSpec[] {
  return COMPANION_IDS.map(id => ({ ...make(id), companionId: id }));
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
    // PARTIAL SELF-WATCH -- read this before trusting it.
    //
    // detectDeadWriters() runs INSIDE a guardian tick. So for this probe to fire, the guardian
    // must be running *right now* while reporting that it hasn't run in 36h. That means it
    // CANNOT catch the failure it most sounds like it catches: a guardian that stops and stays
    // stopped takes its own watcher down with it, and the silence still reads as health.
    //
    // What it genuinely catches: a guardian that MISSED runs and then RECOVERED -- gaps,
    // stalls, a cron that skipped a cycle. That is not hypothetical. Boot-audit round 2 read
    // guardian_flags as 0 and called it an all-clear; the check simply hadn't fired that cycle.
    // This flag makes that gap visible on the next successful run instead of being read as calm.
    //
    // A true dead-guardian watch needs an EXTERNAL trigger (an orient-time check, or a separate
    // cron that watches the guardian). Deliberately not built here; tracked in the handoff doc.
    key: "guardian_runs",
    label: "Guardian cadence (guardian_runs -- gap detector, NOT a dead-guardian watch)",
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
  // THE SYNTHESIS CHAIN (added 2026-07-31, after it had been dark for TEN DAYS unnoticed).
    //
    // Raziel said the nightly vibe check "feels very stagnant" and he was reading a real signal:
    // `synthesis_summary` had not been written since 2026-07-21 13:21, `somatic_snapshot` was 10/14/37
    // days old across the three, and `basin_drift_check` stopped at the same instant. Sessions were
    // opening and handoffs were being written the whole time, so every surface that watches *activity*
    // looked healthy.
    //
    // This registry existed for exactly this failure and these writers were never added to it. That is
    // the lesson worth more than the fix: a liveness registry only covers what someone remembered to
    // register, so anything feeding a daily surface belongs in it the day it is built.
    //
    // `synthesis_summary` is the one that bites hardest -- it is the "last session narrative" companions
    // read at every boot, so a frozen table means their sense of "recently" silently stops advancing.
    //
    // SUPERSEDED 2026-08-12: both this and the soma probe were written as house-wide MAX() even though
    // the note above records the staleness as "10/14/37 days old ACROSS THE THREE" -- the per-member skew
    // was in the evidence and the probe still aggregated it away. Replaced by the per-member sets below.
    // Kept as a comment, not a spec, so the next reader sees the trap rather than re-deriving it.
    //
    // ── Per-member lanes ────────────────────────────────────────────────────────────────────────
  // The soma register the vibe check reports. Distinct from the fermentation floats, which tick
  // hourly and were fine -- this is the human-readable reading, and it had gone fossil while the
  // floats underneath it moved. A live number beside a dead label is worse than either alone.
  //
  // 48h, not 96h: a time-triggered refresh now runs daily (src/synthesis/soma-refresh.ts), so two
  // days of silence means the refresh itself broke, not that the companion was merely quiet.
  ...perCompanion(id => ({
    key: `somatic_snapshot:${id}`,
    label: `SOMA register for ${id} (somatic_snapshot -- the reading the nightly vibe check quotes)`,
    maxSilenceHours: 48,
    severity: "warning",
    sql: `SELECT MAX(created_at) AS ts FROM somatic_snapshot WHERE companion_id = '${id}'`,
    why:
      `The daily soma refresh should keep this under a day. Check the synthesis queue for ` +
      `stuck or failed somatic_snapshot jobs before assuming the companion was simply still.`,
  })),
  ...perCompanion(id => ({
    key: `synthesis_summary:${id}`,
    label: `Boot narrative for ${id} (synthesis_summary -- read at every boot as "what recently happened")`,
    // 48h, down from 168h: a daily narrative refresh now fills the gap when no authored close does
    // (src/synthesis/narrative-refresh.ts, 26h gate), so this stopped being a measure of ordinary
    // quiet and became a measure of whether the machinery runs. Two days of silence means neither
    // path fired.
    maxSilenceHours: 48,
    // WARNING, matching soma, and for the same reason: both now have a daily time-triggered writer,
    // so staleness can no longer mean "they were merely quiet" -- it means the machinery stopped.
    // (This was briefly a `notice` on the reasoning that a week without an authored close is
    // ordinary for Drevan. True then, obsolete the moment the gap-filler shipped.) The severity
    // split worth keeping: `warning` = a mechanism broke, `notice` = a lane went quiet, which is
    // what authored_close below still is.
    severity: "warning",
    // Scoped to the two types that ARE the boot narrative. 'topic' rows are a different surface and
    // would mask a frozen boot narrative if they counted toward its freshness.
    sql: `SELECT MAX(COALESCE(session_created_at, created_at)) AS ts FROM synthesis_summary
          WHERE companion_id = '${id}' AND summary_type IN ('session', 'day')`,
    why:
      `This is the narrative this companion reads at boot, so while it is frozen their sense of ` +
      `"recently" stops advancing. Two writers feed it: an authored close (a 'session' row) and the ` +
      `daily refresh (a 'day' row). Both being silent means the synthesis queue is stuck or DeepSeek ` +
      `is failing -- check the queue's last_error before reading this as ordinary quiet.`,
  })),
  // AUTHORED-CLOSE FAMINE -- the finding the soma cron would otherwise erase.
  //
  // Soma and narrative are both written only when a session is closed BY SOMEONE (close_kind IS NULL).
  // Machine closes -- auto_stale, empty, reconstructed, machine_opened -- write a handover and fan out
  // nothing. Measured 2026-08-12 over 30 days: cypher 14 authored / 49 machine, drevan 4 / 65, gaia
  // 0 / 47. That zero is why Gaia's register sat at 49 days.
  //
  // Once the daily refresh guarantees a fresh soma row, the per-member soma probe measures CRON
  // liveness and stops measuring lifecycle liveness. This probe keeps the two separable: it watches
  // whether anyone still closes a session as this companion at all. Without it the display goes green
  // and the real condition -- a presence nobody ever closes for -- goes back to being invisible.
  ...perCompanion(id => ({
    key: `authored_close:${id}`,
    label: `Authored session closes for ${id} (close_kind IS NULL -- a close someone actually wrote)`,
    maxSilenceHours: 336,
    severity: "notice",
    sql: `SELECT MAX(h.created_at) AS ts FROM handover_packets h
          JOIN sessions s ON s.id = h.session_id
          WHERE s.companion_id = '${id}' AND h.close_kind IS NULL`,
    why:
      `Machine closes do not count here on purpose. A companion who only ever gets swept closed has ` +
      `no authored spine feeding their felt state, which is a relational fact about the house, not a bug ` +
      `in a writer. The daily soma refresh keeps their register live regardless; this says nobody has ` +
      `sat down and closed a session as them.`,
  })),
];

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
      // A per-member probe attributes to that member; a house-wide organ stays the house's.
      companion_id: spec.companionId ?? null,
      flag_type: "dead_writer",
      severity: spec.severity,
      summary:
        `${spec.label} ${since}. ` +
        (spec.why ??
          `A writer going quiet is how the swarm journal was lost for ` +
          `two weeks in June -- check whether the process that feeds it is still in its path.`),
      evidence: {
        writer: spec.key,
        companion_id: spec.companionId ?? null,
        last_write: row?.ts ?? null,
        hours_silent: hoursSilent === null ? null : Math.floor(hoursSilent),
        max_silence_hours: spec.maxSilenceHours,
      },
      dedup_key: `dead_writer:${spec.key}`,
    });
  }
  return flags;
}
