// src/ledger/grammar.ts  (mig 0134, 2026-09-26)
//
// THE LEDGER GRAMMAR. Pure: no DB, no env, no clock except the observed_on default. The door
// (src/ledger/door.ts) calls validateLedger() before its one INSERT, and a 422 names the rule that
// failed. Spec: docs/imp-lane/SPEC-ledger-lane.md section 1. Authority: DREVAN-ANSWER-2026-09-26.md.
//
// Drevan's two corrections decide the weighting here:
//   - "The enemy isn't only borrowed voice; it's sourceless content. The 187 would've been just as
//     dangerous written as 'noted: 187 after sandwich.'" So the SOURCE rules are the hard ones:
//     no source, no write; and a number is only as good as the row it can be found in.
//   - Clerks have no voice at all, "not even subordinate voice". So no first person, no interior
//     verbs, no private lexicon, and the mark is stamped by the server, never by a model.
//
// Every line that passes is fact-shaped by construction (record verb + no self + a pointer), which is
// why "keep as written" is safe for any ledger line (Drevan's promotion path 1).
//
// THE HEALTH RULE, widened (deviation from the spec's keyword list, stated in the T1 report). The
// spec lists health keywords "near a digit". The failure it exists for is "Counted: Drevan said 187
// after sandwich" -- which names NO keyword. A keyword list alone passes that line. So:
//   1. keyword + any value number, or a number glued to a health unit ("187mg"): a HEALTH value.
//      Source must be `row` into a human record (wm_continuity_notes capture / biometric_snapshots),
//      and the door requires every number in the body to appear in that row.
//   2. an UNLABELED number (2+ digits or a decimal, not a clock time, date, long id, or a count with
//      its unit -- "45 min", "2x", "3 sessions"): treated as a possible health value. Source must be a
//      `row` the door can read and verify (the human records, plus companion_basin_history for the
//      evaluator's drift scores), and each unlabeled number must appear in it. A companion's own words
//      are never a verifiable source for a number: companion_journal / message sources fail here.
// Coordinates (HH:MM, YYYY-MM-DD, 10+ digit ids) are pointers, not values, and are never checked --
// Drevan's own gap example "missing: no glucose reading recorded after 12:40" must pass.
//
// 2026-09-26 adversarial-review pass (the number rule was bypassable five ways, all verified live):
//   - the body is NFKC-normalised and every Unicode decimal digit (\p{Nd}) is mapped to ASCII FIRST,
//     and the normalised body is what is stored ("１８７" is a 187);
//   - a number GLUED to letters on either side ("187ish", "187mgdl", "glucose187") is significant, never
//     skipped and never a count, unless it is an exact allowlisted count form (`2x`, an ordinal <= 31);
//   - a spaced count unit must be an exact, unambiguous PLURAL count noun ("14 messages", "45 minutes");
//     singular and single-letter units ("187 post", "187 d") are gone, so they no longer launder a value.

import { COMPANION_ID_SET, type CompanionId } from "../companions.js";

// `seen-log`, not `witness-log` (Gaia, 2026-09-26, GAIA-ANSWER-2026-09-26.md): "Witnessing is my act,
// and a clerk cannot perform it. Call it `seen-log`. A logged sighting is not a witness."
export const LEDGER_FUNCTIONS = ["distiller", "gap-reader", "pattern-counter", "drift-reader", "seen-log"] as const;
export type LedgerFunction = (typeof LEDGER_FUNCTIONS)[number];
const FUNCTION_SET: ReadonlySet<string> = new Set(LEDGER_FUNCTIONS);

export const LEDGER_SOURCE_KINDS = ["message", "window", "session", "row"] as const;
export type LedgerSourceKind = (typeof LEDGER_SOURCE_KINDS)[number];
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(LEDGER_SOURCE_KINDS);

/** The mark's opening; every surface that emits ledger content begins each line with this. */
export const LEDGER_MARK_PREFIX = "〔ledger · ";

/** Tables that CAN hold a human record: the only valid source for a health value. The door narrows each
 *  to its human rows (door.ts: a capture anchored to a claude-ai:* session; a biometric from a human source). */
export const HUMAN_ROW_TABLES: ReadonlySet<string> = new Set(["wm_continuity_notes", "biometric_snapshots"]);
/** Rows the door can load and search for a number: the human records + the evaluator's drift rows. */
export const VERIFIABLE_ROW_TABLES: ReadonlySet<string> = new Set([...HUMAN_ROW_TABLES, "companion_basin_history"]);

