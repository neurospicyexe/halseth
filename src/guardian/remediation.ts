// src/guardian/remediation.ts
//
// Remediation hints (Wave 3 starvation fix, 2026-07-21). Guardian flags describe a
// condition but never named the verb that already existed to act on it -- Raziel read
// "loop stuck since 2026-06-01" with no idea "close loop <id>" was already a live
// Librarian phrase. One line per flag_type, naming the EXACT existing verb.
//
// Honesty over completeness: several flag_types have no companion-facing verb yet
// (voice_drift, burnout, echo_chamber, dead_writer, and every starved_organ subclass
// except the tension pool). Their hint says so plainly -- inventing a verb that doesn't
// exist would just move the starvation from "no hint" to "a hint that lies."

import type { CandidateFlag } from "./detectors.js";

export type GuardianFlagType = CandidateFlag["flag_type"];

export const REMEDIATION_HINTS: Record<GuardianFlagType, string> = {
  loop_stuck:
    'Close it ("close loop <id>") if it is actually done, or hold it with a named reason ' +
    '("hold loop <id>" / "review loop <id>") if it should stay open.',
  starved_organ:
    'If this is the empty tension pool, name one genuine tension ("log a tension: ..."). ' +
    "Other starved-organ conditions (metronome silence, empty seed queue, stale forage, a " +
    "stuck club round) have no companion verb yet -- surface it to Raziel.",
  orphan_memory:
    "Re-link it by engaging the note directly in conversation or journal (there is no " +
    "separate recall-by-id command), or consciously let it go.",
  basin_pressure:
    'Confirm the becoming ("confirm drift: ...") or dismiss the pressure ("dismiss drift: ' +
    '...") -- this is an identity-level call; take it to Raziel if unsure.',
  ratification_backlog:
    'Review the pending journal entries -- accept ("accept journal entry") or decline ' +
    '("decline journal entry") each one.',
  voice_drift: "No companion verb for this -- surface it to Raziel.",
  burnout: "No companion verb for this -- surface it to Raziel.",
  echo_chamber: "No companion verb for this -- surface it to Raziel.",
  dead_writer: "No companion verb for this -- surface it to Raziel.",
};

const FALLBACK_HINT = "No companion verb for this -- surface it to Raziel.";

/** Never throws, never returns undefined -- an unrecognized flag_type (schema drift) gets
 *  the honest fallback rather than an undefined hint silently vanishing from the prompt. */
export function remediationHint(flagType: string): string {
  return REMEDIATION_HINTS[flagType as GuardianFlagType] ?? FALLBACK_HINT;
}
