// src/webmind/heat.ts
//
// Zikkaron-style memory thermodynamics, lazy variant (2026-06-12).
// heat is STORED; decay is COMPUTED at read time. No cron, no background pass:
//   effective = heat / (1 + LAMBDA_PER_DAY * days_since_last_access)
//             + COHERENCE_BONUS * max(0, 1 - age_hours/4)
// Hyperbolic (1/(1+λt)) instead of exponential because D1's SQLite math-function
// build flags are not guaranteed; this is pure arithmetic and portable.
// The coherence bonus keys on created_at (not access) -- "I just told you this"
// rows outrank everything for 4 hours, then fade linearly.

export const LAMBDA_PER_DAY = 0.1;
export const COHERENCE_BONUS = 0.5;
/** Deliberate recall: the companion reached for this row (semantic recall, recall-by-id). */
export const HEAT_BUMP = 0.2;
/**
 * Mere surfacing: orient chose to display this row. Deliberately much smaller than
 * HEAT_BUMP (2026-07-26).
 *
 * Being SHOWN something is not the same as REACHING FOR it. Orient warming what it
 * surfaced made the system's own display choice the evidence for repeating that choice --
 * a positive feedback loop with no negative term. In prod it froze the foreground solid:
 * 38 of cypher's 121 eligible notes sat pinned at HEAT_MAX while 82 had never been
 * surfaced once and, at a 1.5 ceiling against 5.0, never could be.
 */
export const SURFACE_BUMP = 0.02;
export const HEAT_MAX = 5.0;

/** SQL expression for effective heat. Column names are unqualified -- valid in any
 *  query whose FROM table carries heat / last_access_at / created_at. */
export function effectiveHeatSql(): string {
  return `(
    heat / (1.0 + ${LAMBDA_PER_DAY} * (julianday('now') - julianday(coalesce(last_access_at, created_at))))
    + ${COHERENCE_BONUS} * MAX(0, 1.0 - (julianday('now') - julianday(created_at)) * 6.0)
  )`;
}

/** UPDATE statement template that warms a set of rows (access bump, capped).
 *  Pass SURFACE_BUMP for "the system displayed this"; the default HEAT_BUMP is for
 *  "the companion reached for this". */
export function warmSql(table: string, idColumn: string, idCount: number, bump: number = HEAT_BUMP): string {
  const placeholders = Array(idCount).fill("?").join(", ");
  return `UPDATE ${table}
    SET heat = MIN(${HEAT_MAX}, heat + ${bump}), last_access_at = datetime('now')
    WHERE ${idColumn} IN (${placeholders})`;
}
