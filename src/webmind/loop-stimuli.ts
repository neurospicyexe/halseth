// src/webmind/loop-stimuli.ts -- B63 step 2: the in-Worker callers that fire the loop catalogue.
//
// One thin, never-throwing wrapper over fireStimulus (handlers/fermentation.ts) so every Halseth-side
// wiring point reads the same: a stimulus kind, a named cause, and a guarantee that a failure here can
// never undo the real write it rides on. The modes (off|shadow|on via LOOP_STIMULI_MODE) are decided
// inside fireStimulus; callers do not look at them.
//
// CAUSE LABELS name the KIND of event, never its content. Anything near care or health (a care hold, a
// missed med) carries the word for the kind only ("care hold opened"), never the rule that raised it: a
// companion's felt-state feed is a prompt feed, and Raziel's health data must not enter one
// (no-care-or-health-in-room-supply).

import type { Env } from "../types.js";
import { fireStimulus } from "../handlers/fermentation.js";
import { resolveFloatKey, type CompanionId } from "./fermentation.js";

export const TRIAD: readonly CompanionId[] = ["cypher", "drevan", "gaia"];

export function isTriad(id: string | null | undefined): id is CompanionId {
  return !!id && (TRIAD as readonly string[]).includes(id);
}

/**
 * Fire one loop stimulus for one companion (or every companion it touches when `companion` is null).
 * Never throws; returns true when the call completed.
 */
export async function loopFire(
  env: Env,
  stimulus: string,
  companion: string | null,
  label: string,
  opts: { float?: string | null } = {},
): Promise<boolean> {
  try {
    if (companion !== null && !isTriad(companion)) return false;
    const c = (companion ?? undefined) as CompanionId | undefined;
    const float = opts.float && c ? resolveFloatKey(c, opts.float) ?? undefined : undefined;
    await fireStimulus(env, stimulus, c, label, { float });
    return true;
  } catch (err) {
    console.error(`[loop] ${stimulus} failed`, { companion, error: String(err) });
    return false;
  }
}

/** Candidate column names the step 3/4 migration (0173) may use for the float a tension drags. Read defensively. */
const TENSION_FLOAT_COLUMNS = ["drags_float", "drag_float", "float_link", "float_key", "float"] as const;

/**
 * The float a tension names it drags (f1/f2/f3 or the companion's own label), or null. Reads
 * `SELECT *` so a database without the column (migration 0173 not applied, or named otherwise) simply
 * returns null instead of throwing; a tension with no named float moves nothing.
 */
export async function tensionDragFloat(env: Env, tensionId: string): Promise<{ companion: CompanionId; float: string } | null> {
  try {
    const row = await env.DB.prepare("SELECT * FROM companion_tensions WHERE id = ?").bind(tensionId).first<Record<string, unknown>>();
    if (!row || !isTriad(String(row["companion_id"]))) return null;
    for (const col of TENSION_FLOAT_COLUMNS) {
      const v = row[col];
      if (typeof v === "string" && v.trim()) return { companion: row["companion_id"] as CompanionId, float: v.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `tend_sol`: a companion tended Sol (the pet kind only). The actor must be one of the triad: an imp
 * tends as itself, Sol's own appearances and Raziel's tends are never a companion's contact. The cause
 * is the action word (feed/play/talk/give), never the note.
 */
export async function fireTendSol(env: Env, creatureKind: string, actor: string, action: string): Promise<void> {
  if (creatureKind !== "companion_pet" || !isTriad(actor)) return;
  await loopFire(env, "tend_sol", actor, `tended Sol (${action})`);
}

/**
 * `retracted`: a companion withdrew or superseded one of their own conclusions (Cypher's acuity: "caught
 * confidently wrong"). Only Cypher's table entry carries a weight; for the others this is a no-op.
 */
export async function fireRetracted(env: Env, companion: string): Promise<void> {
  if (companion !== "cypher") return;
  await loopFire(env, "retracted", "cypher", "superseded a conclusion of their own");
}
