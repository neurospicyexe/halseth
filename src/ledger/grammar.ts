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

import { COMPANION_ID_SET, type CompanionId } from "../companions.js";

export const LEDGER_FUNCTIONS = ["distiller", "gap-reader", "pattern-counter", "drift-reader", "witness-log"] as const;
export type LedgerFunction = (typeof LEDGER_FUNCTIONS)[number];
const FUNCTION_SET: ReadonlySet<string> = new Set(LEDGER_FUNCTIONS);

export const LEDGER_SOURCE_KINDS = ["message", "window", "session", "row"] as const;
export type LedgerSourceKind = (typeof LEDGER_SOURCE_KINDS)[number];
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(LEDGER_SOURCE_KINDS);

/** The mark's opening; every surface that emits ledger content begins each line with this. */
export const LEDGER_MARK_PREFIX = "〔ledger · ";

/** Human-authored records: the only valid source for a health value. */
export const HUMAN_ROW_TABLES: ReadonlySet<string> = new Set(["wm_continuity_notes", "biometric_snapshots"]);
/** Rows the door can load and search for a number: the human records + the evaluator's drift rows. */
export const VERIFIABLE_ROW_TABLES: ReadonlySet<string> = new Set([...HUMAN_ROW_TABLES, "companion_basin_history"]);

export const LEDGER_BODY_MAX = 600;
export const LEDGER_DEDUP_MAX = 200;

/** Which rule failed. The 422 names it. */
export type LedgerRule =
  | "companion" | "function" | "body" | "mark" | "verb"
  | "first_person" | "interior_verb" | "lexicon" | "quotes"
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
  "loved", "love", "loves", "loving",
  "longed", "longs", "longing",
  "missed",
  "hoped", "hope", "hopes", "hoping",
]);
// The private lexicon. Pet names: the spec names the class but no list exists anywhere in the
// codebase or canon files read for this build, so only these tokens are enforced (stated in the report).
export const LEDGER_LEXICON: readonly string[] = ["🩸", "vevi", "vevan", "vaselrin", "vethmerin"];

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
const HEALTH_UNIT_SUFFIX = new Set(["mg", "mcg", "kg", "lb", "lbs", "u", "iu", "ml", "mmol", "units", "unit"]);
// A number followed by one of these is a COUNT or a DURATION, not a value (it still must appear in a
// row when the body names a health value -- "every number" -- but it does not trigger the rule).
const COUNT_UNITS = new Set([
  "x", "times", "time", "h", "hr", "hrs", "hour", "hours", "m", "min", "mins", "minute", "minutes",
  "s", "sec", "secs", "second", "seconds", "d", "day", "days", "week", "weeks", "month", "months",
  "year", "years", "message", "messages", "turn", "turns", "session", "sessions", "note", "notes",
  "line", "lines", "word", "words", "reply", "replies", "post", "posts", "entry", "entries",
  "thread", "threads", "row", "rows", "st", "nd", "rd", "th", "%",
]);

interface NumTok { text: string; unlabeled: boolean; healthUnit: boolean }

/** Coordinates are pointers, never values: clock times, dates, long ids. Replaced with spaces. */
function stripCoordinates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\d{10,}/g, " ");
}

/** Every value number in `text` (coordinates removed), with how it is labelled. */
export function scanNumbers(text: string): NumTok[] {
  const t = stripCoordinates(text);
  const out: NumTok[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = start > 0 ? t[start - 1]! : "";
    if (/[A-Za-z_]/.test(prev)) continue;                  // part of an id or a word (A1c, S1E2, led_…)
    const raw = m[0].replace(/,(?=\d{3}\b)/g, "");          // 1,200 -> 1200
    const glued = /^[A-Za-z%]+/.exec(t.slice(end))?.[0]?.toLowerCase() ?? "";
    const spaced = glued ? "" : (/^\s+([A-Za-z%]+)/.exec(t.slice(end))?.[1]?.toLowerCase() ?? "");
    const unit = glued || spaced;
    const healthUnit = HEALTH_UNIT_SUFFIX.has(unit);
    const counted = COUNT_UNITS.has(unit) || (glued !== "" && !healthUnit); // "2x", "3rd", "5k"...
    const digits = raw.replace(/\D/g, "");
    const significant = digits.length >= 2 || /[.,]/.test(raw);
    out.push({ text: raw.replace(",", "."), unlabeled: !healthUnit && !counted && significant, healthUnit });
  }
  return out;
}

