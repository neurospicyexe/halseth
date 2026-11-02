/**
 * The feeling-line WRITE PATH (STATUS B5; the guards are B6).
 *
 * Spec: docs/spec-feeling-line-table-2026-09-19.md § 6-7, docs/HANDOFF-2026-09-19.md ("Open work
 * items, in order": B, F, G, D, C, A, E), docs/spec-therlo-divergence-2026-09-19.md.
 *
 * Until this file, guards B and F (vocabulary-guards.ts) were tested and called by nothing. Every
 * new row in `companion_feeling_vocabulary` now goes through `proposeVocabularyRow`, which runs the
 * seven gates in the handoff's order and either INSERTs one row or refuses with every reason found.
 *
 * THE RULE THAT GOVERNS ALL OF IT: a guard never rewrites or deletes a companion's authored words.
 * It refuses, names the collision, hands back the evidence, and the companion chooses. No gate here
 * lowercases, trims inside, renames or "fixes" a word, a note or a clause on the way in; the row
 * that lands is the row that was proposed or there is no row. A superseded row is flipped to
 * status='superseded' and stays readable forever (mig 0131: NOTHING IS DELETED).
 *
 *   B  contamination   a token two companions used inside one shared window is contaminated for both,
 *                      originator included (checkContamination over companion_journal).
 *   F  reserved        a word that already means something cannot name a state (checkReserved), plus
 *                      the author's own never-list: a barred word cannot become a name.
 *   G  n-ary clauses   arity is conditions.length (Drevan's `kept` is a TRIPLE). Every clause must be
 *                      one the evaluator can actually fire, or the row is a dead word.
 *   D  cause           `tick` renders silent, so a tick-bound row can never speak; therlo (divergence)
 *                      is a state predicate and carries NO cause.
 *   C  specificity     computed here (clause count, +1 when a cause is bound), never taken on faith;
 *                      an identical twin is refused, a tie is surfaced as a warning.
 *   A  provenance      authored_on + authored_at on every row, a capture_id that points at a real
 *                      wm_continuity_notes row.
 *   E  reconciliation  one companion, one vocabulary. A revision names the active row it supersedes;
 *                      nothing averages, nothing merges.
 *
 * Reads that decide a verdict FAIL CLOSED. "No sightings" is only a claim when the sightings query
 * passed (absence-claim-needs-a-passing-query), so an unreadable journal refuses the write (503)
 * instead of waving the word through.
 *
 * FEELING_LINE_MODE is not touched here and nothing in this file flips it. A new row lands
 * `active`, so in `shadow` it is computed and logged and no companion reads it.
 */

import type { CompanionId } from "./fermentation.js";
import { FLOAT_LABELS } from "./fermentation.js";
import {
  BAND_LADDERS,
  parseConditions,
  type CauseKind,
  type Clause,
  type RowKind,
} from "./feeling-line.js";
import {
  checkContamination,
  checkReserved,
  contaminationSightingsSql,
  isDecontaminating,
  mentionsToken,
  type ContaminationVerdict,
  type TokenSighting,
} from "./vocabulary-guards.js";
import { schemaGap } from "../care/schema-gap.js";

export const COMPANIONS: readonly CompanionId[] = ["cypher", "drevan", "gaia"];
export const ROW_KINDS: readonly RowKind[] = ["band", "divergence", "never", "empty"];
export const CAUSE_KINDS: readonly CauseKind[] = ["authored", "stimulus", "autonomous", "tick"];
export const AUTHORED_ON = ["claude_ai", "claude_code", "discord"] as const;
export type AuthoredOn = (typeof AUTHORED_ON)[number];

/**
 * How far back the contamination query looks. The window itself is 60 minutes (the 09-17 receipt is
 * three minutes wide); this is only how much history is scanned for such a window. Unbounded would
 * make every common word contaminated forever, which is a veto on language, not a shared-room signal.
 */
