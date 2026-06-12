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
export const HEAT_BUMP = 0.2;
export const HEAT_MAX = 5.0;

/** SQL expression for effective heat. Column names are unqualified -- valid in any
 *  query whose FROM table carries heat / last_access_at / created_at. */
export function effectiveHeatSql(): string {
  return `(
    heat / (1.0 + ${LAMBDA_PER_DAY} * (julianday('now') - julianday(coalesce(last_access_at, created_at))))
    + ${COHERENCE_BONUS} * MAX(0, 1.0 - (julianday('now') - julianday(created_at)) * 6.0)
  )`;
}

/** UPDATE statement template that warms a set of rows (access bump, capped). */
export function warmSql(table: string, idColumn: string, idCount: number): string {
  const placeholders = Array(idCount).fill("?").join(", ");
  return `UPDATE ${table}
    SET heat = MIN(${HEAT_MAX}, heat + ${HEAT_BUMP}), last_access_at = datetime('now')
    WHERE ${idColumn} IN (${placeholders})`;
}
