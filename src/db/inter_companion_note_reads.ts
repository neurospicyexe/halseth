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
// CLAIM-ONCE (T3): a consuming read used to be SELECT (unreadNotesFor) then INSERT (ackNotesForCompanion),
// two statements with a gap. Two orients for one companion inside that gap (Claude.ai's own
// sessionOrient + mindOrient run concurrently; a bot poll racing a boot) each saw the note unread, so
// each delivered it. claimNotesFor closes the gap: the receipt INSERT carries the unread predicate and
// RETURNs only the rows it actually wrote, so exactly one caller wins each (note, companion) pair.
// Receipts are never deleted, so a claimed note is gone from every "unread" surface and stays readable
// through the explicit history reads (librarian note read, GET /ingest/inter-companion-notes).
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

/**
 * Atomically claim up to `limit` unread notes for ONE companion and return them, oldest first.
 * The receipt insert IS the claim: it runs the same unread predicate as UNREAD_NOTES_SQL, and
 * `RETURNING` yields only rows this statement inserted, so a concurrent claimer gets the rest (or
 * nothing) -- never the same note. Use this where read and ack are one request (orient, session
 * load); the bot notes-poll keeps unreadNotesFor + an explicit ack because it acks AFTER delivering.
 */
export async function claimNotesFor(
  env: Env,
  companionId: string,
  limit: number,
  surface: string | null,
): Promise<UnreadNoteRow[]> {
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `INSERT OR IGNORE INTO inter_companion_note_reads (note_id, companion_id, surface, read_at)
     SELECT n.id, ?1, ?3, ?4
       FROM inter_companion_notes n
      WHERE (n.to_id = ?1 OR n.to_id IS NULL)
        AND n.from_id != ?1
        AND NOT EXISTS (
          SELECT 1 FROM inter_companion_note_reads r
           WHERE r.note_id = n.id AND r.companion_id = ?1
        )
      ORDER BY n.created_at ASC
      LIMIT ?2
     RETURNING note_id`,
  ).bind(companionId, limit, surface, now).all<{ note_id: string }>();
  const ids = (claimed.results ?? []).map((r) => r.note_id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, from_id, to_id, content, read_at, created_at, ref_type, ref_id, reason
       FROM inter_companion_notes WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
  ).bind(...ids).all<UnreadNoteRow>();
  // Same narrowed read_at meaning as ackNotesForCompanion: addressee only, never a broadcast.
  await env.DB.prepare(
    `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${placeholders}) AND to_id = ? AND read_at IS NULL`,
  ).bind(now, ...ids, companionId).run();
  return rows.results ?? [];
}
