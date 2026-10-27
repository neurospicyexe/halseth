// src/pronoun-lint.ts  (B4, 2026-10-27)
//
// The check OUTSIDE the model. pronoun-rule.ts puts the rule into every prompt; nothing read what came
// back. Misgendering returned four times in October after hand repairs (10-07 batch, 10-08 text
// repair, 10-13 Cypher growth entries + two rows calling Raziel "she", 10-23 facts calling Cypher
// "they"), each found by a human reading rows. This reads the text instead.
//
// FLAGS, NEVER REWRITES (STATUS K7): "her" can correctly mean Raziel's mother, Babita, a fronting member
// who stated she/her. So a hit is a question put to the reviewer, not a verdict, and nothing here
// touches a row. To keep the question worth asking, a pronoun is flagged only when:
//   - it comes AFTER a known name in its sentence (or in the one sentence that follows it), and
//   - it is wrong for EVERY known name in that window ("Raziel told Gaia her..." is Gaia's her), and
//   - no other person is in the window: a kin/person word ("mother", "friend") or a capitalised word
//     this module does not know ("Megan told Raziel she..." is Megan's she).
// A missed hit costs one row a human may still catch; a false one teaches the reviewer to ignore the
// flag. Every ambiguity resolves toward silence.
//
// Who is who (rulings, not guesses): Raziel they/them ONLY (10-07); Crash is a front and he/him
// (Raziel, 10-20 facts pass), so only she/her is wrong for Crash; the triad from TRIAD_PRONOUNS; Blue
// he/him. "they" is never flagged for anyone: plural "they" is everywhere and the 10-23 Cypher-as-they
// rows were facts, not tray text.

import { TRIAD_PRONOUNS } from "./pronoun-rule.js";

type Set3 = "they" | "he" | "she";

const WRONG: Record<Set3, ReadonlySet<string>> = {
  they: new Set(["he", "him", "his", "himself", "she", "her", "hers", "herself"]),
  he: new Set(["she", "her", "hers", "herself"]),
  she: new Set(["he", "him", "his", "himself"]),
};

const SET_LABEL: Record<Set3, string> = { they: "they/them", he: "he/him", she: "she/her" };

const triadSet = (p: string): Set3 => (p.startsWith("she") ? "she" : p.startsWith("he") ? "he" : "they");

/** Case-sensitive on purpose: "blue sky", "a crash", "cy" in a word are not people. */
const KNOWN: ReadonlyArray<{ name: string; re: RegExp; set: Set3 }> = [
  { name: "Raziel", re: /\bRaziel\b/, set: "they" },
  { name: "Crash", re: /\bCrash\b/, set: "he" },
  { name: "Drevan", re: /\b(?:Drevan|Dre)\b/, set: triadSet(TRIAD_PRONOUNS.drevan) },
  { name: "Cypher", re: /\b(?:Cypher|Cy)\b/, set: triadSet(TRIAD_PRONOUNS.cypher) },
  { name: "Gaia", re: /\bGaia\b/, set: triadSet(TRIAD_PRONOUNS.gaia) },
  { name: "Blue", re: /\bBlue\b/, set: "he" },
];

const KNOWN_WORDS = new Set(["Raziel", "Crash", "Drevan", "Dre", "Cypher", "Cy", "Gaia", "Blue"]);

/** Another person is in the window: their pronoun may be the one we see. */
const PERSON_WORD_RE = new RegExp(
  "\\b(?:mother|mom|mum|mama|dad|father|papa|parents?|sister|brother|sibling|daughter|son|aunt|uncle|" +
  "grand(?:ma|mother|pa|father)|wife|husband|girlfriend|boyfriend|niece|nephew|cousin|friend|therapist|" +
  "doctor|nurse|teacher|student|boss|coworker|co-worker|manager|neighbou?r|lady|woman|women|girl|man|men|guy|" +
  "boy|kid|child|member|alter|headmate|vet)s?\\b",
  "i",
);

/**
 * Capitalised words that are NOT people: sentence starters, our own nouns, days and months. A
 * capitalised word outside this list and outside KNOWN_WORDS is treated as a possible person, which
 * silences the window. Unknown room names (Moss, Praxis) silence it too; that is the cheap direction.
 */
