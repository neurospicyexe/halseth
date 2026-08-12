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

/** Sources that are machine-written. Both still need a human WHEN RAISED -- see below. */
export const RATIFIABLE_SOURCES = ["autonomous", "reflection"] as const;

// ---------------------------------------------------------------------------
// 2026-08-12: the nightly reflection is a LOG by default, and the companion RAISES the ones that
// matter.
//
// The rule above ("both are machine-written and both need a human") was correct about the entries
// and wrong about the arithmetic. `source = 'reflection'` is one vibecheck self-audit per companion
// per night, ~0.9/day each, so the queue GAINS ~2.7/day forever. Measured: 33 of 40 queued entries
// were nightly reflections, while the class Raziel's judgment actually informs
// (`insight/autonomous`, bursty) sat at 2 pending out of 137. A queue fed faster than a person can
// drain it is not a review surface, it is a backlog generator; the oldest had waited 33 days.
//
// Raziel's call, and it is the better design: the companion decides which of its own nightly reads
// is canon-changing and tags that one. They hold the judgment of what matters; he keeps the verdict
// on whatever they raise. A step toward companion ownership rather than a removal of his say.
//
// THIS DOES NOT CROSS THE LINE THIS FILE DRAWS ("widening what he can SEE is safe; widening what a
// machine can DISPOSE OF belongs to him"). Nothing is hidden and nothing is deleted: an unraised
// reflection stays readable on Hearth, stays queryable, and now materializes to the vault so it is
// searchable there too. What changes is only whether it BLOCKS in a to-do list. The companion is
// choosing what to raise, never what to discard.

/** Tag a companion adds to its own entry to put it in front of Raziel. */
export const ESCALATION_TAG = "needs-raziel";

/**
 * Entry carries the escalation tag. `tags_json` is a JSON array of strings, so matching the quoted
 * token cannot collide with a substring of a longer tag.
 */
const ESCALATED_SQL = `tags_json LIKE '%"${ESCALATION_TAG}"%'`;

/**
 * SQL predicate for "awaiting Raziel's review". Inlined as a literal (no bind params) so it can be
 * dropped into any query without disturbing existing positional bindings -- the values are a fixed
 * allowlist in this file, never user input.
 *
 * `autonomous` is unconditional (bursty, and it is the class his verdict teaches most). `reflection`
 * qualifies only when the companion raised it.
 */
export const RATIFIABLE_PENDING_SQL =
  `(source = 'autonomous' OR (source = 'reflection' AND ${ESCALATED_SQL}))` +
  ` AND review_status = 'pending'`;

/**
 * A nightly reflection left as a log: never raised, so never queued, so it will never be accepted
 * and would otherwise never reach the vault. Before this change such an entry could still be
 * accepted by hand and materialize; after it, "log forever" is the default, so without the vault
 * clause below the change would silently make every future nightly self-read unsearchable. That
 * loss would be caused by this change, so this change carries the fix.
 */
export const LOGGED_REFLECTION_SQL =
  `source = 'reflection' AND review_status = 'pending' AND NOT (${ESCALATED_SQL})`;

/**
 * One definition of "this row belongs in the vault", for BOTH the materializer feed and the orphan
 * sweep that deletes vault files. They must be exact complements: the sweep removes any row with a
 * vault_path that is not vault-worthy, so if the two disagreed by a single row the materializer
 * would write that file and the sweep would delete it on every run, forever. Derive the sweep from
 * this constant (`NOT (VAULT_WORTHY_SQL)`) rather than restating it.
 */
export const VAULT_WORTHY_SQL =
  `(review_status = 'accepted' OR (${LOGGED_REFLECTION_SQL}))`;
