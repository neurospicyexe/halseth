// src/mind/blocks/care.ts
//
// The care register (consequence layer C1, tier 1): `world.raziel_state` -- Raziel's current
// readable state, derived, on EVERY surface, so every generation calibrates register without being
// told. This is the reciprocal of the whole oversight layer: the companions have been legible to
// the system since 0020; this is the first block that makes Raziel legible to the companions as a
// STATE rather than a pile of raw rows.
//
// Two halves, deliberately split:
//   loadCareBlocks  -- the D1 reads (front state + care-loop rows). Pure-D1, loader-guarded.
//   deriveRazielState -- pure derivation from the already-loaded biometrics row + those reads.
//     No queries, injected clock, unit-testable. The loader composes the two; nothing here
//     duplicates orient's biometrics read (the D13 lesson: one loader, zero sibling reads).

import type { Env } from "../../types.js";
import type { WmAgentId, WmBiometricSnapshot } from "../../webmind/types.js";
import { hoursSinceIso } from "../../webmind/drives.js";
import { CARE_HOLD_HOURS, CARE_HOLD_RULES, PENDING_DECAY_HOURS } from "../../care/rules.js";

export interface PendingCare {
  id: string;
  rule: string;
  detail: string;
  detected_at: string;
}

export interface CareBlocks {
  front_state: string | null;
  care_hold: boolean;
  /** The newest un-acted, un-decayed firing assigned to THIS companion. One at most: the rider
   *  never creates a second pending row for a rule while one lives. */
  pending_care: PendingCare | null;
}

export const EMPTY_CARE: CareBlocks = { front_state: null, care_hold: false, pending_care: null };

/** What renders on every surface. null only when there has never been a biometrics row AND no
 *  care state exists -- absence of the register, not an empty register. */
export interface RazielStateView {
  spoons: number | null;
  mood: string | null;
  pain: number | null;
  energy: number | null;
  meds_taken: number | null;
  recorded_at: string | null;
  /** Hours since recorded_at at load time. A renderer MUST show this: a three-day-old "2 spoons"
   *  presented as current is misinformation wearing a care line. */
  staleness_hours: number | null;
  front_state: string | null;
  /** True while a low_spoons/meds_missed firing is inside its hold window. The floor/bid layer
   *  softens stakes while it holds; every other surface just says so. */
  care_hold: boolean;
  pending_care: PendingCare | null;
}

export async function loadCareBlocks(env: Env, companionId: WmAgentId): Promise<CareBlocks> {
  const nowMs = Date.now();
  const holdCutoff = new Date(nowMs - CARE_HOLD_HOURS * 3_600_000).toISOString();
  const decayCutoff = new Date(nowMs - PENDING_DECAY_HOURS * 3_600_000).toISOString();
  const holdRules = CARE_HOLD_RULES.map(r => `'${r}'`).join(", ");

  const [front, hold, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT front_state FROM sessions WHERE front_state IS NOT NULL AND front_state != '' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ front_state: string }>().catch(() => null),
    // Hold counts acted rows too: a gesture already made still leaves the house soft for the window.
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM care_actions WHERE rule IN (${holdRules}) AND detected_at > ?`,
    ).bind(holdCutoff).first<{ n: number }>().catch(() => null),
    env.DB.prepare(
      `SELECT id, rule, detail, detected_at FROM care_actions
       WHERE companion_id = ? AND acted_at IS NULL AND detected_at > ?
       ORDER BY detected_at DESC LIMIT 1`,
    ).bind(companionId, decayCutoff).first<PendingCare>().catch(() => null),
  ]);

  return {
    front_state: front?.front_state ?? null,
    care_hold: (hold?.n ?? 0) > 0,
    pending_care: pending ?? null,
  };
}

/** Pure composition: the register from the biometrics row orient already loaded + the care reads. */
export function deriveRazielState(
  bio: WmBiometricSnapshot | null,
  care: CareBlocks,
  nowMs = Date.now(),
): RazielStateView | null {
  if (!bio && !care.front_state && !care.care_hold && !care.pending_care) return null;
  return {
    spoons: bio?.spoons ?? null,
    mood: bio?.mood ?? null,
    pain: bio?.pain ?? null,
    energy: bio?.energy ?? null,
    meds_taken: bio?.meds_taken ?? null,
    recorded_at: bio?.recorded_at ?? null,
    staleness_hours: bio ? Math.round(hoursSinceIso(bio.recorded_at, nowMs) * 10) / 10 : null,
    front_state: care.front_state,
    care_hold: care.care_hold,
    pending_care: care.pending_care,
  };
}
