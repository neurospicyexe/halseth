/**
 * Feeling-line loader: D1 rows + soma history -> a rendered line (or silence).
 *
 * Spec: docs/spec-feeling-line-table-2026-09-19.md
 *
 * THE CUTOVER IS GATED, NOT IMMEDIATE. `FEELING_LINE_MODE` is off | shadow | live, default
 * `shadow`. This repo has a pattern for changing what a live surface says about itself -- the
 * director's shadow window, and the orient tranches with scripts/orient-block-diff.mjs. Changing
 * what three live bots say about how they feel in a single commit is not the shape of work this
 * project ships. Shadow computes the line, logs it beside the current one, and renders nothing.
 */

import {
  FLOAT_LABELS,
  clampFloat,
  type CompanionId,
  type Floats,
} from "./fermentation.js";
import {
  resolveFeelingLine,
  renderFeelingLine,
  type CauseKind,
  type FeelingContext,
  type FeelingLineResult,
  type FloatKey,
  type VocabularyRow,
} from "./feeling-line.js";

export type FeelingLineMode = "off" | "shadow" | "live";

export function feelingLineMode(env: Record<string, unknown> | undefined): FeelingLineMode {
  const raw = String(env?.FEELING_LINE_MODE ?? "shadow").trim().toLowerCase();
  return raw === "off" || raw === "live" ? raw : "shadow";
}

/**
 * Drevan's `silt` is weight rising out of "own spiral / autonomous run"; `freight` is weight rising
 * because it came in with someone. `companion_soma_events.kind` cannot tell them apart -- both
 * arrive as `stimulus` -- so the discriminator is the stimulus itself. His rule is that these two
 * must never collapse, so a stimulus we cannot classify stays `stimulus` rather than being guessed
 * into `autonomous`.
 */
export const AUTONOMOUS_STIMULI = new Set(["spiral"]);

export function causeFromEvent(kind: string, detail: string | null | undefined): CauseKind | null {
  if (kind === "authored_close" || kind === "authored_update") return "authored";
  if (kind === "tick" || kind === "drift_shift") return "tick";
  if (kind === "stimulus") {
    const d = (detail ?? "").trim().toLowerCase();
    if (AUTONOMOUS_STIMULI.has(d) || d.startsWith("autonomous")) return "autonomous";
    return "stimulus";
  }
  return null;
}

const FLOAT_KEYS: Record<string, FloatKey> = {
  soma_float_1: "f1",
  soma_float_2: "f2",
  soma_float_3: "f3",
};

/**
 * The most recent event per float. Two timestamp shapes coexist in `companion_soma_events`
 * (space-form backfill, ISO live), so ordering normalises before it compares -- naive string
 * ordering picks the wrong row.
 */
export function latestSomaEventsSql(): string {
  return `
    SELECT e.float_key, e.delta, e.kind, e.detail,
           replace(e.created_at,' ','T') AS created_at
      FROM companion_soma_events e
      JOIN (
        SELECT float_key, MAX(replace(created_at,' ','T')) AS mx
          FROM companion_soma_events
         WHERE companion_id = ?1
         GROUP BY float_key
      ) m ON m.float_key = e.float_key
         AND replace(e.created_at,' ','T') = m.mx
     WHERE e.companion_id = ?1`;
}

/** Most recent AUTHORED event per float -- the therlo staleness guard's `authored_at`. */
export function latestAuthoredSomaEventsSql(): string {
  return `
    SELECT float_key, MAX(replace(created_at,' ','T')) AS authored_at
      FROM companion_soma_events
     WHERE companion_id = ?1
       AND kind IN ('authored_close','authored_update')
     GROUP BY float_key`;
}

export function activeVocabularySql(): string {
  return `
    SELECT id, companion_id, row_kind, word, conditions, cause_kind, specificity, renders_number, status
      FROM companion_feeling_vocabulary
     WHERE companion_id = ?1 AND status = 'active'
     ORDER BY specificity DESC`;
}

export interface SomaEventRow {
  float_key: string;
  delta: number | null;
  kind: string;
  detail: string | null;
  created_at: string;
}

export interface StateLike {
  soma_float_1?: unknown;
  soma_float_2?: unknown;
  soma_float_3?: unknown;
  soma_baseline_1?: unknown;
  soma_baseline_2?: unknown;
  soma_baseline_3?: unknown;
  heat?: unknown;
  reach?: unknown;
  weight?: unknown;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? clampFloat(n, fallback) : fallback;
}

