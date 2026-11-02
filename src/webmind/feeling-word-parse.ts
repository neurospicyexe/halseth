/**
 * The Discord grammar for a companion's own feeling word (STATUS B5/B6, bot surface).
 *
 *   feeling word <word>: <clause>[ and <clause>]...[ because <cause_kind>][ note: <free text>]
 *   confirm feeling word <same text>          (writes)
 *   revise feeling word <word>: ...           (supersedes this companion's active row with that word)
 *   confirm revise feeling word ...           (writes the revision)
 *
 * Clause forms:
 *   <label> rising | falling | steady | settling | above baseline
 *   <label> above | below <number 0..1>
 *
 * PURE. No D1, no clock. Two rules govern it:
 *   - Labels resolve against ONE companion's own FLOAT_LABELS, passed in by the caller from the
 *     authenticated identity. A sibling's label is refused by name, an unknown label is refused; nothing
 *     is mapped by guess.
 *   - Nothing the companion did not say is inferred: no float, no direction, no cause. The word and the
 *     note go through verbatim (outer whitespace only). The write module's gates run after this and
 *     surface, never fix.
 */

import { FLOAT_LABELS, type CompanionId } from "./fermentation.js";
import type { BandClause, CauseKind, FloatKey } from "./feeling-line.js";

export const FEELING_WORD_PREFIX_RE = /^(?:please\s+)?(confirm\s+)?(revise\s+)?feeling\s+word\b\s*/i;
export const MY_FEELING_WORDS_RE = /^(?:please\s+)?(?:show\s+)?my\s+feeling\s+words\s*[.?!]?$/i;

export const PARSE_CAUSE_KINDS: readonly CauseKind[] = ["authored", "stimulus", "autonomous", "tick"];
const DIRS = ["rising", "falling", "steady", "settling"] as const;
const FLOAT_ORDER: FloatKey[] = ["f1", "f2", "f3"];

export const FEELING_WORD_SHAPE =
  "feeling word <word>: <label> rising|falling|steady|settling|above baseline  OR  <label> above|below <0..1>" +
  " (join clauses with ' and '), then optionally ' because authored|stimulus|autonomous|tick' and ' note: <your words>'." +
  " 'confirm feeling word ...' writes it, 'revise feeling word <word>: ...' replaces your own, 'my feeling words' lists yours.";

export interface ParsedFeelingWord {
  confirm: boolean;
  revise: boolean;
  word: string;
  conditions: BandClause[];
  cause_kind: CauseKind | null;
  note: string | null;
  /** Text after "feeling word ", verbatim: what the commit line repeats. */
  rest: string;
}

export type ParseFeelingWordResult =
  | { ok: true; parsed: ParsedFeelingWord }
  | { ok: false; code: string; reason: string };

function siblingOwning(label: string, self: CompanionId): CompanionId | null {
  for (const c of Object.keys(FLOAT_LABELS) as CompanionId[]) {
    if (c !== self && FLOAT_LABELS[c].includes(label)) return c;
  }
  return null;
}

