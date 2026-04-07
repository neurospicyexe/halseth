// src/webmind/notes.ts
//
// Continuity note: fast append-only write.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmContinuityNote, WmNoteInput } from "./types.js";

export async function addNote(env: Env, input: WmNoteInput): Promise<WmContinuityNote> {
  const id = generateId();
  const now = new Date().toISOString();

  // Batch: INSERT then write-time cap. Cap runs after insert so the new row is included
  // in the "keep" set. idx_wm_notes_agent(agent_id, created_at DESC) makes the subquery
  // an index scan -- no full-table scan even as notes accumulate.
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO wm_continuity_notes (note_id, agent_id, thread_key, note_type, content, salience, actor, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, input.agent_id,
      input.thread_key ?? null, input.note_type ?? "continuity",
      input.content, input.salience ?? "normal",
      input.actor ?? "agent", input.source ?? "system",
      input.correlation_id ?? null, now,
    ),
    env.DB.prepare(`
      DELETE FROM wm_continuity_notes
      WHERE agent_id = ? AND note_id NOT IN (
        SELECT note_id FROM wm_continuity_notes
        WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100
      )
    `).bind(input.agent_id, input.agent_id),
  ]);

  return {
    note_id: id,
    agent_id: input.agent_id,
    thread_key: input.thread_key ?? null,
    note_type: input.note_type ?? "continuity",
    content: input.content,
    salience: input.salience ?? "normal",
    actor: input.actor ?? "agent",
    source: input.source ?? "system",
    correlation_id: input.correlation_id ?? null,
    created_at: now,
  };
}