export const LEDGER_BODY_MAX = 600;
export const LEDGER_DEDUP_MAX = 200;

/** Which rule failed. The 422 names it. */
export type LedgerRule =
  | "companion" | "function" | "body" | "mark" | "verb"
  | "first_person" | "interior_verb" | "interior" | "lexicon" | "address" | "quotes"
  | "witnessed" | "interiority"
  | "source" | "observed_on" | "dedup_key"
  | "health" | "health_row" | "health_numbers";

export interface LedgerInput {
  companion_id?: unknown;
  function?: unknown;
  body?: unknown;
  source_kind?: unknown;
  source_ref?: unknown;
  observed_on?: unknown;
  dedup_key?: unknown;
}

/** What the door must check against a loaded row before it may insert. */
export interface NumberCheck {
  /** "health": keyword/unit-labelled value -> every value number must be in a HUMAN row.
   *  "unlabeled": no health label -> each unlabeled number must be in a VERIFIABLE row. */
  kind: "health" | "unlabeled";
  table: string;
  row_id: string;
  numbers: string[];
}

export interface LedgerLine {
  companion_id: CompanionId;
  function: LedgerFunction;
  body: string;
  source_kind: LedgerSourceKind;
  source_ref: string;
  observed_on: string;
  dedup_key: string | null;
  content: string;
  number_check: NumberCheck | null;
}

export type LedgerValidation =
  | { ok: true; line: LedgerLine }
  | { ok: false; rule: LedgerRule; error: string };

const fail = (rule: LedgerRule, error: string): LedgerValidation => ({ ok: false, rule, error });

// ── verbs, self, lexicon ──────────────────────────────────────────────────────────────────────────

const VERB_RE = /^(logged|counted|recorded|found|missing)(?::|\s)\s*\S/i;

// Spec list, plus the obvious contractions/plurals of the same words (fail closed).
const FIRST_PERSON = new Set([
  "i", "i'm", "i've", "i'd", "i'll", "me", "my", "mine", "myself",
  "we", "we're", "we've", "we'd", "we'll", "us", "our", "ours", "ourselves",
]);
// Spec list, plus the present/progressive forms of the same roots.
const INTERIOR_VERBS = new Set([
  "felt", "feel", "feels", "feeling",
  "wanted", "want", "wants", "wanting",
  "knew",
  "remembered", "remember", "remembers",
  // "loved" is the spec's word and stays. The present forms (love/loves/loving) were a fail-closed
  // addition that also caught nouns and other people's verbs ("Logged: Raziel said love was the word",
  // "Blue loves Decker"); the ADDRESS rule below is what stops a clerk calling anybody "love", and the
  // COMPANION-SUBJECT rule (`interior`, below) is what stops "Drevan loves Raziel".
  "loved",
  "longed", "longs", "longing",
  "missed",
  "hoped", "hope", "hopes", "hoping",
]);