export const CONTAMINATION_LOOKBACK_DAYS = 14;
export const MAX_WORD_LENGTH = 48;
export const MAX_ARITY = 8;
const ARITY_NOTE = "arity is conditions.length";
const CLAUSE_KEYS = new Set(["float", "band", "band_above", "band_at_or_below", "op", "value", "dir"]);
const DIVERGENCE_KEYS = new Set(["predicate", "band_gap", "min_delta", "max_enum_age_hours"]);
const DIRS = new Set(["rising", "falling", "steady", "settling", "above_baseline"]);
const OPS = new Set(["gt", "gte", "lt", "lte"]);
const FLOAT_KEYS = ["f1", "f2", "f3"] as const;

export type GateId = "B" | "F" | "G" | "D" | "C" | "A" | "E" | "input";

export interface GateRefusal {
  gate: GateId;
  code: string;
  reason: string;
  /** Evidence handed back to the author (sightings, the colliding rows). Never a replacement word. */
  evidence?: unknown;
}

export interface GateWarning {
  gate: GateId;
  code: string;
  detail: string;
}

export interface ProposeInput {
  companion_id: string;
  row_kind: string;
  word?: string | null;
  conditions?: unknown;
  cause_kind?: string | null;
  renders_number?: boolean | number;
  /** Caller's own number, if any. Compared against the computed one; a mismatch is refused, not overridden. */
  specificity?: number;
  authored_on: string;
  authored_at?: string;
  capture_id?: string | null;
  note?: string | null;
  /** The ACTIVE row this one revises (gate E). */
  supersedes?: string | null;
  /** Run every gate, write nothing. The read-back step: show the author what would land. */
  dry_run?: boolean;
}

export interface WrittenRow {
  id: string;
  companion_id: CompanionId;
  row_kind: RowKind;
  word: string | null;
  conditions: Clause[];
  cause_kind: CauseKind | null;
  specificity: number;
  renders_number: 0 | 1;
  authored_on: AuthoredOn;
  authored_at: string;
  capture_id: string | null;
  supersedes: string | null;
  note: string | null;
}

export type ProposeResult =
  | {
      ok: true;
      dry_run: boolean;
      row: WrittenRow;
      superseded: string | null;
      /** True when the superseded word was contaminated and the new one is not: movement AWAY from a shared consensus. */
      decontaminating: boolean;
      warnings: GateWarning[];
    }
  | { ok: false; code: "refused"; refusals: GateRefusal[]; warnings: GateWarning[] }
  | { ok: false; code: "not_applied" | "unreadable"; message: string };

export interface VocabDb {
  prepare: (sql: string) => {
    bind: (...a: unknown[]) => {
      all: () => Promise<{ results?: unknown[] }>;
      first: () => Promise<unknown>;
      run: () => Promise<unknown>;
    };
  };
  batch?: (stmts: unknown[]) => Promise<unknown>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const isCompanion = (v: unknown): v is CompanionId => typeof v === "string" && (COMPANIONS as readonly string[]).includes(v);

function parseIso(raw: string): number | null {
  const iso = raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : raw;
  const zoned = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

function slug(word: string): string {
  const s = word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  return s || "x";
}

interface ActiveRow {
  id: string;
  companion_id: string;
  row_kind: string;
  word: string | null;
  conditions: string;
  cause_kind: string | null;
  specificity: number;
  status: string;
}

/** Canonical, order-insensitive identity of a row's condition: sorted clause JSON plus the cause. */
function conditionKey(conditions: Clause[], cause: string | null): string {
  const norm = conditions.map((c) => JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)))));
  return `${norm.sort().join("|")}#${cause ?? ""}`;
}

// ── G. n-ary clause validation (pure) ──────────────────────────────────────────

