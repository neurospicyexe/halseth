// B63 being_seen, FULL tier (`being_seen_named`): Raziel, in his own speech, named back something specific a
// companion made or said, used a word of theirs, or returned to a thread they opened after it went quiet.
// The companions' definition: "named back something specific they made or said, or used their word or
// something they held unquoted." Halseth decides; the bot only asks (POST /mind/being-seen/check).
//
// PRIVACY: this module never logs, stores or returns the matched text. Only the reason kind
// ("make" | "word" | "phrase" | "thread") and ids leave it.

export type SeenWhy = "make" | "word" | "phrase" | "thread";

/** Mirrors the longest thing a Discord message can say; anything past this is not read. */
export const MAX_TEXT = 4000;
export const MIN_TITLE_LEN = 6;
export const MIN_WORD_LEN = 3;
export const PHRASE_RUN = 3;
/** At least one token of a counted run must be this long, so a run of short generic words never matches. */
export const PHRASE_LONG_TOKEN = 6;
/** A thread counts as "gone quiet" after this many hours of no activity (and stops counting after the window). */
export const THREAD_QUIET_HOURS = 24;
export const THREAD_WINDOW_DAYS = 7;
export const SPEECH_WINDOW_DAYS = 7;

/**
 * Remove what Raziel quoted rather than said: straight "double" and curly “double” quoted spans, and Discord
 * quote lines (`> text` for one line, `>>> text` for everything after it). An unbalanced quote mark removes
 * nothing (it is punctuation, not a quote).
 */
export function stripQuoted(text: string): string {
  let t = text.slice(0, MAX_TEXT);
  // `>>> ` block quote: this line and the rest are quoted.
  const block = t.search(/(^|\n)[ \t]*>>>[ \t]?/);
  if (block !== -1) t = t.slice(0, block);
  t = t.split("\n").filter((line) => !/^[ \t]*>[ \t]?/.test(line)).join("\n");
  t = t.replace(/"[^"\n]*"/g, " ").replace(/“[^”\n]*”/g, " ");
  // Lines of a multi-line quoted span: handle quotes that cross newlines too.
  t = t.replace(/"[^"]*"/g, " ").replace(/“[^”]*”/g, " ");
  return t;
}

const WORD_CHAR = "\\p{L}\\p{N}_";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word (or whole-phrase) containment. `needle` must be non-empty. */
export function containsWhole(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  const re = new RegExp(`(?<![${WORD_CHAR}])${escapeRe(n).replace(/\s+/g, "\\s+")}(?![${WORD_CHAR}])`, "iu");
  return re.test(haystack);
}

// Function words that do not carry a phrase. They are not counted toward the run of four.
const STOPWORDS = new Set((
  "a an the and or but nor so yet of in on at to for from by with without into onto over under about as is are was were be been being am " +
  "do does did done have has had having it its it's this that these those there here i me my mine we us our you your he him his she her they them their " +
  "not no yes if then than too very just also can could would should will shall may might must what when where which who whom whose why how " +
  "all any some each every more most other such only own same s t don't didn't doesn't isn't wasn't i'm i've i'd i'll you're you've you'd you'll " +
  "that's there's what's let's up down out off again once"
).split(/\s+/));

/** Lowercased tokens with punctuation stripped (inner apostrophes kept), stopwords dropped. */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/[‘’]/g, "'").split(/[^\p{L}\p{N}']+/u)) {
    const tok = raw.replace(/^'+|'+$/g, "");
    if (tok && !STOPWORDS.has(tok)) out.push(tok);
  }
  return out;
}

/** Every run of PHRASE_RUN consecutive content tokens holding at least one PHRASE_LONG_TOKEN-char token, as space-joined keys. */
export function runKeys(tokens: string[], n = PHRASE_RUN): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const run = tokens.slice(i, i + n);
    if (run.some((t) => t.length >= PHRASE_LONG_TOKEN)) keys.add(run.join(" "));
  }
  return keys;
}

/** True when the text shares at least one qualifying PHRASE_RUN-token run of content tokens with any of the speech rows. */
export function sharesPhrase(text: string, speech: string[]): boolean {
  const mine = runKeys(contentTokens(text));
  if (mine.size === 0) return false;
  for (const s of speech) {
    for (const k of runKeys(contentTokens(s))) if (mine.has(k)) return true;
  }
  return false;
}

/** A message id is a Discord snowflake or a synthetic id; never anything that could widen a LIKE. */
export function validMessageId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(id);
}
