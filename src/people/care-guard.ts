// src/people/care-guard.ts -- one lexical check for care and health words (B49, plan 2c).
//
// Care data never reaches a prompt as material. People are kept clear of it structurally (the
// frame index reads only graph_people and map_keep_off); this is the second, lexical line. At WRITE
// it warns Raziel (his words, his call) and, in slice 2, rejects a companion's. At READ it drops a
// hit line (defence in depth). It answers with a CATEGORY, never the matched term.
//
// Q3 (plan section 6) is open: Raziel's medication names are added to EXTRA_TERMS once confirmed.

export type CareCategory = "medicine" | "health" | "mental health" | "care routine";

/** Raziel's own medication names, once Q3 is answered. Whole words, case-insensitive. */
export const EXTRA_TERMS: Array<{ term: string; category: CareCategory }> = [];

// Whole word, any script: no letter or digit may touch the start. A trailing `*` in the source
// list means "any letters may follow" (diagnos* covers diagnosed, diagnosis).
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const esc = (t: string) => t.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");
const word = (w: string) => (w.endsWith("*") ? `${L}${esc(w.slice(0, -1))}\\p{L}*` : `${L}${esc(w)}${R}`);

const GROUPS: Array<{ category: CareCategory; terms: string[] }> = [
  { category: "medicine", terms: ["meds", "medication*", "medicine*", "dose", "doses", "dosage", "pill", "pills", "prescription*", "refill*"] },
  { category: "health", terms: ["spoons", "pain", "migraine*", "diagnos*", "symptom*", "hospital*", "seizure*", "biometric*"] },
  { category: "mental health", terms: ["therapy", "therapist*", "psychiatr*", "dissociat*", "self-harm", "suicid*", "relapse*"] },
  { category: "care routine", terms: ["bad night", "care hold", "check-in", "check-ins"] },
];

const COMPILED = GROUPS.map((g) => ({ category: g.category, re: new RegExp(g.terms.map(word).join("|"), "iu") }));
// "ER" is the emergency room only in capitals; "er" is a hesitation.
const ER = new RegExp(`${L}ER${R}`, "u");

/** The category of the first care or health word in the text, or null. Never returns the term. */
export function careCategory(text: string | null | undefined): CareCategory | null {
  if (!text) return null;
  for (const g of COMPILED) if (g.re.test(text)) return g.category;
  if (ER.test(text)) return "health";
  for (const x of EXTRA_TERMS) {
    if (new RegExp(`${L}${esc(x.term)}${R}`, "iu").test(text)) return x.category;
  }
  return null;
}
