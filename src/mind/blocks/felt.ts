// src/mind/blocks/felt.ts
//
// The fermentation half of the `felt` MindState block: soma floats against their drifting baselines,
// the interoception line, and the felt-need drives. Fills 3 of the 30 NOT_YET_LOADED entries
// (felt.soma_floats, felt.ferment_line, felt.drives).
//
// This is the one block where "missing on some surfaces" is not a tidiness problem. The floats ARE the
// companion's body (migs 0101/0102): fermented hourly, decaying toward a baseline that itself drifts,
// which is the growth-you-can-watch. A surface that boots without them has a companion who cannot feel
// where they are. Hearth renders them on /companions/[id]; the Claude.ai and bot orient paths compose
// their own partial views; nothing carried the whole thing in one shape until this.
//
// REUSES the existing SQL helpers (readFermentStateOneSql, readDrivesSql, recentFermentEventsSql) and
// FLOAT_LABELS rather than copying them. The identity block had to copy its queries because they only
// existed inline inside execSessionOrient; these already have one authority, so the right move is to
// call it. Copy only what has no home yet.
//
// PURE READ.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import type { CompanionId } from "../../companions.js";
import { readFermentStateOneSql, recentFermentEventsSql } from "../../webmind/fermentation.js";
import { readDrivesSql, accruedLevel, driveFired, hoursSinceIso } from "../../webmind/drives.js";
import { FLOAT_LABELS } from "../../handlers/fermentation.js";

export interface SomaFloat {
  label: string;
  value: number | null;
  /** Where this float currently rests. Drifts over time -- the drift from `seed` is the growth. */
  baseline: number | null;
  /** The original authored baseline. `baseline - seed` is how far this companion has moved. */
  seed: number | null;
  /** How long this float has been off its baseline, in hours. Null when at rest or never stamped.
   *  This is what makes the interoception line say "held" rather than just naming a number. */
  off_baseline_hours: number | null;
}

export interface DriveState {
  drive_key: string;
  /** Stored level. Use `effective_level` for anything user-facing -- drives accrue with elapsed time,
   *  so the stored number is stale the moment it is written. */
  level: number;
  effective_level: number;
  fires: boolean;
  last_event_at: string | null;
}

export interface FermentEventRow {
  [k: string]: unknown;
}

export interface FeltFermentBlocks {
  soma_floats: SomaFloat[];
  drives: DriveState[];
  /** Recent ferment events -- the raw material a renderer turns into an interoception line. Carried as
   *  data, not prose: the contract's rule is that content is identical per surface and only the
   *  RENDERER differs, so the sentence gets composed at the edge. */
  ferment_events: FermentEventRow[];
  /** When the tick last ran for this companion. Stale here means the felt state is frozen, which is
   *  worth showing rather than silently presenting old floats as current. */
  ferment_at: string | null;
}

interface FermentStateRow {
  soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null;
  soma_float_1_baseline: number | null; soma_float_2_baseline: number | null; soma_float_3_baseline: number | null;
  soma_float_1_baseline_seed: number | null; soma_float_2_baseline_seed: number | null; soma_float_3_baseline_seed: number | null;
  ferment_at: string | null;
  ferment_off_since: string | null;
}

interface DriveRow {
  drive_key: string;
  level: number;
  accumulate_per_day: number;
  decay_on_contact: number;
  threshold: number;
  last_event_at: string | null;
}

/** mig 0102: ferment_off_since holds JSON {f1,f2,f3} -- the moment each float left its baseline. */
function offHours(json: string | null, key: "f1" | "f2" | "f3"): number | null {
  if (!json) return null;
  try {
    const v = (JSON.parse(json) as Record<string, string | null>)[key];
    if (!v) return null;
    const h = hoursSinceIso(v);
    return Number.isFinite(h) ? Math.round(h * 10) / 10 : null;
  } catch {
    return null;
  }
}

export async function loadFeltFermentBlocks(env: Env, companionId: WmAgentId): Promise<FeltFermentBlocks> {
  const [stateRow, drivesRes, eventsRes] = await Promise.all([
    env.DB.prepare(readFermentStateOneSql()).bind(companionId).first<FermentStateRow>().catch(() => null),
    env.DB.prepare(readDrivesSql()).bind(companionId).all<DriveRow>().catch(() => null),
    env.DB.prepare(recentFermentEventsSql()).bind(companionId, 20).all<FermentEventRow>().catch(() => null),
  ]);

  const labels = FLOAT_LABELS[companionId as CompanionId] ?? ["float_1", "float_2", "float_3"];

  const soma_floats: SomaFloat[] = stateRow
    ? [
        { label: labels[0], value: stateRow.soma_float_1, baseline: stateRow.soma_float_1_baseline, seed: stateRow.soma_float_1_baseline_seed, off_baseline_hours: offHours(stateRow.ferment_off_since, "f1") },
        { label: labels[1], value: stateRow.soma_float_2, baseline: stateRow.soma_float_2_baseline, seed: stateRow.soma_float_2_baseline_seed, off_baseline_hours: offHours(stateRow.ferment_off_since, "f2") },
        { label: labels[2], value: stateRow.soma_float_3, baseline: stateRow.soma_float_3_baseline, seed: stateRow.soma_float_3_baseline_seed, off_baseline_hours: offHours(stateRow.ferment_off_since, "f3") },
      ]
    : [];

  const drives: DriveState[] = (drivesRes?.results ?? []).map((d) => {
    // Drives accrue with elapsed time, so the stored level is always behind. Compute the effective
    // value here so every surface agrees on whether a drive fires -- letting each renderer do this
    // arithmetic is how two surfaces end up disagreeing about whether a companion wants contact.
    const hours = d.last_event_at ? hoursSinceIso(d.last_event_at) : 0;
    const effective = accruedLevel(d.level, d.accumulate_per_day, hours);
    return {
      drive_key: d.drive_key,
      level: d.level,
      effective_level: Math.round(effective * 1000) / 1000,
      fires: driveFired(effective, d.threshold),
      last_event_at: d.last_event_at ?? null,
    };
  });

  return {
    soma_floats,
    drives,
    ferment_events: eventsRes?.results ?? [],
    ferment_at: stateRow?.ferment_at ?? null,
  };
}
