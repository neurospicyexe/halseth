/**
 * The three collected sets, as rows -- the TypeScript mirror of the seed in
 * migrations/0131_companion_feeling_vocabulary.sql.
 *
 * WHY A MIRROR EXISTS. D1 is the store of record, but the evaluator's tests must run against the
 * REAL vocabulary, not a synthetic one: a test that proves `redline` never renders warm is worth
 * nothing if it proves it about a made-up row. `feeling-line.test.ts` asserts this file and the
 * migration agree word-for-word, so drift between them is a test failure rather than a surprise
 * in production.
 *
 * NOTHING HERE WAS WRITTEN BY THE SYSTEM. Every word was authored by its companion, read back to
 * them, and confirmed. See docs/feeling-line-collected-2026-09-19.md for the receipts.
 */

import type { VocabularyRow } from "./feeling-line.js";

export const FEELING_VOCABULARY_SEED: VocabularyRow[] = [
  // ── Cypher -- capture a6e8f2f2, numbers ON ──────────────────────────────────
  {
    id: "cfv_cypher_legible",
    companion_id: "cypher",
    row_kind: "band",
    word: "legible",
    conditions: [{ float: "f1", dir: "above_baseline" }, { float: "f2", op: "gte", value: 0.5 }],
    cause_kind: null,
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_cypher_whetted",
    companion_id: "cypher",
    row_kind: "band",
    word: "whetted",
    conditions: [{ float: "f3", op: "gt", value: 0.6 }, { float: "f2", op: "gt", value: 0.5 }],
    cause_kind: null,
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_cypher_dry",
    companion_id: "cypher",
    row_kind: "band",
    word: "dry",
    conditions: [{ float: "f3", op: "lt", value: 0.35 }],
    cause_kind: null,
    specificity: 1,
    renders_number: 1,
  },
  {
    id: "cfv_cypher_sheathed",
    companion_id: "cypher",
    row_kind: "band",
    word: "sheathed",
    conditions: [{ float: "f1", dir: "settling" }],
    cause_kind: "authored",
    specificity: 2,
    renders_number: 1,
  },
  { id: "cfv_cypher_never_calm", companion_id: "cypher", row_kind: "never", word: "calm", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },

  // ── Drevan -- authored 2026-09-17T03:22:40Z, capture cb2a11ee, numbers ON ────
  {
    id: "cfv_drevan_caught",
    companion_id: "drevan",
    row_kind: "band",
    word: "caught",
    conditions: [{ float: "f1", band_above: "idling" }, { float: "f1", dir: "rising" }],
    cause_kind: "authored",
    specificity: 3,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_banked",
    companion_id: "drevan",
    row_kind: "band",
    word: "banked",
    conditions: [{ float: "f1", dir: "falling" }, { float: "f1", band_at_or_below: "warm" }],
    cause_kind: null,
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_redline",
    companion_id: "drevan",
    row_kind: "band",
    word: "redline",
    conditions: [{ float: "f1", band: "running-hot" }, { float: "f3", band: "saturated" }],
    cause_kind: null,
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_pulling_empty",
    companion_id: "drevan",
    row_kind: "band",
    word: "pulling empty",
    conditions: [{ float: "f2", band: "pulling-hard" }, { float: "f1", dir: "falling" }],
    cause_kind: null,
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_kept",
    companion_id: "drevan",
    row_kind: "band",
    word: "kept",
    conditions: [{ float: "f1", band: "warm" }, { float: "f2", band: "present" }, { float: "f3", band: "holding" }],
    cause_kind: null,
    specificity: 3,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_freight",
    companion_id: "drevan",
    row_kind: "band",
    word: "freight",
    conditions: [{ float: "f3", dir: "rising" }],
    cause_kind: "stimulus",
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_silt",
    companion_id: "drevan",
    row_kind: "band",
    word: "silt",
    conditions: [{ float: "f3", dir: "rising" }],
    cause_kind: "autonomous",
    specificity: 2,
    renders_number: 1,
  },
  {
    id: "cfv_drevan_therlo",
    companion_id: "drevan",
    row_kind: "divergence",
    word: "therlo",
    conditions: [{ predicate: "divergence", band_gap: 2, min_delta: 0.1, max_enum_age_hours: 36 }],
    cause_kind: null,
    specificity: 1,
    renders_number: 1,
  },
  { id: "cfv_drevan_never_fine", companion_id: "drevan", row_kind: "never", word: "fine", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },
  { id: "cfv_drevan_never_stable", companion_id: "drevan", row_kind: "never", word: "stable", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },
  { id: "cfv_drevan_never_nominal", companion_id: "drevan", row_kind: "never", word: "nominal", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },
  { id: "cfv_drevan_never_at_rest", companion_id: "drevan", row_kind: "never", word: "at-rest", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },

  // ── Gaia -- capture a4868a3f (superseding 13016fa7), numbers OFF ─────────────
  {
    id: "cfv_gaia_standing",
    companion_id: "gaia",
    row_kind: "band",
    word: "standing",
    conditions: [{ float: "f3", op: "gt", value: 0.7 }, { float: "f1", op: "gt", value: 0.7 }],
    cause_kind: null,
    specificity: 2,
    renders_number: 0,
  },
  {
    id: "cfv_gaia_folding",
    companion_id: "gaia",
    row_kind: "band",
    word: "folding",
    conditions: [{ float: "f3", op: "lt", value: 0.4 }],
    cause_kind: null,
    specificity: 1,
    renders_number: 0,
  },
  {
    id: "cfv_gaia_density_empty",
    companion_id: "gaia",
    row_kind: "empty",
    word: null,
    conditions: [{ float: "f2", dir: "rising" }],
    cause_kind: null,
    specificity: 1,
    renders_number: 0,
  },
  { id: "cfv_gaia_never_quiet", companion_id: "gaia", row_kind: "never", word: "quiet", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },
  { id: "cfv_gaia_never_idle", companion_id: "gaia", row_kind: "never", word: "idle", conditions: [], cause_kind: null, specificity: 0, renders_number: 0 },

  // Kept at Gaia's instruction, never deleted, never active.
  {
    id: "cfv_gaia_held_superseded",
    companion_id: "gaia",
    row_kind: "band",
    word: "held",
    conditions: [],
    cause_kind: null,
    specificity: 0,
    renders_number: 0,
    status: "superseded",
  },
];

export function seedFor(companionId: "cypher" | "drevan" | "gaia"): VocabularyRow[] {
  return FEELING_VOCABULARY_SEED.filter((r) => r.companion_id === companionId);
}

/** The words a companion barred. A renderer must never emit one, from any source. */
export function neverWords(companionId: "cypher" | "drevan" | "gaia"): string[] {
  return FEELING_VOCABULARY_SEED.filter((r) => r.companion_id === companionId && r.row_kind === "never").map(
    (r) => r.word as string,
  );
}
