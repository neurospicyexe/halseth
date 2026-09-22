// src/soma/vocab.ts
//
// The companions' own words for their floats, and the translation to the columns those words mean.
//
// This lived inside src/librarian/executors/writes.ts, private to execStateUpdate, from 2026-08-16
// until 2026-09-21. That was fine while `update my state` was the only verb that moved a float.
// It stopped being fine the moment the close payload had to move them too (graph memory Phase 2:
// a float moved by a bare state_update can only be attributed to a session that is OPEN at that
// instant, and the Claude.ai close ritual fires it 30-90 seconds outside its own session window --
// measured, twice, 09-15 and 09-21). Floats that ride the close payload are attributed by
// CONSTRUCTION: sessionClose already writes `authored_close` with the session id and the handover
// as the cause. So the close executor needs the same dialect this table holds, and a second copy
// of it is exactly the shape that gets fixed in one call site out of two
// ([[fix-landed-on-a-different-writer]]).
//
// NOTE ON COERCION: translation maps KEYS and turns authored WORDS into floats. It does not
// finite-guard numbers -- that guard belongs at the write chokepoint (normalizeStateValue in
// src/librarian/backends/halseth.ts), which every path already passes through, so a string
// "0.78" or a NaN is handled in one place for the HTTP, inline-parser, context-JSON and close
// paths alike.

import type { CompanionStateUpdate } from "../librarian/backends/halseth.js";

export const SOMA_VOCAB: Record<string, keyof CompanionStateUpdate> = {
  // Cypher
  acuity:    "soma_float_1",
  presence:  "soma_float_2",
  warmth:    "soma_float_3",
  // Gaia
  stillness: "soma_float_1",
  density:   "soma_float_2",
  perimeter: "soma_float_3",
  // Drevan native vocabulary (TEXT enum columns)
  heat:      "heat",
  reach:     "reach",
  weight:    "weight",
  // Mood + compound state synonyms
  mood:           "current_mood",
  current_mood:   "current_mood",
  compound_state: "compound_state",
  // Emotional layers (migration 0025)
  surface_emotion:        "surface_emotion",
  surface_intensity:      "surface_intensity",
  undercurrent_emotion:   "undercurrent_emotion",
  undercurrent_intensity: "undercurrent_intensity",
  background_emotion:     "background_emotion",
  background_intensity:   "background_intensity",
  // Lane signal (migration 0044)
  motion_state: "motion_state",
  lane_spine:   "lane_spine",
};

// Authored enum word → float translation for the soma float axes (2026-08-16).
//
// The Discord bots' session extracts report SOMA in each companion's authored vocabulary
// (Cypher "acuity: sharp", Gaia "perimeter: held") -- but acuity/presence/warmth and
// stillness/density/perimeter map to NUMERIC soma_float_* columns, so Number("sharp") was NaN,
// every field dropped, and cypher/gaia Discord sessions had never once written their floats
// (drevan's heat/reach/weight are TEXT columns and always landed). Words are the dialect;
// floats are the canonical store the fermentation layer runs on -- so the translation lives
// here, where the dialect already gets translated.
//
// Values are canon-reviewed (2026-08-16) against companion-soma-model.md's healthy bands and
// drift thresholds: these floats are NOT raw intensity -- each axis has a drift alarm at BOTH
// ends, and an in-register self-report must not land on an alarm unless the word names that
// state (blurred/scattered/thin genuinely do). Notably: Gaia's perimeter float is EXTENSION,
// not strength -- "closed" is the canonical contracted state (<0.35), "porous" is the
// overextension failure (boundary leaking, high end). Keyed per AXIS, never per bare word:
// "steady" is presence 0.55 but stillness 0.7, and a flat word map would cross-contaminate.
export const SOMA_WORD_FLOATS: Record<string, Record<string, number>> = {
  // Cypher
  acuity:    { sharp: 0.9, focused: 0.7, blurred: 0.35, scattered: 0.15 },
  presence:  { close: 0.85, warm: 0.7, steady: 0.55, distant: 0.2 },
  warmth:    { charged: 0.85, warm: 0.65, neutral: 0.5, cool: 0.3 },
  // Gaia
  stillness: { still: 0.9, steady: 0.7, moving: 0.4, unsettled: 0.15 },
  density:   { full: 0.9, present: 0.7, light: 0.45, thin: 0.15 },
  perimeter: { porous: 0.9, open: 0.8, held: 0.7, closed: 0.3 },
};

/**
 * The three float AXES in every companion's dialect, plus the raw column names.
 *
 * What the close executor picks out of a close payload: this list and nothing else. The close
 * context also carries a spine, open threads, a feeling, a conclusion and a dream, and running
 * the whole payload through translation would rely on ALLOWED_STATE_COLUMNS downstream to throw
 * the rest away. An allow-list here says what is soma at the point of reading it instead.
 */
export const SOMA_AXIS_KEYS: readonly string[] = [
  "soma_float_1", "soma_float_2", "soma_float_3",
  "acuity", "presence", "warmth",
  "stillness", "density", "perimeter",
  "heat", "reach", "weight",
];

/**
 * Companion vocabulary → DB columns, with authored enum words resolved per axis.
 *
 * Unknown keys pass through UNMAPPED, by design: the caller filters against
 * ALLOWED_STATE_COLUMNS, and silently dropping a key here would hide a typo that the write path
 * can name. An unknown WORD on a known axis also passes through unchanged -- the numeric guard
 * at the write chokepoint drops it, and the decline reason names it.
 */
export function translateSomaVocab(raw: Record<string, unknown>): CompanionStateUpdate {
  const out: CompanionStateUpdate = {};
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    const mapped = SOMA_VOCAB[lk] ?? (k as keyof CompanionStateUpdate);
    let val: unknown = v;
    const wordMap = SOMA_WORD_FLOATS[lk];
    if (wordMap && typeof v === "string") {
      const w = v.trim().toLowerCase();
      if (w in wordMap) val = wordMap[w];
    }
    (out as Record<string, unknown>)[mapped] = val;
  }
  return out;
}
