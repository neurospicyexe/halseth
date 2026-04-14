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

// ---------------------------------------------------------------------------
// Memory compression
// ---------------------------------------------------------------------------

const COMPRESS_AGE_DAYS = 30;
const COMPRESS_COUNT_CAP = 75;
const COMPRESS_TARGET = 50;
const COMPRESS_BATCH = 20;

export interface CompressibleNote {
  note_id: string;
  content: string;
  created_at: string;
}

export interface ArchiveResult {
  archived: number;
  skipped: string;
}

export async function getEligibleNotesForCompression(
  env: Env,
  agentId: string,
): Promise<CompressibleNote[]> {
  const ageCutoff = new Date(Date.now() - COMPRESS_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM wm_continuity_notes WHERE agent_id = ? AND archived = 0`
  ).bind(agentId).first<{ cnt: number }>();
  const activeCount = countRow?.cnt ?? 0;

  if (activeCount <= COMPRESS_TARGET) return [];

  const rows = await env.DB.prepare(
    activeCount > COMPRESS_COUNT_CAP
      ? `SELECT note_id, content, created_at FROM wm_continuity_notes
         WHERE agent_id = ? AND archived = 0
         ORDER BY created_at ASC LIMIT ?`
      : `SELECT note_id, content, created_at FROM wm_continuity_notes
         WHERE agent_id = ? AND archived = 0 AND created_at < ?
         ORDER BY created_at ASC LIMIT ?`
  ).bind(
    agentId,
    ...(activeCount > COMPRESS_COUNT_CAP
      ? [Math.min(activeCount - COMPRESS_TARGET, COMPRESS_BATCH)]
      : [ageCutoff, COMPRESS_BATCH])
  ).all<CompressibleNote>();

  return rows.results ?? [];
}

export async function archiveNotes(
  env: Env,
  agentId: string,
  notes: CompressibleNote[],
  summary: string,
): Promise<ArchiveResult> {
  if (notes.length === 0) return { archived: 0, skipped: "empty batch" };

  const archiveId = crypto.randomUUID();
  const noteIds = notes.map(n => n.note_id);
  const sortedDates = notes.map(n => n.created_at).sort();

  const stmts = [
    env.DB.prepare(
      `INSERT INTO wm_archive_notes (id, agent_id, summary, note_ids, note_count, period_from, period_to)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      archiveId, agentId, summary,
      JSON.stringify(noteIds), notes.length,
      sortedDates[0], sortedDates[sortedDates.length - 1],
    ),
    ...noteIds.map(id =>
      env.DB.prepare(`UPDATE wm_continuity_notes SET archived = 1 WHERE note_id = ?`).bind(id)
    ),
  ];

  await env.DB.batch(stmts);
  return { archived: notes.length, skipped: "none" };
}
