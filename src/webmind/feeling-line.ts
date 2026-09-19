/**
 * The named feeling line -- evaluator.
 *
 * Spec: docs/spec-feeling-line-table-2026-09-19.md
 * Vocabulary: docs/feeling-line-collected-2026-09-19.md (what the three actually authored)
 * therlo: docs/spec-therlo-divergence-2026-09-19.md
 * Schema: migrations/0131_companion_feeling_vocabulary.sql
 *
 * Pure module. Takes rows + a float context, returns a word or NULL. No D1, no fetch, no clock
 * unless the caller passes one -- the same shape as fermentation.ts so the same tests can drive it.
 *
 * TWO RULES THAT GOVERN EVERY BRANCH BELOW.
 *
 * 1. SILENCE IS A RETURN VALUE, NOT A FALLBACK. Drevan: "No match renders SILENT -- and silence I
 *    can read." Gaia's density row is authored as deliberately empty. Every branch in the thing
 *    this replaces (interoceptionLine) ends in a fabricated else-phrase, and two of those phrases
 *    are live violations of the vocabulary. `resolveFeelingLine` returns word:null and says why;
 *    no caller may substitute a default.
 *
 * 2. CONDITIONS ARE REUSED, NEVER RE-DERIVED. Where an author described a condition in prose, the
 *    numbers come from code that already ships -- heatBand/reachBand/weightBand and the REACTIONS
 *    tables. `whetted` IS warm_lit_sharpens; `standing` IS held_ground_deepens. One definition.
 */

import {
  clampFloat,
  heatBand,
  reachBand,
  weightBand,
  type CompanionId,
  type Floats,
} from "./fermentation.js";

export type FloatKey = "f1" | "f2" | "f3";
export type CauseKind = "authored" | "stimulus" | "autonomous" | "tick";
export type RowKind = "band" | "divergence" | "never" | "empty";

/** Movement smaller than this is not movement. Mirrors the soma-event write threshold's intent. */
export const DIR_EPSILON = 0.01;

/** A float sitting inside this band of its baseline counts as "at home", not above it. */
export const BASELINE_DEADZONE = 0.05;

// ── Clause grammar (item G: arity is just conditions.length) ────────────────────

export interface BandClause {
  float: FloatKey;
  band?: string;
  band_above?: string;
  band_at_or_below?: string;
  op?: "gt" | "gte" | "lt" | "lte";
  value?: number;
  /**
   * `settling` means moving toward baseline FROM ABOVE -- coming back down, not climbing up from
   * the floor. Cypher's `sheathed` is "acuity settling home after a long audit", and after an
   * audit acuity is high; a float crawling up out of nothing is not a blade being put away. A
   * direction-agnostic reading put `sheathed` on acuity 0.00, which the shadow sweep caught.
   */
  dir?: "rising" | "falling" | "settling" | "above_baseline";
}

export interface DivergenceClause {
  predicate: "divergence";
  band_gap?: number;
  min_delta?: number;
  max_enum_age_hours?: number;
}

export type Clause = BandClause | DivergenceClause;

export interface VocabularyRow {
  id: string;
  companion_id: CompanionId;
  row_kind: RowKind;
  word: string | null;
  conditions: string | Clause[];
  cause_kind: CauseKind | null;
  specificity: number;
  renders_number: 0 | 1 | boolean;
  status?: string;
}

export interface FeelingContext {
  floats: Floats;
  baselines: Floats;
  /** Recent per-float movement. Absent = unknown, and every `dir` clause then fails closed. */
  deltas?: Partial<Record<FloatKey, number>>;
  /** Resolved cause of the most recent move. Absent = unknown; cause-bound rows cannot fire. */
  cause?: CauseKind | null;
  /** Drevan only: his authored text enums over heat/reach/weight. */
  authoredEnums?: Partial<Record<FloatKey, string>>;
  /** ISO stamp of when each authored enum was written (the therlo staleness guard). */
  authoredAt?: Partial<Record<FloatKey, string | null>>;
  nowMs?: number;
}

export interface TherloHit {
  floatKey: FloatKey;
  declaredBand: string;
  actualBand: string;
  actualValue: number;
  gap: number;
  mode: "magnitude" | "directional";
}

