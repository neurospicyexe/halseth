// src/webmind/notes.ts
//
// Continuity note: fast append-only write.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmContinuityNote, WmNoteInput } from "./types.js";

export async function addNote(env: Env, input: WmNoteInput): Promise<WmContinuityNote> {
  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO wm_continuity_notes (note_id, agent_id, thread_key, note_type, content, salience, actor, source, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, input.agent_id,
    input.thread_key ?? null, input.note_type ?? "continuity",
    input.content, input.salience ?? "normal",
    input.actor ?? "agent", input.source ?? "system",
    input.correlation_id ?? null, now,
  ).run();

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
