// src/care/schema-gap.ts
//
// Which errors may send a care read to an older query shape. Only a schema gap does: the code is
// deployed ahead of a migration and the column or table is not there yet. Anything else (a timeout,
// an overloaded D1, a reset connection) is rethrown, so the caller's own rule for an unreadable care
// table applies. This matters most for voided_at (mig 0155): the pre-0155 text re-admits voided
// firings, so falling back on a transient error would quietly undo a check-in undo.

/** The 0155 column is missing. */
export function missingVoidedAt(e: unknown): boolean {
  return /no such column:?\s*\S*voided_at/i.test(String(e));
}

/** Any missing column or table (the pre-0143 and pre-0141 shapes in care/hold.ts). */
export function schemaGap(e: unknown): boolean {
  return /no such (column|table)/i.test(String(e));
}

/** `.catch(onlyIf(missingVoidedAt, () => retry()))`: fall back on the named gap, rethrow the rest. */
export function onlyIf<T>(gap: (e: unknown) => boolean, fallback: () => Promise<T>): (e: unknown) => Promise<T> {
  return (e) => (gap(e) ? fallback() : Promise.reject(e));
}