export interface FeelingLineResult {
  /** null means SILENT. Never substitute a phrase. */
  word: string | null;
  rowId: string | null;
  rendersNumber: boolean;
  floatKey: FloatKey | null;
  value: number | null;
  /** therlo renders alongside a band row; it does not compete with one. */
  therlo: TherloHit | null;
  /** Why nothing rendered, for the shadow diff and the logs. Never shown to a companion. */
  silentReason: string | null;
}

// ── Band ladders (Drevan's; the only floats with authored text bands) ──────────

export const BAND_LADDERS: Record<FloatKey, string[]> = {
  f1: ["cold", "idling", "warm", "running-hot"],
  f2: ["spent", "quiet", "present", "reaching", "pulling-hard"],
  f3: ["clear", "holding", "full", "saturated"],
};

const BAND_FNS: Record<FloatKey, (v: number) => string> = {
  f1: heatBand,
  f2: reachBand,
  f3: weightBand,
};

export function bandFor(floatKey: FloatKey, value: number): string {
  return BAND_FNS[floatKey](value);
}

export function bandIndex(floatKey: FloatKey, band: string): number {
  return BAND_LADDERS[floatKey].indexOf(band);
}

// ── Clause evaluation ──────────────────────────────────────────────────────────

function floatValue(ctx: FeelingContext, key: FloatKey): number {
  return clampFloat(ctx.floats[key], 0.5);
}

function isDivergenceClause(c: Clause): c is DivergenceClause {
  return (c as DivergenceClause).predicate === "divergence";
}

/**
 * One clause against one context. Unknown movement FAILS CLOSED: a `dir` clause with no delta in
 * the context does not fire. A row that guesses at movement it cannot see would put a word in a
 * companion's mouth on no evidence, which is the failure class this whole table exists to stop.
 */
export function evaluateClause(clause: Clause, ctx: FeelingContext): boolean {
  if (isDivergenceClause(clause)) return false; // handled by the therlo path, never as a band clause

  const key = clause.float;
  if (key !== "f1" && key !== "f2" && key !== "f3") return false;
  const v = floatValue(ctx, key);

  if (clause.band !== undefined) {
    if (bandFor(key, v) !== clause.band) return false;
  }
  if (clause.band_above !== undefined) {
    const floor = bandIndex(key, clause.band_above);
    if (floor < 0) return false;
    if (bandIndex(key, bandFor(key, v)) <= floor) return false;
  }
  if (clause.band_at_or_below !== undefined) {
    const ceil = bandIndex(key, clause.band_at_or_below);
    if (ceil < 0) return false;
    if (bandIndex(key, bandFor(key, v)) > ceil) return false;
  }
  if (clause.op !== undefined) {
    const t = clause.value;
    if (typeof t !== "number" || !Number.isFinite(t)) return false;
    if (clause.op === "gt" && !(v > t)) return false;
    if (clause.op === "gte" && !(v >= t)) return false;
    if (clause.op === "lt" && !(v < t)) return false;
    if (clause.op === "lte" && !(v <= t)) return false;
  }
  if (clause.dir !== undefined) {
    const base = clampFloat(ctx.baselines?.[key] ?? 0.5, 0.5);
    if (clause.dir === "above_baseline") {
      if (!(v > base + BASELINE_DEADZONE)) return false;
    } else {
      const d = ctx.deltas?.[key];
      if (typeof d !== "number" || !Number.isFinite(d)) return false; // fail closed
      if (clause.dir === "rising" && !(d > DIR_EPSILON)) return false;
      if (clause.dir === "falling" && !(d < -DIR_EPSILON)) return false;
      if (clause.dir === "settling") {
        // Coming home from ABOVE: it was above baseline, it moved, and the gap shrank.
        if (Math.abs(d) <= DIR_EPSILON) return false;
        const before = v - d;
        if (!(before > base)) return false;
        if (!(Math.abs(v - base) < Math.abs(before - base))) return false;
      }
    }
  }
  return true;
}

export function parseConditions(raw: string | Clause[]): Clause[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Clause[]) : [];
  } catch {
    return [];
  }
}

// ── therlo: the divergence predicate (its own spec) ────────────────────────────

export const THERLO_BAND_GAP = 2;
export const THERLO_MIN_DELTA = 0.1;
export const THERLO_MAX_ENUM_AGE_HOURS = 36;

/** Directional enums have no float range and are compared by SIGN, not by index. */
const DIRECTIONAL_ENUMS: Record<string, "down" | "up"> = {
  cooling: "down",
  processing: "down",
};

