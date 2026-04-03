// src/webmind/sits.ts
// Sit & Resolve lifecycle for companion_journal.
// sit:        mark a journal entry as 'sitting', record a reflection entry
// metabolize: mark a journal entry as 'metabolized'
// readSitting: entries currently sitting for a companion (via companion_journal_sits join)
// readStale:  sitting entries older than companion's sit_resolve_days threshold

import { Env } from '../types.js';
import { WmAgentId, WmSitInput, WmSittingNote } from './types.js';
import { generateId } from '../db/queries.js';

export async function sitNote(
  env: Env,
  input: WmSitInput,
): Promise<{ id: string; sat_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE companion_journal SET processing_status = 'sitting' WHERE id = ?`,
    ).bind(input.note_id),
    env.DB.prepare(
      `INSERT INTO companion_journal_sits (id, note_id, companion_id, sit_text, sat_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, input.note_id, input.companion_id, input.sit_text ?? null, now),
  ]);

  return { id, sat_at: now };
}

export async function metabolizeNote(
  env: Env,
  noteId: string,
  companionId: WmAgentId,
): Promise<{ ok: boolean }> {
  const result = await env.DB.prepare(
    `UPDATE companion_journal
     SET processing_status = 'metabolized'
     WHERE id = ?
       AND id IN (
         SELECT note_id FROM companion_journal_sits WHERE companion_id = ?
       )`,
  ).bind(noteId, companionId).run();

  return { ok: (result.meta?.changes ?? 0) > 0 };
}

export async function readSittingNotes(
  env: Env,
  companionId: WmAgentId,
  opts?: { stale_only?: boolean; limit?: number },
): Promise<WmSittingNote[]> {
  const limit = Math.min(opts?.limit ?? 10, 50);

  let query: string;
  let bindings: unknown[];

  if (opts?.stale_only) {
    // Only notes sitting longer than sit_resolve_days for this companion.
    query = `
      SELECT cj.id AS note_id, cj.note_text AS content, cj.tags AS note_type, cj.created_at,
             cjs.sit_text, cjs.sat_at
      FROM companion_journal cj
      JOIN companion_journal_sits cjs ON cjs.note_id = cj.id AND cjs.companion_id = ?
      JOIN companion_config cc ON cc.id = ?
      WHERE cj.processing_status = 'sitting'
        AND julianday('now') - julianday(cjs.sat_at) >= cc.sit_resolve_days
      ORDER BY cjs.sat_at ASC
      LIMIT ?
    `;
    bindings = [companionId, companionId, limit];
  } else {
    query = `
      SELECT cj.id AS note_id, cj.note_text AS content, cj.tags AS note_type, cj.created_at,
             cjs.sit_text, cjs.sat_at
      FROM companion_journal cj
      JOIN companion_journal_sits cjs ON cjs.note_id = cj.id AND cjs.companion_id = ?
      WHERE cj.processing_status = 'sitting'
      ORDER BY cjs.sat_at ASC
      LIMIT ?
    `;
    bindings = [companionId, limit];
  }

  const stmt = env.DB.prepare(query);
  const result = await stmt.bind(...bindings).all<WmSittingNote>();
  return result.results ?? [];
}
