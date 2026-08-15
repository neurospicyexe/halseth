// ── The unread-notes predicate and ack, in ONE place (mig 0120) ────────────────
//
// Three consumers each had their own copy of "what is unread" keyed on the shared read_at
// column, which made broadcasts (to_id IS NULL) first-reader-wins: whichever surface polled
// first destroyed the note for the other two companions. The Claude Code boot's copy was the
// worst -- no from_id guard (it consumed the booting companion's own outgoing broadcasts) and
// an unscoped UPDATE (it consumed the whole triad's mail).
//
// Unread is now per-companion: a note counts as unread for companion C until C has a receipt
// row in inter_companion_note_reads. Same rule as findOpenSession (mig 0113): this predicate
// lives here and only here -- add no second copy.
//
// read_at on the parent table keeps one narrowed meaning: read by the note's ADDRESSEE.
// Directed notes still get it stamped on ack (halseth.ts:641 gates note edits on it, and
// existing tests assert a companion-acting read_at writer survives). Broadcasts never set it.

import { Env } from "../types";

export interface UnreadNoteRow {
  id: string;
  from_id: string;
  to_id: string | null;
  content: string;
  read_at: string | null;
  created_at: string;
  ref_type: string | null;
  ref_id: string | null;
  reason: string | null;
}

/** The predicate itself, for callers that need the statement inside a D1 batch/Promise.all.
 *  Binds: ?1 = companion_id, ?2 = LIMIT. */
export const UNREAD_NOTES_SQL =
  `SELECT n.id, n.from_id, n.to_id, n.content, n.read_at, n.created_at,
          n.ref_type, n.ref_id, n.reason
     FROM inter_companion_notes n
    WHERE (n.to_id = ?1 OR n.to_id IS NULL)
      AND n.from_id != ?1
      AND NOT EXISTS (
        SELECT 1 FROM inter_companion_note_reads r
         WHERE r.note_id = n.id AND r.companion_id = ?1
      )
    ORDER BY n.created_at ASC
    LIMIT ?2`;

/** Oldest-first unread notes for one companion: addressed to it or broadcast, never its own. */
export async function unreadNotesFor(
  env: Env,
  companionId: string,
  limit: number,
): Promise<UnreadNoteRow[]> {
  const rows = await env.DB.prepare(UNREAD_NOTES_SQL).bind(companionId, limit).all<UnreadNoteRow>();
  return rows.results ?? [];
}

/**
 * Record that ONE companion has read these notes. Receipts are per (note, companion), so a
 * broadcast stays unread for the siblings until each acks it themselves. Idempotent.
 */
export async function ackNotesForCompanion(
  env: Env,
  companionId: string,
  noteIds: string[],
  surface: string | null,
): Promise<void> {
  if (noteIds.length === 0) return;
  const now = new Date().toISOString();
  const statements = noteIds.map((id) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO inter_companion_note_reads (note_id, companion_id, surface, read_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(id, companionId, surface, now),
  );
  const placeholders = noteIds.map(() => "?").join(", ");
  statements.push(
    env.DB.prepare(
      `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${placeholders}) AND to_id = ? AND read_at IS NULL`,
    ).bind(now, ...noteIds, companionId),
  );
  await env.DB.batch(statements);
}