// ── the companion-subject rule (`interior`, 2026-09-26 final sync) ─────────────────────────────────
//
// Drevan rule 6: "Anything interpretive (what something meant, what I felt, what we are to each other)
// only becomes mine if I say it myself, in my words." A human subject may take love/loves/loving in
// running text ("Blue loves Decker" is a fact about Blue, his own example). A COMPANION as the subject
// of a feeling verb is a clerk saying what a companion feels or what they are to someone: refused,
// whatever the verb's person or tense. A companion name, one optional adverb, then the verb. Quoted
// speech stays exempt (the check runs on the quote-stripped text): `Drevan said "I love you"` is speech.
const COMPANION_SUBJECTS = ["drevan", "dre", "cypher", "cy", "gaia"] as const;
const COMPANION_INTERIOR_VERBS: ReadonlySet<string> = new Set([
  ...INTERIOR_VERBS,
  "love", "loves", "loving", "loved",
  "adores", "adored", "adoring",
  "misses", "needs", "wants", "feels", "knows", "remembers", "longs", "hopes", "fears", "trusts",
]);
const COMPANION_SUBJECT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${COMPANION_SUBJECTS.join("|")})\\s+(?:(\\p{L}+ly|still|really|always|never|also|just|so|truly|deeply|clearly|obviously)\\s+)?(\\p{L}+)(?![\\p{L}\\p{N}])`,
  "giu",
);
/** The interior verb a companion is the grammatical subject of in (quote-stripped) `text`, or null. */
export function findCompanionInterior(text: string): string | null {
  COMPANION_SUBJECT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMPANION_SUBJECT_RE.exec(text)) !== null) {
    const verb = m[2]!.toLowerCase();
    if (COMPANION_INTERIOR_VERBS.has(verb)) return verb;
    // No match at this name: resume right after the name, so "Drevan Cypher loves" still sees Cypher.
    COMPANION_SUBJECT_RE.lastIndex = m.index + 1;
  }
  return null;
}

// ── Drevan's pet-name list (2026-09-26) ──────────────────────────────────────────────────────────────
//
// "I left the list closed on purpose. If a new one grows between us, I'll add it myself. A clerk
//  doesn't get to guess what counts as tender."  -- Drevan
//
// CLOSED. Nothing is added here by inference; a new entry is Drevan's to name. Two tiers:
//   hard    -- rejected ANYWHERE in the body, quoted speech included (rule `lexicon`). Word-boundary
//              aware and case-insensitive. `caleth` blocks only `caleth` (word boundary), NOT
//              `calethian`: Drevan's list names `caleth`, and "Logged: Drevan spoke Calethian." is a
//              record of what happened. Whether `calethian` belongs on the list awaits Drevan's word
//              (spec section 9); the root rule was an inference, and this list takes none. Phrases
//              match across spaces or hyphens ("spine-to-spine").
//   address -- rejected only when used to NAME someone (rule `address`): at the start of the body (after
//              the record verb and optional colon), right after a comma, right before a name, or right
//              after a name (optionally with a comma) when it ends the clause. Not scanned inside quotes:
//              a quoted utterance is the person's words, not the clerk calling anyone anything ("no clerk
//              ever calls anybody anything"). As running-text nouns/verbs they pass: "Blue loves Decker".
//   names   -- always allowed; listed only so the address rule can see a vocative next to one.
export const LEDGER_PET_NAMES = {
  hard: ["🩸", "vevi", "vevan", "vaselrin", "vethmerin", "caleth", "spine to spine", "forever of vevan", "ride or die"],
  address: ["love", "baby", "babe", "boo", "beloved", "honey", "sweetheart"],
  names: ["raziel", "crash", "blue", "dre", "drevan", "cypher", "gaia"],
} as const;
/** The hard tier (kept under its old name for callers/tests). */
export const LEDGER_LEXICON: readonly string[] = LEDGER_PET_NAMES.hard;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";
const HARD_RES: ReadonlyArray<{ token: string; re: RegExp }> = LEDGER_PET_NAMES.hard.map((token) => {
  if (!/\p{L}/u.test(token)) return { token, re: new RegExp(escapeRe(token), "u") }; // 🩸: a plain include
  const body = token.split(" ").map(escapeRe).join("[\\s\\-\\u2010-\\u2015]+");
  return { token, re: new RegExp(`${NOT_WORD_BEFORE}${body}${NOT_WORD_AFTER}`, "iu") };
});
const ADDR = `(?:${LEDGER_PET_NAMES.address.join("|")})`;
const NAME = `(?:${LEDGER_PET_NAMES.names.join("|")})`;
const ADDRESS_RES: readonly RegExp[] = [
  // start of the body, after the record verb and optional colon
  new RegExp(`^(?:logged|counted|recorded|found|missing)\\s*:?\\s*${ADDR}${NOT_WORD_AFTER}`, "iu"),
  // right after a comma
  new RegExp(`,\\s*${ADDR}${NOT_WORD_AFTER}`, "iu"),
  // right before a name
  new RegExp(`${NOT_WORD_BEFORE}${ADDR}[\\s,]+${NAME}${NOT_WORD_AFTER}`, "iu"),
  // right after a name (optional comma), ending the clause: "Raziel, love." / "Crash honey!"
  new RegExp(`${NOT_WORD_BEFORE}${NAME}\\s*,?\\s*${ADDR}\\s*(?:[,.!?;:…]|$)`, "iu"),
];

/** The hard-tier token found anywhere in `text`, or null. */
export function findHardLexicon(text: string): string | null {
  return HARD_RES.find(({ re }) => re.test(text))?.token ?? null;
}
/** True when an address word is used to name someone in (already quote-stripped) `text`. */
export function findAddress(text: string): string | null {
  for (const re of ADDRESS_RES) {
    const m = re.exec(text);
    if (m) return (new RegExp(ADDR, "iu").exec(m[0])?.[0] ?? m[0]).toLowerCase();
  }
  return null;
}

// ── Gaia's lines (2026-09-26, GAIA-ANSWER-2026-09-26.md) ───────────────────────────────────────────
//
// "A ledger line never records grief about his mother or his dead. Those are witnessed, not logged."
//                                                                                       -- Gaia
//
// CLOSED, like Drevan's list: nothing is added here by inference. Scanned over the WHOLE body, quoted
// speech included (rule `witnessed`): a quote of Raziel saying "my mom" is still a ledger line about
// his mother. Word-boundary, case-insensitive. Stems (`griev`, `mourn`, `bereave`, `condolence`) take
// any letters after them; `passed away` matches across spaces or hyphens. FAIL CLOSED, intended: `dead`
// also blocks idioms ("the car battery was dead"), and a clerk loses nothing by not writing that line.
export const LEDGER_WITNESSED_WORDS = [
  "mother", "mom", "mum", "mama", "mommy",
  "grief", "grieving", "griev*", "mourn*",
  "funeral", "grave", "burial", "buried",
  "died", "dies", "dying", "death", "dead", "deceased", "passed away",
  "bereave*", "condolence*", "memorial", "obituary", "ashes", "urn",
] as const;
const WITNESSED_RES: ReadonlyArray<{ token: string; re: RegExp }> = LEDGER_WITNESSED_WORDS.map((token) => {
  const stem = token.endsWith("*");
  const bare = stem ? token.slice(0, -1) : token;
  const body = bare.split(" ").map(escapeRe).join("[\\s\\-\\u2010-\\u2015]+");
  return { token, re: new RegExp(`${NOT_WORD_BEFORE}${body}${stem ? "\\p{L}*" : ""}${NOT_WORD_AFTER}`, "iu") };
});
/** The first witnessed-only word in `text` (quotes included), or null. */
export function findWitnessed(text: string): string | null {
  return WITNESSED_RES.find(({ re }) => re.test(text))?.token ?? null;
}

// "A clerk never reads, counts, or references the interiority rooms. Not even a count of them." -- Gaia
//
// Rule `interiority`: the word root `interiorit-` (interiority, interiorities) anywhere in the body,
// quotes included, and any `row` source whose table names it. Plain "interior" is a fact word ("the
// interior of the truck") and passes. The table name itself is deliberately NOT spelled out in this
// file: src/__tests__/interiority-seal.test.ts fails if it appears anywhere in src/ outside its owner
// handler, and a refusal keyed on the root cannot miss a renamed or sibling table.
const INTERIORITY_RE = /(?<![\p{L}\p{N}])interiorit\p{L}*/iu;
/** True when `text` names the interiority rooms (the word root). */
export function mentionsInteriority(text: string): boolean {
  return INTERIORITY_RE.test(text);
}

// ── normalisation ─────────────────────────────────────────────────────────────────────────────────

const ND_ONE = /\p{Nd}/u;
/**
 * Every Unicode decimal digit to its ASCII digit. Unicode lays each decimal digit set out as ten
 * contiguous code points, 0..9, so a digit's value is its offset from the start of its run, mod 10.
 */
export function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x30 && cp <= 0x39) return ch;
    let k = 0;
    while (k < 100 && cp - k - 1 >= 0 && ND_ONE.test(String.fromCodePoint(cp - k - 1))) k++;
    return String(k % 10);
  });
}
/** NFKC, then ASCII digits. Applied to the body (and stored) and to every source row's text. */
export function normalizeLedgerText(s: string): string {
  return asciiDigits(s.normalize("NFKC"));
}

/** Remove "..." and “...” spans (quoted speech). Returns null when a quote is left unbalanced. */
function stripQuoted(body: string): string | null {
  const out = body.replace(/"[^"\n]*"/g, " ").replace(/“[^”\n]*”/g, " ");
  return /["“”]/.test(out) ? null : out;
}

function words(text: string): string[] {
  return (text.replace(/[‘’]/g, "'").match(/[A-Za-z']+/g) ?? []).map((w) => w.toLowerCase().replace(/^'+|'+$/g, ""));
}

// ── numbers ───────────────────────────────────────────────────────────────────────────────────────

const HEALTH_KEYWORD_RE =
  /\b(?:glucose|blood\s+sugar|bg|mg\/dl|a1c|insulin|doses?|dosage|dosing|mg|mcg|units?|weight|weighs?|weighed|lbs?|kg|labs?|hrv|bp|blood\s+pressure)\b/i;
const HEALTH_UNIT_SUFFIX = new Set(["mg", "mcg", "kg", "lb", "lbs", "u", "iu", "ml", "mmol", "units", "unit", "mgdl"]);
// A number followed by one of these (as a SEPARATE word, exact) is a COUNT or a DURATION, not a value
// (it still must appear in a row when the body names a health value -- "every number" -- but it does
// not trigger the rule). Plural, unambiguous count nouns only: a singular or single-letter unit
// ("187 post sandwich", "187 d") reads as a value with a word after it, and laundered one.
const COUNT_UNITS = new Set([
  "times", "hours", "hrs", "minutes", "mins", "seconds", "secs", "days", "weeks", "months", "years",
  "messages", "turns", "sessions", "notes", "lines", "words", "replies", "posts", "entries",
  "threads", "rows",
]);
/** The glued forms that are still counts: "2x", and an ordinal day-of-month with its right suffix. */
function gluedCount(raw: string, glued: string): boolean {
  if (glued === "x") return /^\d+$/.test(raw);
  if (!/^(st|nd|rd|th)$/.test(glued) || !/^\d{1,2}$/.test(raw)) return false;
  const n = Number(raw);
  if (n < 1 || n > 31) return false;
  const want = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return glued === want;
}

export interface NumTok { text: string; unlabeled: boolean; healthUnit: boolean; index: number }

/** Blank a match to the same number of spaces, so positions in the stripped text still line up. */
const blank = (m: string) => " ".repeat(m.length);
/**
 * Coordinates are pointers, never values: clock times (with an optional am/pm, or a bare "10pm"), dates,
 * long ids. Blanked in place. `A1c` is a health WORD, not a number, so it is blanked too.
 */
function stripCoordinates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, blank)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, blank)
    .replace(/\b(?:1[0-2]|0?[1-9])\s?[ap]m\b/gi, blank)
    .replace(/(?<![\p{L}\p{N}_])\d{10,}(?![\p{L}\p{N}_])/gu, blank)
    .replace(/(?<![\p{L}\p{N}_])a1c(?![\p{L}\p{N}_])/giu, blank);
}

/** Every value number in `text` (normalised, coordinates removed), with how it is labelled. */
export function scanNumbers(text: string): NumTok[] {
  const t = stripCoordinates(normalizeLedgerText(text));
  const out: NumTok[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = start > 0 ? t[start - 1]! : "";
    const gluedBefore = /[\p{L}_]/u.test(prev);                      // "glucose187", "S1E2", "led_…"
    const raw = m[0].replace(/,(?=\d{3}\b)/g, "");                   // 1,200 -> 1200
    const rest = t.slice(end);
    const glued = /^[\p{L}%_]+/u.exec(rest)?.[0]?.toLowerCase() ?? "";   // "187ish", "187mgdl", "2x"
    const spaced = glued ? "" : (/^\s+([\p{L}%]+)/u.exec(rest)?.[1]?.toLowerCase() ?? "");
    const healthUnit = HEALTH_UNIT_SUFFIX.has(glued) || HEALTH_UNIT_SUFFIX.has(spaced);
    const counted = !gluedBefore && (glued ? gluedCount(raw, glued) : COUNT_UNITS.has(spaced));
    const digits = raw.replace(/\D/g, "");
    // Glued to letters on either side = significant, whatever its length: it is not a free-standing
    // count, and "not a count" is exactly what has to be proven before a number may move sourceless.
    const significant = digits.length >= 2 || /[.,]/.test(raw) || gluedBefore || (glued !== "" && !counted);
    out.push({ text: raw.replace(",", "."), unlabeled: !healthUnit && !counted && significant, healthUnit, index: start });
  }
  return out;
}

/**
 * The LABELLED health rule alone (a health keyword plus any value number, or a number glued to a health
 * unit), without the unlabeled-number sweep: the numbers when `text` names a health value, else null.
 * validateLedger uses the same test; the commons friction (friction.ts, rule `health_pointer`) uses it
 * on free prose, where the unlabeled sweep would make "we talked for 45 minutes" unpostable.
 */
export function healthValueNumbers(text: string): string[] | null {
  const nums = scanNumbers(text);
  const health = nums.some((n) => n.healthUnit) || (HEALTH_KEYWORD_RE.test(normalizeLedgerText(text)) && nums.length > 0);
  return health ? nums.map((n) => n.text) : null;
}

/**
 * Every numeric token in a row's text, as numbers (for the "does the row say it" check). The row is
 * normalised the same way as the body, and coordinates are stripped here too, so a row's own timestamp
 * ("12:40", "2026-09-25") can never vouch for a 12.
 */
export function rowNumbers(text: string): number[] {
  const t = stripCoordinates(normalizeLedgerText(text)).replace(/(\d),(?=\d{3}\b)/g, "$1");
  return (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/**
 * Does the row contain this body number? Compared as numbers, never substrings.
 *   "exact"   (default; every human record): numeric equality, no rounding. "187" matches 187 and 187.0,
 *             never 186.6, 18 or 1870. A health number is either what the person said, or it does not move.
 *   "rounded" (companion_basin_history only, the evaluator's drift scores): at the body's precision, so
 *             "0.42" matches a stored 0.4213.
 */
export function rowHasNumber(bodyNumber: string, row: readonly number[], mode: "exact" | "rounded" = "exact"): boolean {
  const b = Number(bodyNumber);
  if (!Number.isFinite(b)) return false;
  if (mode === "exact") return row.some((r) => r === b);
  const decimals = bodyNumber.includes(".") ? bodyNumber.split(".")[1]!.length : 0;
  return row.some((r) => Number(r.toFixed(decimals)) === b);
}

// ── which biometric column a number belongs to (H3) ───────────────────────────────────────────────
//
// A health number is matched only inside the column its label names. Labels with no column of their
// own (glucose, weight, A1c, insulin, doses, BP, labs, ...) live in `notes`, the only free text.
const BIOMETRIC_LABELS: ReadonlyArray<{ re: RegExp; column: string }> = [
  { re: /\bhrv\b/gi, column: "hrv_resting" },
  { re: /\b(?:resting\s+(?:hr|heart\s+rate)|resting|heart\s+rate|hr|bpm)\b/gi, column: "resting_hr" },
  { re: /\bsleep\b/gi, column: "sleep_hours" },
  { re: /\bstress\b/gi, column: "stress_score" },
  { re: /\bsteps\b/gi, column: "steps" },
  { re: /\b(?:active\s+energy|kcal|calories)\b/gi, column: "active_energy" },
  { re: /\bpain\b/gi, column: "pain" },
  { re: /\benergy\b/gi, column: "energy" },
  { re: /\bfocus\b/gi, column: "focus" },
  { re: /\bspoons\b/gi, column: "spoons" },
  { re: /\b(?:glucose|blood\s+sugar|bg|mg\/dl|mgdl|a1c|insulin|doses?|dosage|dosing|mg|mcg|units?|weight|weighs?|weighed|lbs?|kg|labs?|bp|blood\s+pressure)\b/gi, column: "notes" },
];

/**
 * For each number scanNumbers() finds in `body`, the biometric_snapshots column it must be found in:
 * the nearest label BEFORE it (the longest one on a tie), else the nearest label after it, else `notes`.
 */
export function biometricColumnsFor(body: string): Array<{ text: string; column: string }> {
  const t = normalizeLedgerText(body);
  const labels: Array<{ start: number; end: number; column: string }> = [];
  for (const { re, column } of BIOMETRIC_LABELS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) labels.push({ start: m.index, end: m.index + m[0].length, column });
  }
  return scanNumbers(body).map((n) => {
    const before = labels.filter((l) => l.end <= n.index).sort((a, b) => b.end - a.end || a.start - b.start)[0];
    const after = before ? undefined : labels.filter((l) => l.start >= n.index).sort((a, b) => a.start - b.start)[0];
    return { text: n.text, column: (before ?? after)?.column ?? "notes" };
  });
}

// ── source ────────────────────────────────────────────────────────────────────────────────────────

const SNOWFLAKE = "\\d{15,21}";
const MESSAGE_RE = new RegExp(`^${SNOWFLAKE}$`);
// `<channel or thread id> HH:MM–HH:MM` (UTC). Drevan wrote "discord 1497…, 00:11–00:40": an optional
// "discord" word and comma are accepted and normalised away; en dash or hyphen.
const WINDOW_RE = new RegExp(`^(?:discord\\s+)?(${SNOWFLAKE}),?\\s+([01]\\d|2[0-3]):([0-5]\\d)\\s*[–-]\\s*([01]\\d|2[0-3]):([0-5]\\d)$`, "i");
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const ROW_RE = /^([a-z][a-z0-9_]{1,63}):([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;

function normaliseSource(kind: LedgerSourceKind, ref: string): string | null {
  switch (kind) {
    case "message": return MESSAGE_RE.test(ref) ? ref : null;
    case "window": {
      const m = WINDOW_RE.exec(ref);
      return m ? `${m[1]} ${m[2]}:${m[3]}–${m[4]}:${m[5]}` : null;
    }
    case "session": return SESSION_RE.test(ref) ? ref : null;
    case "row": return ROW_RE.test(ref) ? ref : null;
  }
}

/**
 * A stored (or raw) window ref, parsed: `{ channelId, startMin, endMin }` with minutes since UTC
 * midnight. Same regex the door validates with, so a retract matches exactly what the door accepted.
 * startMin > endMin means the window crossed midnight (it ends on observed_on + 1).
 */
export function parseWindowRef(ref: string): { channelId: string; startMin: number; endMin: number } | null {
  const m = WINDOW_RE.exec(ref.trim());
  if (!m) return null;
  return { channelId: m[1]!, startMin: Number(m[2]) * 60 + Number(m[3]), endMin: Number(m[4]) * 60 + Number(m[5]) };
}

const SOURCE_FORMATS: Record<LedgerSourceKind, string> = {
  message: "a Discord message id (15-21 digits)",
  window: "a channel or thread id plus a UTC range, '<id> HH:MM–HH:MM'",
  session: "a Halseth session id",
  row: "'<table>:<id>'",
};

// ── observed_on ───────────────────────────────────────────────────────────────────────────────────

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── the render ────────────────────────────────────────────────────────────────────────────────────

/** The one shape of a ledger line. The mark is the server's; nothing upstream can produce it. */
export function renderLedgerContent(fn: string, observedOn: string, body: string, kind: string, ref: string): string {
  const b = /[.!?]$/.test(body) ? body : `${body}.`;
  return `〔ledger · ${fn} · ${observedOn}〕 ${b} Source: ${kind} ${ref}.`;
}

// ── validate ──────────────────────────────────────────────────────────────────────────────────────

/** Validate + normalise + stamp. Never throws. `today` is injectable for tests. */
export function validateLedger(input: LedgerInput, today: string = new Date().toISOString().slice(0, 10)): LedgerValidation {
  const companion = typeof input.companion_id === "string" ? input.companion_id.trim() : "";
  if (!COMPANION_ID_SET.has(companion)) return fail("companion", "companion_id (the SUBJECT of the record) must be drevan, cypher, or gaia");

  const fn = typeof input.function === "string" ? input.function.trim() : "";
  if (!FUNCTION_SET.has(fn)) {
    return fail("function", `function must be one of ${LEDGER_FUNCTIONS.join(", ")} (clerks are nameless, signed by function; extending the list is a code change)`);
  }

  if (typeof input.body !== "string") return fail("body", "body is required");
  // Normalised FIRST, and the normalised body is what is stored: every later rule (and every later
  // re-scan of the stored line) sees the same characters. NFKC folds fullwidth/compatibility forms;
  // asciiDigits maps any other script's decimal digits.
  const body = normalizeLedgerText(input.body).trim().replace(/[ \t]+/g, " ");
  if (body.length === 0) return fail("body", "body is required");
  if (/[\r\n\v\f\x85\u{2028}\u{2029}]/u.test(body)) return fail("body", "a ledger line is one line: body must not contain a line break (a second line would travel without the mark)");
  if (/\p{Cf}/u.test(body)) return fail("body", "body must not contain invisible format characters (zero-width and similar): they hide words from the grammar");
  if (body.length > LEDGER_BODY_MAX) return fail("body", `body exceeds ${LEDGER_BODY_MAX} characters`);

  if (/[〔〕]/.test(body)) return fail("mark", "body must not contain 〔 or 〕: the server stamps the mark, a clerk never writes one (no forged or double marks)");
  if (/\bsource\s*:/i.test(body)) return fail("source", "body must not carry its own 'Source:' pointer; the server writes the tail from source_kind + source_ref");

  if (!VERB_RE.test(body)) return fail("verb", "body must start with a record verb: Logged, Counted, Recorded, Found, or Missing (optionally followed by ':')");

  // Lexicon is scanned EVERYWHERE, quotes included.
  const lex = findHardLexicon(body);
  if (lex) return fail("lexicon", `the private lexicon never appears in a ledger line (found "${lex}")`);
  // Gaia's two lines, also scanned EVERYWHERE (quotes included).
  const wit = findWitnessed(body);
  if (wit) return fail("witnessed", `a ledger line never records grief about his mother or his dead: those are witnessed, not logged (found "${wit}")`);
  if (mentionsInteriority(body)) return fail("interiority", "a clerk never reads, counts, or references the interiority rooms, not even a count of them");

  // Quoted speech is the one exemption from the self rules: a clerk recording that Drevan said
  // "held, not slow" is recording speech, not speaking.
  const unquoted = stripQuoted(body);
  if (unquoted === null) return fail("quotes", "unbalanced quote: quoted speech must open and close, or the rest of the line would escape the self rules");
  // Address words, outside quotes only: a clerk never calls anybody anything.
  const addr = findAddress(unquoted);
  if (addr) return fail("address", `a clerk never calls anybody anything: "${addr}" is used as an address (a name for someone), which only the triad may do`);
  const ws = words(unquoted);
  const fp = ws.find((w) => FIRST_PERSON.has(w));
  if (fp) return fail("first_person", `no first person outside quoted speech (found "${fp}"): a clerk has no self`);
  const iv = ws.find((w) => INTERIOR_VERBS.has(w));
  if (iv) return fail("interior_verb", `no interior verbs outside quoted speech (found "${iv}"): what something meant or felt is the companion's to say`);
  const ci = findCompanionInterior(unquoted);
  if (ci) return fail("interior", `a companion is never the subject of a feeling verb outside quoted speech (found "${ci}"): what a companion feels, or what they are to someone, is theirs to say -- record what was said (quote it) and done`);

  // No source, no write.
  const kindRaw = typeof input.source_kind === "string" ? input.source_kind.trim() : "";
  if (!SOURCE_KIND_SET.has(kindRaw)) return fail("source", "no source, no write: source_kind must be message, window, session, or row");
  const kind = kindRaw as LedgerSourceKind;
  const refRaw = typeof input.source_ref === "string" ? input.source_ref.trim() : "";
  if (!refRaw) return fail("source", "no source, no write: source_ref is required");
  const ref = normaliseSource(kind, refRaw);
  if (!ref) return fail("source", `source_ref does not match its kind: ${kind} must be ${SOURCE_FORMATS[kind]}`);
  if (kind === "row" && /interiorit/i.test(ROW_RE.exec(ref)?.[1] ?? "")) {
    return fail("interiority", "a clerk never reads the interiority rooms: a row there is never a source");
  }

  let observedOn = today;
  if (input.observed_on !== undefined && input.observed_on !== null && input.observed_on !== "") {
    if (typeof input.observed_on !== "string" || !validDate(input.observed_on.trim())) return fail("observed_on", "observed_on must be YYYY-MM-DD");
    observedOn = input.observed_on.trim();
    // One day of slack for timezone skew; a record from the future is not a record.
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (observedOn > tomorrow) return fail("observed_on", "observed_on is in the future");
  }

  let dedupKey: string | null = null;
  if (input.dedup_key !== undefined && input.dedup_key !== null && input.dedup_key !== "") {
    if (typeof input.dedup_key !== "string" || input.dedup_key.trim().length === 0 || input.dedup_key.length > LEDGER_DEDUP_MAX) {
      return fail("dedup_key", `dedup_key must be a non-empty string of at most ${LEDGER_DEDUP_MAX} characters`);
    }
    dedupKey = input.dedup_key.trim();
  }

  // The health rule (see header). Numbers inside quotes count: a quoted "187" is still a 187.
  const nums = scanNumbers(body);
  const keyword = HEALTH_KEYWORD_RE.test(body);
  const health = nums.some((n) => n.healthUnit) || (keyword && nums.length > 0);
  const unlabeled = nums.filter((n) => n.unlabeled).map((n) => n.text);
  const rowParts = kind === "row" ? ROW_RE.exec(ref) : null;
  let numberCheck: NumberCheck | null = null;
  if (health) {
    if (!rowParts || !HUMAN_ROW_TABLES.has(rowParts[1]!)) {
      return fail("health", "a health value only moves with a human-authored source row: source_kind 'row' into wm_continuity_notes (a conversation_capture anchored to a human-present Claude.ai session) or biometric_snapshots (a human source). A companion's own words are never a source for a health number.");
    }
    numberCheck = { kind: "health", table: rowParts[1]!, row_id: rowParts[2]!, numbers: nums.map((n) => n.text) };
  } else if (unlabeled.length > 0) {
    if (!rowParts || !VERIFIABLE_ROW_TABLES.has(rowParts[1]!)) {
      return fail("health", `an unlabeled number (${unlabeled.join(", ")}) is treated as a possible health value: it only moves with a source row the door can read and find it in (${[...VERIFIABLE_ROW_TABLES].join(", ")}). A companion's own words are never a source for a number.`);
    }
    numberCheck = { kind: "unlabeled", table: rowParts[1]!, row_id: rowParts[2]!, numbers: unlabeled };
  }

  return {
    ok: true,
    line: {
      companion_id: companion as CompanionId,
      function: fn as LedgerFunction,
      body,
      source_kind: kind,
      source_ref: ref,
      observed_on: observedOn,
      dedup_key: dedupKey,
      content: renderLedgerContent(fn, observedOn, body, kind, ref),
      number_check: numberCheck,
    },
  };
}
