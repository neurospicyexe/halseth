// src/lib/preference-order.ts
//
// ONE definition of "strongest preferences first".
//
// WHY THIS FILE EXISTS (2026-08-08). `companion_preferences.strength` is TEXT holding
// 'high' | 'medium' | 'low', and every read ordered by `strength DESC`. SQLite compares TEXT
// lexicographically, so DESC actually yields:
//
//     medium  >  low  >  high
//
// The strongest preferences sorted LAST. Confirmed against production, not inferred:
// `MIN(strength)` = 'high' and `MAX(strength)` = 'medium', and the live loader returned rows in
// medium → low → high order.
//
// That inverted order feeds `LIMIT 12` in `src/mind/blocks/identity.ts`, which is the identity block
// of the unified MindState loader -- the one all three orient paths were collapsed onto in Phase 1.
// So the cap was dropping a companion's HIGHEST-strength preferences first, on every surface at once.
//
// It had not bitten yet only by luck: cypher sat at exactly 12 active rows against `LIMIT 12`, so
// nothing was being cut. His next preference write would have silently evicted a 'high' row -- and
// silently is the whole problem, because a preference falling out of the prompt looks identical to
// one that was never written.
//
// Found while migrating six of Raziel's standing relational corrections out of Hermes memory into
// this table (2026-08-08). Those rows are exactly the ones that would have been evicted: they are
// the highest-strength entries any companion has, and they exist nowhere else.
//
// DELIBERATELY NOT APPLIED TO `growth_patterns`. That table also orders by `strength DESC` in five
// places, but its `strength` column is INTEGER (observed values 3..10), where DESC is already
// correct. Checked the declared type before touching anything -- a blanket fix across both tables
// would have broken five working queries to fix three broken ones.

/**
 * SQL ordering fragment for `companion_preferences`: strongest first, then most recent.
 *
 * Inlined as a literal (no bind params) so it drops into any query without disturbing existing
 * positional bindings -- the values are a fixed allowlist in this file, never user input.
 *
 * An unrecognised strength sorts last rather than throwing, so a future enum value degrades to
 * "shown if there is room" instead of silently outranking 'high'.
 */
export const PREFERENCE_STRENGTH_ORDER_SQL =
  `CASE strength WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC, created_at DESC`;
