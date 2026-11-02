// src/care/pending.ts
//
// The pending-gesture read: the newest un-acted, un-decayed, un-voided firing assigned to one
// companion. Two callers, one predicate: the loader block (mind/blocks/care.ts, orient) and the
// worker's gesture poll (GET /care/pending/:companion_id, handlers/care.ts).
//
// A voided firing (mig 0155: a check-in undo took away the only reading behind it) asks nobody for a
// gesture. Before 0155 nothing can be voided, so the pre-0155 text is the same read. Only the missing
// column falls back: on any other error the pre-0155 text would offer a voided firing, so it rethrows.

import { missingVoidedAt, onlyIf } from "./schema-gap.js";

export interface PendingCareRow {
  id: string;
  rule: string;
  detail: string;
  detected_at: string;
}

/** ?1 = companion id, ?2 = decay cutoff ISO. Exported so a real-schema test runs this text. */
export const PENDING_CARE_SQL = `SELECT id, rule, detail, detected_at FROM care_actions
  WHERE companion_id = ?1 AND acted_at IS NULL AND voided_at IS NULL AND detected_at > ?2
  ORDER BY detected_at DESC LIMIT 1`;
const PENDING_CARE_SQL_PRE_0155 = `SELECT id, rule, detail, detected_at FROM care_actions
  WHERE companion_id = ?1 AND acted_at IS NULL AND detected_at > ?2
  ORDER BY detected_at DESC LIMIT 1`;

export async function readPendingCare(db: D1Database, companionId: string, decayCutoff: string): Promise<PendingCareRow | null> {
  const run = (sql: string) => db.prepare(sql).bind(companionId, decayCutoff).first<PendingCareRow>();
  return (await run(PENDING_CARE_SQL).catch(onlyIf(missingVoidedAt, () => run(PENDING_CARE_SQL_PRE_0155)))) ?? null;
}