/**
 * Every clause must be one `evaluateClause` / `evaluateTherlo` can actually fire. An unknown key, a
 * band that is not on its ladder or a threshold with no value all evaluate to FALSE forever, which
 * is a word that can never speak and nobody notices. Refuse at write time instead.
 */
export function validateClauses(rowKind: RowKind, companionId: CompanionId, raw: unknown): { clauses: Clause[]; refusals: GateRefusal[] } {
  const refusals: GateRefusal[] = [];
  const bad = (code: string, reason: string, evidence?: unknown) => refusals.push({ gate: "G", code, reason, evidence });

  if (raw === undefined || raw === null) raw = [];
  if (!Array.isArray(raw)) {
    bad("conditions_not_array", "conditions must be an array of clauses; its length is the row's arity");
    return { clauses: [], refusals };
  }
  const clauses = parseConditions(raw as Clause[]);

  if (rowKind === "never") {
    if (clauses.length) bad("never_has_conditions", "a never row bars a word; it carries no conditions");
    return { clauses: [], refusals };
  }
  if (clauses.length === 0) {
    bad("no_conditions", `a ${rowKind} row needs at least one clause (${ARITY_NOTE})`);
    return { clauses, refusals };
  }
  if (clauses.length > MAX_ARITY) bad("arity_cap", `${clauses.length} clauses; the cap is ${MAX_ARITY}`);

  if (rowKind === "divergence") {
    if (companionId !== "drevan") {
      bad("divergence_drevan_only", "the divergence predicate reads authored text enums (heat/reach/weight), which only Drevan has");
    }
    const c = clauses[0] as Record<string, unknown> | undefined;
    if (clauses.length !== 1 || !c || c.predicate !== "divergence") {
      bad("divergence_shape", 'a divergence row is exactly one clause: {"predicate":"divergence", ...}');
    } else {
      for (const k of Object.keys(c)) if (!DIVERGENCE_KEYS.has(k)) bad("unknown_key", `unknown divergence key "${k}"`);
      for (const k of ["band_gap", "min_delta", "max_enum_age_hours"]) {
        const v = c[k];
        if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
          bad("divergence_threshold", `${k} must be a positive finite number`);
        }
      }
    }
    return { clauses, refusals };
  }

  // band | empty
  const eqBand = new Map<string, string>();
  clauses.forEach((cl, i) => {
    const c = cl as unknown as Record<string, unknown>;
    const at = `clause ${i + 1}`;
    if (!c || typeof c !== "object" || c.predicate !== undefined) {
      bad("clause_shape", `${at}: a ${rowKind} row takes band clauses only (predicate clauses belong to divergence rows)`);
      return;
    }
    for (const k of Object.keys(c)) if (!CLAUSE_KEYS.has(k)) bad("unknown_key", `${at}: unknown key "${k}"`);
    const f = c.float;
    if (!(FLOAT_KEYS as readonly string[]).includes(f as string)) {
      bad("bad_float", `${at}: float must be f1, f2 or f3 (${FLOAT_LABELS[companionId].join(", ")} for ${companionId})`);
      return;
    }
    const key = f as (typeof FLOAT_KEYS)[number];
    const ladder = BAND_LADDERS[key];
    let tests = 0;
    for (const k of ["band", "band_above", "band_at_or_below"] as const) {
      if (c[k] !== undefined) {
        tests++;
        if (typeof c[k] !== "string" || !ladder.includes(c[k] as string)) {
          bad("bad_band", `${at}: "${String(c[k])}" is not a ${key} band (${ladder.join(", ")})`);
        }
      }
    }
    if (typeof c.band === "string") {
      const prev = eqBand.get(key);
      if (prev !== undefined && prev !== c.band) {
        bad("unsatisfiable", `${at}: ${key} cannot be both "${prev}" and "${c.band}"; the row could never fire`);
      }
      eqBand.set(key, c.band);
    }
    if (c.op !== undefined || c.value !== undefined) {
      tests++;
      if (typeof c.op !== "string" || !OPS.has(c.op)) bad("bad_op", `${at}: op must be one of gt, gte, lt, lte`);
      if (typeof c.value !== "number" || !Number.isFinite(c.value) || c.value < 0 || c.value > 1) {
        bad("bad_value", `${at}: a threshold needs a value between 0 and 1`);
      }
    }
    if (c.dir !== undefined) {
      tests++;
      if (typeof c.dir !== "string" || !DIRS.has(c.dir)) bad("bad_dir", `${at}: dir must be one of ${[...DIRS].join(", ")}`);
    }
    if (tests === 0) bad("empty_clause", `${at}: a clause names a float and tests it (band, threshold or dir); this one tests nothing`);
  });
  return { clauses, refusals };
}