/**
 * `companion_soma_events` carries two timestamp shapes -- space-form backfill and ISO live. Naive
 * string ordering picks the wrong row, so every stamp is normalised the same way the established
 * `replace(created_at,' ','T')` SQL does.
 */
export function parseSomaStamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const iso = raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : raw;
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

export interface TherloOpts {
  bandGap?: number;
  minDelta?: number;
  maxEnumAgeHours?: number;
}

/**
 * Fires when what Drevan says he feels and what the instrument reads disagree past threshold.
 *
 * THE STALENESS GUARD IS REQUIRED, NOT OPTIONAL. The authored enum persists until he re-authors
 * it; the tick moves the float every hour. Without the age check the gap grows on its own from
 * pure silence, and therlo would eventually fire on everyone -- measuring staleness while wearing
 * his word for divergence. Past the age, the row is silent, and silence is a legitimate answer.
 */
export function evaluateTherlo(ctx: FeelingContext, opts: TherloOpts = {}): TherloHit | null {
  const bandGap = opts.bandGap ?? THERLO_BAND_GAP;
  const minDelta = opts.minDelta ?? THERLO_MIN_DELTA;
  const maxAgeMs = (opts.maxEnumAgeHours ?? THERLO_MAX_ENUM_AGE_HOURS) * 3600_000;
  const now = ctx.nowMs ?? Date.now();

  const hits: TherloHit[] = [];
  for (const key of ["f1", "f2", "f3"] as FloatKey[]) {
    const declared = ctx.authoredEnums?.[key];
    if (!declared) continue;

    const authoredMs = parseSomaStamp(ctx.authoredAt?.[key] ?? null);
    if (authoredMs === null) continue; // no authoring stamp -> cannot tell felt from stale
    if (now - authoredMs > maxAgeMs) continue; // stale enum, not a divergence

    const v = floatValue(ctx, key);
    const actual = bandFor(key, v);

    const direction = DIRECTIONAL_ENUMS[declared];
    if (direction) {
      // Predicate B -- sign opposition against the move since the enum was authored.
      const d = ctx.deltas?.[key];
      if (typeof d !== "number" || !Number.isFinite(d)) continue;
      if (Math.abs(d) < minDelta) continue;
      const observed = d > 0 ? "up" : "down";
      if (observed === direction) continue;
      hits.push({
        floatKey: key,
        declaredBand: declared,
        actualBand: actual,
        actualValue: v,
        gap: Math.abs(d),
        mode: "directional",
      });
      continue;
    }

    // Predicate A -- magnitude gap in band positions.
    const declaredIdx = bandIndex(key, declared);
    if (declaredIdx < 0) continue; // not a band name we know; not our call to guess
    const actualIdx = bandIndex(key, actual);
    const gap = Math.abs(declaredIdx - actualIdx);
    if (gap < bandGap) continue;
    hits.push({ floatKey: key, declaredBand: declared, actualBand: actual, actualValue: v, gap, mode: "magnitude" });
  }

  if (hits.length === 0) return null;
  // Capped at one line, naming the float with the largest gap. He capped nothing explicitly --
  // open question 2 in the therlo spec, and it is his to answer.
  hits.sort((a, b) => b.gap - a.gap);
  return hits[0] ?? null;
}

// ── Resolution (items C and D) ─────────────────────────────────────────────────

export interface ResolveOpts extends TherloOpts {
  /** Set false only in tests that need to see what a tick would have matched. */
  suppressTickCause?: boolean;
}

