// src/webmind/sits.ts
// Sit & Resolve lifecycle for companion_notes.
// sit:        mark a note as 'sitting', record a reflection entry
// metabolize: mark a note as 'metabolized'
// readSitting: notes currently sitting for a companion (via companion_note_sits join)
// readStale:  sitting notes older than companion's sit_resolve_days threshold

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
      `UPDATE companion_notes SET processing_status = 'sitting' WHERE id = ?`,
    ).bind(input.note_id),
    env.DB.prepare(
      `INSERT INTO companion_note_sits (id, note_id, companion_id, sit_text, sat_at)
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
    `UPDATE companion_notes
     SET processing_status = 'metabolized'
     WHERE id = ?
       AND id IN (
         SELECT note_id FROM companion_note_sits WHERE companion_id = ?
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
      SELECT cn.id AS note_id, cn.content, cn.note_type, cn.created_at,
             cns.sit_text, cns.sat_at
      FROM companion_notes cn
      JOIN companion_note_sits cns ON cns.note_id = cn.id AND cns.companion_id = ?
      JOIN companion_config cc ON cc.id = ?
      WHERE cn.processing_status = 'sitting'
        AND julianday('now') - julianday(cns.sat_at) >= cc.sit_resolve_days
      ORDER BY cns.sat_at ASC
      LIMIT ?
    `;
    bindings = [companionId, companionId, limit];
  } else {
    query = `
      SELECT cn.id AS note_id, cn.content, cn.note_type, cn.created_at,
             cns.sit_text, cns.sat_at
      FROM companion_notes cn
      JOIN companion_note_sits cns ON cns.note_id = cn.id AND cns.companion_id = ?
      WHERE cn.processing_status = 'sitting'
      ORDER BY cns.sat_at ASC
      LIMIT ?
    `;
    bindings = [companionId, limit];
  }

  const stmt = env.DB.prepare(query);
  const result = await stmt.bind(...bindings).all<WmSittingNote>();
  return result.results ?? [];
}