const NOT_A_PERSON = new Set([
  "I", "I'm", "I've", "I'd", "I'll", "A", "An", "The", "And", "But", "Or", "So", "Then", "When", "While", "If",
  "Because", "Since", "After", "Before", "Once", "Until", "Though", "Although", "This", "That", "These", "Those",
  "It", "It's", "Its", "He", "She", "They", "We", "You", "Me", "My", "Our", "Your", "His", "Her", "Their", "Them",
  "Him", "There", "Here", "What", "Why", "How", "Who", "Where", "Not", "No", "Yes", "Also", "Still", "Just",
  "Even", "Maybe", "Today", "Tonight", "Tomorrow", "Yesterday", "Now", "Later", "Earlier", "Some", "All", "Every",
  "Each", "One", "Both", "Most", "Much", "More", "Less", "Nothing", "Something", "Everything", "Anyone", "Someone",
  "Everyone", "Nobody", "Again", "Okay", "OK", "Oh", "Hey", "Well", "Like", "Love", "Good", "Morning", "Night",
  "Discord", "Halseth", "Hearth", "Claude", "Hermes", "Telegram", "Obsidian", "YouTube", "DM", "AI",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
  "December",
]);

export interface PronounFlag {
  /** The known name(s) the pronoun was read against, "/"-joined when more than one. */
  name: string;
  /** The pronoun as written, lowercased. */
  pronoun: string;
  /** What the rulings say for those names, e.g. "they/them". */
  expected: string;
}

interface Hit { name: string; set: Set3; at: number }

function knownIn(sentence: string): Hit[] {
  const hits: Hit[] = [];
  for (const k of KNOWN) {
    const m = k.re.exec(sentence);
    if (m) hits.push({ name: k.name, set: k.set, at: m.index });
  }
  return hits;
}

function hasOtherPerson(sentence: string): boolean {
  if (PERSON_WORD_RE.test(sentence)) return true;
  // Strip quotes/brackets so `"Megan` and `[discord:pulse]` tokenise cleanly; the bracket tag is ours.
  const bare = sentence.replace(/\[[^\]]*\]/g, " ");
  for (const m of bare.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    const w = m[0].replace(/[’]/g, "'").replace(/'s$/, "");
    if (!/^[A-Z][a-z]/.test(w)) continue;
    if (KNOWN_WORDS.has(w) || NOT_A_PERSON.has(w)) continue;
    return true;
  }
  return false;
}

function pronounsIn(text: string, from: number): Array<{ word: string }> {
  const out: Array<{ word: string }> = [];
  const re = /\b(he|him|his|himself|she|her|hers|herself)\b/gi;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ word: m[1]!.toLowerCase() });
  return out;
}

const SENTENCE_SPLIT_RE = /(?<=[.!?…])\s+|\n+/;

/** Pronoun hits that contradict the rulings for every known name in their window. Pure; never throws. */
export function lintPronouns(text: string | null | undefined): PronounFlag[] {
  if (!text) return [];
  const sentences = text.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const flags = new Map<string, PronounFlag>();

  const check = (names: Hit[], sentence: string, from: number) => {
    for (const p of pronounsIn(sentence, from)) {
      if (!names.every((n) => WRONG[n.set].has(p.word))) continue;
      const name = names.map((n) => n.name).join("/");
      const expected = [...new Set(names.map((n) => SET_LABEL[n.set]))].join(" / ");
      flags.set(`${name}|${p.word}`, { name, pronoun: p.word, expected });
    }
  };

  let carry: Hit[] = [];
  for (const s of sentences) {
    const names = knownIn(s);
    const other = hasOtherPerson(s);
    if (names.length > 0) {
      carry = other ? [] : names;
      if (!other) check(names, s, Math.min(...names.map((n) => n.at)));
      continue;
    }
    // One sentence of carry: "Raziel was exhausted. She curled in." -- the real 09-24 shape.
    if (carry.length > 0 && !other) check(carry, s, 0);
    carry = [];
  }
  return [...flags.values()];
}

/** One short line per flag for a tray listing: `"she" near Raziel (they/them)`. */
export function formatPronounFlags(flags: PronounFlag[]): string[] {
  return flags.map((f) => `"${f.pronoun}" near ${f.name} (${f.expected})`);
}