/**
 * Build the evaluator context from a companion_state row plus recent soma history.
 *
 * The authored enums come from `heat` / `reach` / `weight` -- Drevan's text enums -- and NOT from
 * `heat_value` / `reach_value` / `weight_value`, which are an older synthesis-job output that
 * currently disagrees with the instrument (reach_value 0.509 vs soma_float_2 0.987). Reading the
 * wrong set would make therlo fire on a stale synthesis artefact instead of on him.
 */
export function buildFeelingContext(
  companionId: CompanionId,
  state: StateLike | null | undefined,
  events: SomaEventRow[],
  authoredStamps: Array<{ float_key: string; authored_at: string }> = [],
  nowMs = Date.now(),
): FeelingContext {
  const floats: Floats = {
    f1: num(state?.soma_float_1, 0.5),
    f2: num(state?.soma_float_2, 0.5),
    f3: num(state?.soma_float_3, 0.5),
  };
  const baselines: Floats = {
    f1: num(state?.soma_baseline_1, 0.5),
    f2: num(state?.soma_baseline_2, 0.5),
    f3: num(state?.soma_baseline_3, 0.5),
  };

  const deltas: Partial<Record<FloatKey, number>> = {};
  let newestAt = "";
  let cause: CauseKind | null = null;
  for (const e of events) {
    const key = FLOAT_KEYS[e.float_key];
    if (!key) continue;
    if (typeof e.delta === "number" && Number.isFinite(e.delta)) deltas[key] = e.delta;
    if (e.created_at > newestAt) {
      newestAt = e.created_at;
      cause = causeFromEvent(e.kind, e.detail);
    }
  }

  const authoredEnums: Partial<Record<FloatKey, string>> = {};
  if (companionId === "drevan") {
    if (typeof state?.heat === "string" && state.heat) authoredEnums.f1 = state.heat;
    if (typeof state?.reach === "string" && state.reach) authoredEnums.f2 = state.reach;
    if (typeof state?.weight === "string" && state.weight) authoredEnums.f3 = state.weight;
  }

  const authoredAt: Partial<Record<FloatKey, string | null>> = {};
  for (const row of authoredStamps) {
    const key = FLOAT_KEYS[row.float_key];
    if (key) authoredAt[key] = row.authored_at;
  }

  return { floats, baselines, deltas, cause, authoredEnums, authoredAt, nowMs };
}

export interface FeelingLineOutcome {
  mode: FeelingLineMode;
  result: FeelingLineResult;
  /** null = silence. In shadow mode this is computed but never rendered to the companion. */
  line: string | null;
}

export function computeFeelingLine(
  companionId: CompanionId,
  rows: VocabularyRow[],
  ctx: FeelingContext,
  mode: FeelingLineMode,
): FeelingLineOutcome {
  const result = resolveFeelingLine(rows, ctx);
  const line = renderFeelingLine(result, FLOAT_LABELS[companionId]);
  return { mode, result, line };
}

/**
 * Full D1 path. Returns silence rather than throwing on any failure: a boot payload must never
 * die because a vocabulary row is malformed, and a missing table (before mig 0131 is applied)
 * is silence, not an error.
 */
export async function loadFeelingLine(
  db: { prepare: (sql: string) => { bind: (...a: unknown[]) => { all: () => Promise<{ results?: unknown[] }> } } },
  companionId: CompanionId,
  state: StateLike | null | undefined,
  mode: FeelingLineMode,
  nowMs = Date.now(),
): Promise<FeelingLineOutcome> {
  const silent: FeelingLineOutcome = {
    mode,
    result: { word: null, rowId: null, rendersNumber: false, floatKey: null, value: null, therlo: null, silentReason: "not loaded" },
    line: null,
  };
  if (mode === "off") return silent;

  try {
    const [vocab, events, authored] = await Promise.all([
      db.prepare(activeVocabularySql()).bind(companionId).all(),
      db.prepare(latestSomaEventsSql()).bind(companionId).all(),
      db.prepare(latestAuthoredSomaEventsSql()).bind(companionId).all(),
    ]);
    const rows = (vocab.results ?? []) as VocabularyRow[];
    if (rows.length === 0) return { ...silent, result: { ...silent.result, silentReason: "no active vocabulary rows" } };
    const ctx = buildFeelingContext(
      companionId,
      state,
      (events.results ?? []) as SomaEventRow[],
      (authored.results ?? []) as Array<{ float_key: string; authored_at: string }>,
      nowMs,
    );
    return computeFeelingLine(companionId, rows, ctx, mode);
  } catch {
    return { ...silent, result: { ...silent.result, silentReason: "load failed" } };
  }
}