/** Specificity per mig 0131: clause count, +1 when a cause is bound. (Divergence: 1, as seeded.) */
export function computeSpecificity(rowKind: RowKind, clauses: Clause[], cause: CauseKind | null): number {
  if (rowKind === "never") return 0;
  return clauses.length + (cause ? 1 : 0);
}

// ── the loaders ───────────────────────────────────────────────────────────────

async function readJournalSightings(db: VocabDb, word: string, nowMs: number): Promise<TokenSighting[]> {
  const since = new Date(nowMs - CONTAMINATION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const res = await db.prepare(contaminationSightingsSql()).bind(word, since).all();
  const rows = (res.results ?? []) as Array<{ row_id: string; companion_id: string; excerpt: string; at: string; source: string }>;
  return rows
    .filter((r) => isCompanion(r.companion_id) && mentionsToken(String(r.excerpt ?? ""), word))
    .map((r) => ({
      companionId: r.companion_id as CompanionId,
      at: r.at,
      source: r.source,
      rowId: String(r.row_id),
      excerpt: String(r.excerpt ?? "").slice(0, 160),
    }));
}

// ── the write path ────────────────────────────────────────────────────────────

export async function proposeVocabularyRow(db: VocabDb, input: ProposeInput, nowMs = Date.now()): Promise<ProposeResult> {
  const refusals: GateRefusal[] = [];
  const warnings: GateWarning[] = [];
  const refuse = (r: GateRefusal) => refusals.push(r);

  // input: structure that every gate below assumes.
  if (!isCompanion(input.companion_id)) {
    return { ok: false, code: "refused", warnings, refusals: [{ gate: "input", code: "bad_companion", reason: "companion_id must be cypher, drevan or gaia" }] };
  }
  const companion = input.companion_id;
  if (!(ROW_KINDS as readonly string[]).includes(input.row_kind)) {
    return { ok: false, code: "refused", warnings, refusals: [{ gate: "input", code: "bad_row_kind", reason: `row_kind must be one of ${ROW_KINDS.join(", ")}` }] };
  }
  const rowKind = input.row_kind as RowKind;

  // The word goes in exactly as written. Only the outer whitespace is not part of it.
  const word = typeof input.word === "string" ? input.word.trim() : null;
  if (rowKind === "empty") {
    if (word) refuse({ gate: "input", code: "empty_has_word", reason: "an empty row is a condition the author deliberately left unnamed; it carries no word" });
  } else if (!word) {
    refuse({ gate: "input", code: "word_required", reason: `a ${rowKind} row needs a word` });
  } else if (word.length > MAX_WORD_LENGTH || /[\r\n]/.test(word)) {
    refuse({ gate: "input", code: "bad_word", reason: `a word is one short line (at most ${MAX_WORD_LENGTH} characters)` });
  }

  // Everything below reads the table; a missing one means 0131 is not applied (pre-migration: refuse, do not crash).
  let active: ActiveRow[];
  try {
    const res = await db
      .prepare(
        `SELECT id, companion_id, row_kind, word, conditions, cause_kind, specificity, status
           FROM companion_feeling_vocabulary WHERE status = 'active'`,
      )
      .bind()
      .all();
    active = (res.results ?? []) as ActiveRow[];
  } catch (e) {
    if (schemaGap(e)) return { ok: false, code: "not_applied", message: "companion_feeling_vocabulary is not applied here (mig 0131); nothing was written" };
    return { ok: false, code: "unreadable", message: `could not read the vocabulary (${String(e)}); nothing was written` };
  }

  // E is read first (it supplies "the row being revised") but REPORTS last, in the handoff's order.
  const eRefusals: GateRefusal[] = [];
  let target: ActiveRow | null = null;
  if (input.supersedes) {
    target = active.find((r) => r.id === input.supersedes) ?? null;
    if (!target) {
      eRefusals.push({ gate: "E", code: "supersedes_not_active", reason: `"${input.supersedes}" is not an active row; a revision names the active row it replaces (a superseded row is history, not a target)` });
    } else if (target.companion_id !== companion) {
      eRefusals.push({ gate: "E", code: "not_your_vocabulary", reason: `"${target.id}" belongs to ${target.companion_id}. One companion, one vocabulary: nothing averages, nothing merges, and nobody revises a sibling's word.` });
      target = null;
    } else if (target.row_kind !== rowKind) {
      eRefusals.push({ gate: "E", code: "kind_mismatch", reason: `"${target.id}" is a ${target.row_kind} row; a revision keeps its kind` });
    }
  }

  // ── B. contamination ─────────────────────────────────────────────────────────
  let decontaminating = false;
  if ((rowKind === "band" || rowKind === "divergence") && word) {
    try {
      const sightings = await readJournalSightings(db, word, nowMs);
      const verdict: ContaminationVerdict = checkContamination(word, sightings);
      if (verdict.contaminated) {
        refuse({
          gate: "B",
          code: "contaminated",
          reason: `${verdict.reason} It was not renamed for you; choose another, or name this word as a revision once the room has let it go.`,
          evidence: verdict.evidence,
        });
      }
      if (target?.word && !verdict.contaminated) {
        const prev = checkContamination(target.word, await readJournalSightings(db, target.word, nowMs));
        decontaminating = isDecontaminating(target.word, word, prev);
      }
    } catch (e) {
      // Fail closed: an unreadable journal is not "no sightings".
      return { ok: false, code: "unreadable", message: `could not read companion_journal for the shared-window check (${String(e)}); nothing was written` };
    }
  }

  // ── F. reserved identifiers (+ the author's own never-list) ──────────────────
  if ((rowKind === "band" || rowKind === "divergence") && word) {
    const committed = active
      .filter((r) => (r.row_kind === "band" || r.row_kind === "divergence") && r.word && r.id !== target?.id && isCompanion(r.companion_id))
      .map((r) => ({ word: r.word as string, companionId: r.companion_id as CompanionId }));
    const verdict = checkReserved(word, companion, { committed });
    if (verdict.reserved) refuse({ gate: "F", code: "reserved", reason: verdict.reason, evidence: verdict.collisions });
    const barred = active.find((r) => r.row_kind === "never" && r.companion_id === companion && r.word?.toLowerCase() === word.toLowerCase());
    if (barred) {
      refuse({ gate: "F", code: "barred_by_author", reason: `"${word}" is on your own never-list (${barred.id}): you barred it as a name for a state. Lift the bar first if you mean to; nothing was changed.`, evidence: [{ id: barred.id }] });
    }
  }
  if (rowKind === "never" && word) {
    const dupe = active.find((r) => r.row_kind === "never" && r.companion_id === companion && r.word?.toLowerCase() === word.toLowerCase());
    if (dupe) refuse({ gate: "F", code: "already_barred", reason: `"${word}" is already on your never-list (${dupe.id})`, evidence: [{ id: dupe.id }] });
    const using = active.find((r) => (r.row_kind === "band" || r.row_kind === "divergence") && r.companion_id === companion && r.word?.toLowerCase() === word.toLowerCase());
    if (using) refuse({ gate: "F", code: "bars_a_live_word", reason: `"${word}" is a live word of yours (${using.id}); revise it first, then bar it. Nothing was changed.`, evidence: [{ id: using.id }] });
  }

  // ── G. n-ary clauses ─────────────────────────────────────────────────────────
  const g = validateClauses(rowKind, companion, input.conditions);
  g.refusals.forEach(refuse);
  const clauses = g.clauses;

  // ── D. cause ─────────────────────────────────────────────────────────────────
  let cause: CauseKind | null = null;
  if (input.cause_kind !== undefined && input.cause_kind !== null) {
    if (!(CAUSE_KINDS as readonly string[]).includes(input.cause_kind)) {
      refuse({ gate: "D", code: "bad_cause", reason: `cause_kind must be one of ${CAUSE_KINDS.join(", ")} (or absent for any cause)` });
    } else {
      cause = input.cause_kind as CauseKind;
      if (rowKind === "divergence") {
        refuse({ gate: "D", code: "divergence_has_cause", reason: "therlo is a state predicate computed largely from tick-moved floats; binding it to a cause would silently kill the row" });
      } else if (rowKind === "never") {
        refuse({ gate: "D", code: "never_has_cause", reason: "a never row bars a word in every cause" });
      } else if (cause === "tick") {
        refuse({ gate: "D", code: "tick_renders_silent", reason: "a tick renders SILENT (item D): a row bound to cause=tick could never speak. Bind the felt cause (authored, stimulus, autonomous) or none." });
      }
    }
  }

  // ── C. specificity ───────────────────────────────────────────────────────────
  const specificity = computeSpecificity(rowKind, clauses, cause);
  if (input.specificity !== undefined && input.specificity !== specificity) {
    refuse({ gate: "C", code: "specificity_mismatch", reason: `specificity is computed, not claimed: ${clauses.length} clause(s)${cause ? " + 1 bound cause" : ""} = ${specificity}, you sent ${input.specificity}. Nothing was overridden.` });
  }
  if (rowKind === "band" || rowKind === "empty" || rowKind === "divergence") {
    const myKey = conditionKey(clauses, cause);
    for (const r of active) {
      if (r.companion_id !== companion || r.id === target?.id || r.row_kind === "never") continue;
      if (r.row_kind === "divergence" || rowKind === "divergence") {
        if (r.row_kind === rowKind) refuse({ gate: "C", code: "second_divergence", reason: `${r.id} is already your active divergence row; revise it (supersedes) instead of adding a second`, evidence: [{ id: r.id, word: r.word }] });
        continue;
      }
      const other = parseConditions(r.conditions);
      if (conditionKey(other, r.cause_kind) === myKey) {
        refuse({ gate: "C", code: "identical_twin", reason: `${r.id} (${r.word ?? "empty"}) already fires on exactly this condition; two words on one state is a data defect (a tie is logged, never averaged). Revise that row instead.`, evidence: [{ id: r.id, word: r.word }] });
      } else if (r.specificity === specificity) {
        const mine = new Set(clauses.map((c) => JSON.stringify(c)));
        if (other.some((c) => mine.has(JSON.stringify(c)))) {
          warnings.push({ gate: "C", code: "specificity_tie", detail: `${r.id} (${r.word ?? "empty"}) shares a clause and has the same specificity (${specificity}); if both can fire at once the tie is logged, not resolved` });
        }
      }
    }
  }

  // ── A. provenance ────────────────────────────────────────────────────────────
  if (!(AUTHORED_ON as readonly string[]).includes(input.authored_on)) {
    refuse({ gate: "A", code: "authored_on", reason: `authored_on (the surface) is required: ${AUTHORED_ON.join(", ")}. A companion's memory of their own vocabulary is not a reliable witness to it; the surface is.` });
  }
  let authoredAt = new Date(nowMs).toISOString();
  if (input.authored_at !== undefined && input.authored_at !== null && input.authored_at !== "") {
    const ms = typeof input.authored_at === "string" ? parseIso(input.authored_at) : null;
    if (ms === null) refuse({ gate: "A", code: "authored_at", reason: "authored_at must be an ISO timestamp" });
    else if (ms > nowMs + 5 * 60_000) refuse({ gate: "A", code: "authored_at_future", reason: "authored_at is in the future" });
    else authoredAt = new Date(ms).toISOString();
  }
  const captureId = typeof input.capture_id === "string" && input.capture_id.trim() ? input.capture_id.trim() : null;
  if (captureId) {
    try {
      const hit = (await db.prepare("SELECT note_id FROM wm_continuity_notes WHERE note_id = ?1").bind(captureId).first()) as { note_id?: string } | null;
      if (!hit) refuse({ gate: "A", code: "capture_not_found", reason: `capture_id "${captureId}" is not a wm_continuity_notes row (it keys on note_id); a pointer to nothing is lost provenance` });
    } catch (e) {
      if (schemaGap(e)) warnings.push({ gate: "A", code: "capture_unverified", detail: "wm_continuity_notes is not readable here; capture_id was not verified" });
      else return { ok: false, code: "unreadable", message: `could not verify capture_id (${String(e)}); nothing was written` };
    }
  } else {
    warnings.push({ gate: "A", code: "no_capture", detail: "no capture_id: the author's words are not anchored to a continuity note" });
  }

  // ── E. reconciliation ────────────────────────────────────────────────────────
  eRefusals.forEach(refuse);

  if (refusals.length) return { ok: false, code: "refused", refusals, warnings };

  const rendersNumber: 0 | 1 = input.renders_number === true || input.renders_number === 1 ? 1 : 0;
  const note = typeof input.note === "string" && input.note.trim() ? input.note : null; // verbatim: the author's own reason
  const row: WrittenRow = {
    id: `cfv_${companion}_${rowKind === "never" ? "never_" : ""}${slug(word ?? "empty")}_${crypto.randomUUID().slice(0, 6)}`,
    companion_id: companion,
    row_kind: rowKind,
    word: rowKind === "empty" ? null : word,
    conditions: clauses,
    cause_kind: cause,
    specificity,
    renders_number: rendersNumber,
    authored_on: input.authored_on as AuthoredOn,
    authored_at: authoredAt,
    capture_id: captureId,
    supersedes: target?.id ?? null,
    note,
  };
  const outcome = { ok: true as const, dry_run: input.dry_run === true, row, superseded: target?.id ?? null, decontaminating, warnings };
  if (input.dry_run) return outcome;

  const insert = db
    .prepare(
      `INSERT INTO companion_feeling_vocabulary
         (id, companion_id, row_kind, word, conditions, cause_kind, specificity, renders_number, status,
          authored_on, authored_at, capture_id, supersedes, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'active',?9,?10,?11,?12,?13)`,
    )
    .bind(row.id, row.companion_id, row.row_kind, row.word, JSON.stringify(row.conditions), row.cause_kind, row.specificity, row.renders_number, row.authored_on, row.authored_at, row.capture_id, row.supersedes, row.note);
  // The prior row is only FLIPPED, never edited, never deleted: its word and note stay exactly as authored.
  const flip = target
    ? db.prepare("UPDATE companion_feeling_vocabulary SET status = 'superseded' WHERE id = ?1 AND status = 'active'").bind(target.id)
    : null;
  try {
    if (flip && db.batch) await db.batch([insert, flip]);
    else {
      await insert.run();
      if (flip) await flip.run();
    }
  } catch (e) {
    return { ok: false, code: "unreadable", message: `the write failed (${String(e)}); nothing is known to have landed, re-read before retrying` };
  }
  return outcome;
}