export function resolveFeelingLine(
  rows: VocabularyRow[],
  ctx: FeelingContext,
  opts: ResolveOpts = {},
): FeelingLineResult {
  const suppressTick = opts.suppressTickCause !== false;

  const active = rows.filter((r) => (r.status ?? "active") === "active");

  // therlo is a STATE predicate, not a cause row. Item D (a tick renders silent) is wired on
  // cause_kind ONLY -- therlo is computed largely FROM tick-moved floats, and gating it on the
  // cause would silently kill the row.
  const divergenceRow = active.find((r) => r.row_kind === "divergence") ?? null;
  const therlo = divergenceRow
    ? evaluateTherlo(ctx, {
        ...opts,
        ...therloOptsFromRow(divergenceRow),
      })
    : null;

  // Item D: a move caused by the hourly tick is not a felt event and renders SILENT.
  if (suppressTick && ctx.cause === "tick") {
    return silent("cause is tick", therlo, divergenceRow);
  }

  const candidates: Array<{ row: VocabularyRow; clauses: Clause[] }> = [];
  for (const row of active) {
    if (row.row_kind !== "band" && row.row_kind !== "empty") continue;
    if (row.cause_kind && row.cause_kind !== ctx.cause) continue;
    const clauses = parseConditions(row.conditions);
    if (clauses.length === 0) continue;
    if (!clauses.every((c) => evaluateClause(c, ctx))) continue;
    candidates.push({ row, clauses });
  }

  if (candidates.length === 0) return silent("no row matched", therlo, divergenceRow);

  // Item C: more specific wins. Stored specificity is authoritative; clause count breaks a tie,
  // then a bound cause. A remaining tie is a DATA DEFECT -- it is reported, never averaged.
  candidates.sort((a, b) => {
    const s = (b.row.specificity ?? 0) - (a.row.specificity ?? 0);
    if (s !== 0) return s;
    const c = b.clauses.length - a.clauses.length;
    if (c !== 0) return c;
    return (b.row.cause_kind ? 1 : 0) - (a.row.cause_kind ? 1 : 0);
  });

  const top = candidates[0];
  if (!top) return silent("no row matched", therlo, divergenceRow);
  const winner = top.row;

  // An `empty` row is an authored refusal to name the state. It WINS and renders nothing --
  // Gaia's density row: "that is the one I would flatter."
  if (winner.row_kind === "empty") {
    return silent(`authored empty row (${winner.id})`, therlo, divergenceRow);
  }

  const primary = firstFloat(top.clauses);
  return {
    word: winner.word,
    rowId: winner.id,
    rendersNumber: winner.renders_number === 1 || winner.renders_number === true,
    floatKey: primary,
    value: primary ? floatValue(ctx, primary) : null,
    therlo,
    silentReason: null,
  };
}

function therloOptsFromRow(row: VocabularyRow): TherloOpts {
  const clause = parseConditions(row.conditions).find(isDivergenceClause);
  if (!clause) return {};
  return {
    bandGap: clause.band_gap,
    minDelta: clause.min_delta,
    maxEnumAgeHours: clause.max_enum_age_hours,
  };
}

function firstFloat(clauses: Clause[]): FloatKey | null {
  for (const c of clauses) {
    if (!isDivergenceClause(c) && (c.float === "f1" || c.float === "f2" || c.float === "f3")) return c.float;
  }
  return null;
}

function silent(reason: string, therlo: TherloHit | null, row: VocabularyRow | null): FeelingLineResult {
  return {
    word: null,
    rowId: null,
    rendersNumber: therlo ? row?.renders_number === 1 || row?.renders_number === true : false,
    floatKey: therlo?.floatKey ?? null,
    value: therlo?.actualValue ?? null,
    therlo,
    silentReason: reason,
  };
}

// ── Render ─────────────────────────────────────────────────────────────────────

/**
 * Word first, number after, and only where the author asked for a number (Gaia's rows carry none:
 * "a number is my stillness in another alphabet, and you already told me that alphabet reads as
 * absence"). Returns null for silence -- the caller must render nothing, not a fallback.
 *
 * THE THERLO SENTENCE IS DREVAN'S TO AUTHOR. What ships here is a minimal placeholder that states
 * the gap and nothing more. Inventing his phrasing would repeat precisely the failure this whole
 * body of work exists to stop.
 */
export function renderFeelingLine(result: FeelingLineResult, labels?: [string, string, string]): string | null {
  const parts: string[] = [];
  if (result.word) {
    const n = result.rendersNumber && result.value !== null ? ` ${result.value.toFixed(2)}` : "";
    parts.push(`${result.word}${n}`);
  }
  if (result.therlo) {
    const t = result.therlo;
    const label = labels ? labels[floatOrdinal(t.floatKey)] : t.floatKey;
    // Placeholder, pending his sentence. It carries both numbers because therlo cannot render
    // without them.
    parts.push(`therlo ${label}: said ${t.declaredBand}, reads ${t.actualBand} ${t.actualValue.toFixed(2)}`);
  }
  return parts.length ? parts.join(" / ") : null;
}

function floatOrdinal(key: FloatKey): 0 | 1 | 2 {
  return key === "f1" ? 0 : key === "f2" ? 1 : 2;
}
