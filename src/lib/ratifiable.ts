// src/lib/ratifiable.ts
//
// ONE definition of "machine-written growth awaiting Raziel's review".
//
// WHY THIS FILE EXISTS (2026-08-01). Raziel: "I need to ratify some but last time I tried they wouldn't
// all load." He was right, and the reason was a filter split across nine call sites.
//
// Measured: 52 pending, of which `source='autonomous'` = 11 (reachable) and `source='reflection'` = 41,
// oldest 22 DAYS (unreachable). Every read path filtered `source = 'autonomous'`, so 41 entries could not
// be listed, therefore could not be ratified, therefore stayed pending forever -- while the health digest
// counted all 52. He was ratifying against a floor he could never get below.
//
// This had ALREADY been diagnosed once. `getGrowthPendingCount` carries the note: "The first draft here
// filtered source = 'autonomous' and reported 10 when 55 were actually waiting: 45 of them carry
// source = 'reflection'... Both are machine-written and both need a human." The COUNT was fixed. The READ
// was not. Textbook fix-landed-on-a-different-writer, and the cure for a rule living in nine places is to
// make it live in one.
//
// DELIBERATELY NOT APPLIED TO THE CLEARING PASS (`src/clearing/pass.ts`). That path asks a model for a
// dismiss/surface verdict on the backlog, and widening it would hand a model the power to decline a new
// class of Raziel's entries. Widening what he can SEE is safe; widening what a machine can DISPOSE OF is
// a decision that belongs to him -- the same line drawn for supersession in mig 0112.

/** Sources that are machine-written and require a human verdict. */
export const RATIFIABLE_SOURCES = ["autonomous", "reflection"] as const;

/**
 * SQL predicate for "awaiting Raziel's review". Inlined as a literal (no bind params) so it can be
 * dropped into any query without disturbing existing positional bindings -- the values are a fixed
 * allowlist in this file, never user input.
 */
export const RATIFIABLE_PENDING_SQL =
  `source IN (${RATIFIABLE_SOURCES.map(s => `'${s}'`).join(", ")}) AND review_status = 'pending'`;