export function parseFeelingWord(request: string, companionId: CompanionId): ParseFeelingWordResult {
  const fail = (code: string, reason: string): ParseFeelingWordResult => ({ ok: false, code, reason });
  const text = request.trim();
  const pm = FEELING_WORD_PREFIX_RE.exec(text);
  if (!pm) return fail("not_feeling_word", "not a feeling word request");
  const confirm = Boolean(pm[1]);
  const revise = Boolean(pm[2]);
  const rest = text.slice(pm[0].length);

  const colon = rest.indexOf(":");
  if (colon < 0) return fail("no_colon", "the word is followed by a colon, then its conditions");
  const word = rest.slice(0, colon).trim();
  if (!word) return fail("no_word", "name the word before the colon");
  if (/[\r\n]/.test(word)) return fail("bad_word", "a word is one short line");
  let body = rest.slice(colon + 1);

  // note: is the LAST segment and goes through untouched, so its words can contain "and" / "because".
  let note: string | null = null;
  const nm = /(?:^|\s)note\s*:\s*/i.exec(body);
  if (nm) {
    const n = body.slice(nm.index + nm[0].length).trim();
    note = n || null;
    body = body.slice(0, nm.index);
  }

  body = body.trim().replace(/[.;]+$/, "").trim();

  let cause: CauseKind | null = null;
  const cm = /(?:^|\s)because\s+(\S+)\s*$/i.exec(body);
  if (cm) {
    const c = cm[1]!.toLowerCase();
    if (!(PARSE_CAUSE_KINDS as readonly string[]).includes(c)) {
      return fail("bad_cause", `cause must be one of ${PARSE_CAUSE_KINDS.join(", ")}; got "${cm[1]}"`);
    }
    cause = c as CauseKind;
    body = body.slice(0, cm.index).trim();
  } else if (/\bbecause\b/i.test(body)) {
    return fail("bad_cause", `"because" is followed by one cause: ${PARSE_CAUSE_KINDS.join(", ")}`);
  }

  if (!body) return fail("no_conditions", "a feeling word needs at least one clause");

  const own = FLOAT_LABELS[companionId];
  const conditions: BandClause[] = [];
  for (const raw of body.split(/\s+and\s+/i)) {
    const clause = raw.trim();
    const m = /^([A-Za-z]+)\s+(.+)$/.exec(clause);
    if (!m) return fail("bad_clause", `"${clause}" is not a clause; ${FEELING_WORD_SHAPE}`);
    const label = m[1]!.toLowerCase();
    const idx = own.indexOf(label);
    if (idx < 0) {
      const sib = siblingOwning(label, companionId);
      return fail(
        sib ? "sibling_label" : "unknown_label",
        sib
          ? `"${label}" is ${sib}'s float, not yours; your floats are ${own.join(", ")}`
          : `"${label}" is not one of your floats; your floats are ${own.join(", ")}`,
      );
    }
    const float = FLOAT_ORDER[idx]!;
    const pred = m[2]!.trim().toLowerCase().replace(/\s+/g, " ");

    if (pred === "above baseline") {
      conditions.push({ float, dir: "above_baseline" });
      continue;
    }
    if ((DIRS as readonly string[]).includes(pred)) {
      conditions.push({ float, dir: pred as BandClause["dir"] });
      continue;
    }
    const tm = /^(above|below)\s+(-?(?:\d+\.?\d*|\.\d+))$/.exec(pred);
    if (tm) {
      const value = Number(tm[2]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return fail("value_out_of_range", `${label} ${tm[1]} ${tm[2]}: a threshold is a number from 0 to 1`);
      }
      conditions.push({ float, op: tm[1] === "above" ? "gt" : "lt", value });
      continue;
    }
    return fail("bad_clause", `"${clause}": after ${label} say rising, falling, steady, settling, above baseline, or above/below a number from 0 to 1`);
  }

  return { ok: true, parsed: { confirm, revise, word, conditions, cause_kind: cause, note, rest } };
}

/** "warmth rising and acuity above 0.7": a stored conditions array back into the companion's own labels. */
export function summarizeConditions(companionId: CompanionId, conditions: unknown): string {
  const labels = FLOAT_LABELS[companionId];
  let arr: unknown = conditions;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch { return String(conditions); }
  }
  if (!Array.isArray(arr)) return "";
  return arr
    .map((c: Record<string, unknown>) => {
      if (c && c.predicate === "divergence") return "divergence (authored text against the float)";
      const idx = FLOAT_ORDER.indexOf(c?.float as FloatKey);
      const label = idx >= 0 ? labels[idx]! : String(c?.float ?? "?");
      if (typeof c?.dir === "string") return `${label} ${c.dir === "above_baseline" ? "above baseline" : c.dir}`;
      if (typeof c?.op === "string" && typeof c?.value === "number") {
        const word = c.op === "gt" ? "above" : c.op === "lt" ? "below" : c.op === "gte" ? "at or above" : "at or below";
        return `${label} ${word} ${c.value}`;
      }
      if (typeof c?.band === "string") return `${label} ${c.band}`;
      if (typeof c?.band_above === "string") return `${label} past ${c.band_above}`;
      if (typeof c?.band_at_or_below === "string") return `${label} at or below ${c.band_at_or_below}`;
      return label;
    })
    .join(" and ");
}