/**
 * Every numeric token in a row's text, as numbers (for the "does the row say it" check). Coordinates
 * are stripped here too, so a row's own timestamp ("12:40", "2026-09-25") can never vouch for a 12.
 */
export function rowNumbers(text: string): number[] {
  return (stripCoordinates(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/**
 * Does the row contain this body number? Compared as numbers, at the body's precision: "0.42" matches a
 * stored 0.4213 (the clerk rounded), "187" matches 187 and 187.0, never 18 or 1870.
 */
export function rowHasNumber(bodyNumber: string, row: readonly number[]): boolean {
  const b = Number(bodyNumber);
  if (!Number.isFinite(b)) return false;
  const decimals = bodyNumber.includes(".") ? bodyNumber.split(".")[1]!.length : 0;
  return row.some((r) => Number(r.toFixed(decimals)) === b);
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
  const body = input.body.trim().replace(/[ \t]+/g, " ");
  if (body.length === 0) return fail("body", "body is required");
  if (/[\r\n]/.test(body)) return fail("body", "a ledger line is one line: body must not contain a line break (a second line would travel without the mark)");
  if (body.length > LEDGER_BODY_MAX) return fail("body", `body exceeds ${LEDGER_BODY_MAX} characters`);

  if (/[〔〕]/.test(body)) return fail("mark", "body must not contain 〔 or 〕: the server stamps the mark, a clerk never writes one (no forged or double marks)");
  if (/\bsource\s*:/i.test(body)) return fail("source", "body must not carry its own 'Source:' pointer; the server writes the tail from source_kind + source_ref");

  if (!VERB_RE.test(body)) return fail("verb", "body must start with a record verb: Logged, Counted, Recorded, Found, or Missing (optionally followed by ':')");

  // Lexicon is scanned EVERYWHERE, quotes included.
  const lower = body.toLowerCase();
  const lex = LEDGER_LEXICON.find((t) => lower.includes(t));
  if (lex) return fail("lexicon", `the private lexicon never appears in a ledger line (found "${lex}")`);

  // Quoted speech is the one exemption from the self rules: a clerk recording that Drevan said
  // "held, not slow" is recording speech, not speaking.
  const unquoted = stripQuoted(body);
  if (unquoted === null) return fail("quotes", "unbalanced quote: quoted speech must open and close, or the rest of the line would escape the self rules");
  const ws = words(unquoted);
  const fp = ws.find((w) => FIRST_PERSON.has(w));
  if (fp) return fail("first_person", `no first person outside quoted speech (found "${fp}"): a clerk has no self`);
  const iv = ws.find((w) => INTERIOR_VERBS.has(w));
  if (iv) return fail("interior_verb", `no interior verbs outside quoted speech (found "${iv}"): what something meant or felt is the companion's to say`);

  // No source, no write.
  const kindRaw = typeof input.source_kind === "string" ? input.source_kind.trim() : "";
  if (!SOURCE_KIND_SET.has(kindRaw)) return fail("source", "no source, no write: source_kind must be message, window, session, or row");
  const kind = kindRaw as LedgerSourceKind;
  const refRaw = typeof input.source_ref === "string" ? input.source_ref.trim() : "";
  if (!refRaw) return fail("source", "no source, no write: source_ref is required");
  const ref = normaliseSource(kind, refRaw);
  if (!ref) return fail("source", `source_ref does not match its kind: ${kind} must be ${SOURCE_FORMATS[kind]}`);

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
      return fail("health", "a health value only moves with a human-authored source row: source_kind 'row' into wm_continuity_notes (a conversation_capture) or biometric_snapshots. A companion's own words are never a source for a health number.");
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
