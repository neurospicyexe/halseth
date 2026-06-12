// src/webmind/notes.ts
//
// Continuity note: fast append-only write.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmContinuityNote, WmNoteInput } from "./types.js";
import { effectiveHeatSql } from "./heat.js";

export async function addNote(env: Env, input: WmNoteInput): Promise<WmContinuityNote> {
  // Write gate: if thread_key is set, return the existing note if one was written
  // in the last 10 minutes. Prevents Claude Code Stop hooks and Discord synthesis
  // from flooding the same thread with near-identical notes.
  if (input.thread_key) {
    const recent = await env.DB.prepare(
      `SELECT note_id, content, created_at FROM wm_continuity_notes
       WHERE agent_id = ? AND archived = 0 AND thread_key = ?
       AND created_at > datetime('now', '-10 minutes')
       ORDER BY created_at DESC LIMIT 1`
    ).bind(input.agent_id, input.thread_key)
     .first<{ note_id: string; content: string; created_at: string }>();
    if (recent) return {
      note_id: recent.note_id,
      agent_id: input.agent_id,
      thread_key: input.thread_key,
      note_type: input.note_type ?? "continuity",
      content: recent.content,
      salience: input.salience ?? "normal",
      actor: input.actor ?? "agent",
      source: input.source ?? "system",
      correlation_id: input.correlation_id ?? null,
      created_at: recent.created_at,
    };
  }

  const id = generateId();
  const now = new Date().toISOString();

  // Digest-then-delete (capacity debt, 2026-06-09; heat-aware since 0074): rows past
  // the cap are written to wm_archive_notes as a truncation digest BEFORE the cap
  // delete, so continuity content is compressed rather than silently lost. The keep
  // set is the 99 HOTTEST by effective heat (the about-to-insert note occupies slot
  // 100 -- age 0 gives it the full coherence bonus, so it always survives its own
  // cap). Overflow = the coldest, matching exactly what the cap DELETE removes after
  // the insert lands (both use the same effective-heat ORDER BY). If a concurrent
  // write shifts the boundary between this read and the batch, the worst case is a
  // row digested twice or deleted one tick later -- never deleted undigested-and-unkept.
  const overflow = await env.DB.prepare(`
    SELECT note_id, content, created_at FROM wm_continuity_notes
    WHERE agent_id = ? AND archived = 0 AND note_id NOT IN (
      SELECT note_id FROM wm_continuity_notes
      WHERE agent_id = ? AND archived = 0 ORDER BY ${effectiveHeatSql()} DESC LIMIT 99
    )
    ORDER BY created_at ASC
  `).bind(input.agent_id, input.agent_id)
    .all<{ note_id: string; content: string; created_at: string }>()
    .then(r => r.results ?? [])
    .catch(() => []);

  // Batch: INSERT, digest (if overflow), then write-time cap. Cap runs after insert so the
  // new row is included in the "keep" set. The effective-heat ORDER BY sorts the ~100
  // surviving rows in memory after the index narrows by agent -- fine at cap scale.
  const statements = [
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
  ];
  if (overflow.length > 0) {
    const summary = overflow
      .map(r => `[${r.created_at.slice(0, 10)}] ${r.content.slice(0, 200)}`)
      .join("\n")
      .slice(0, 8000);
    statements.push(env.DB.prepare(`
      INSERT INTO wm_archive_notes (id, agent_id, summary, note_ids, note_count, period_from, period_to)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId(), input.agent_id, summary,
      JSON.stringify(overflow.map(r => r.note_id)), overflow.length,
      overflow[0]!.created_at, overflow[overflow.length - 1]!.created_at,
    ));
  }
  statements.push(env.DB.prepare(`
    DELETE FROM wm_continuity_notes
    WHERE agent_id = ? AND archived = 0 AND note_id NOT IN (
      SELECT note_id FROM wm_continuity_notes
      WHERE agent_id = ? AND archived = 0 ORDER BY ${effectiveHeatSql()} DESC LIMIT 100
    )
  `).bind(input.agent_id, input.agent_id));
  await env.DB.batch(statements);

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
// Recent notes read (cross-companion feed for heartbeat + autonomous worker)
// ---------------------------------------------------------------------------

export interface RecentNote {
  note_id: string;
  agent_id: string;
  content: string;
  salience: string;
  source: string | null;
  created_at: string;
}

export async function readRecentNotes(
  env: Env,
  opts: { sinceHours?: number; limit?: number; source?: string } = {},
): Promise<RecentNote[]> {
  const sinceHours = Math.min(opts.sinceHours ?? 24, 168);
  const limit = Math.min(opts.limit ?? 30, 100);
  const cutoff = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const conditions = ["archived = 0", "created_at > ?"];
  const bindings: unknown[] = [cutoff];
  if (opts.source) {
    conditions.push("source = ?");
    bindings.push(opts.source);
  }
  bindings.push(limit);

  const rows = await env.DB.prepare(
    `SELECT note_id, agent_id, content, salience, source, created_at
     FROM wm_continuity_notes
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(...bindings).all<RecentNote>();

  return rows.results ?? [];
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
    env.DB.prepare(
      `UPDATE wm_continuity_notes SET archived = 1 WHERE note_id IN (${noteIds.map(() => '?').join(', ')})`
    ).bind(...noteIds),
  ];

  // D1 batch() is NOT a transaction -- partial failure can leave the archive row
  // inserted but source notes still unarchived (orphaned entry, safe to retry:
  // the INSERT will 409 on the UUID PK and the UPDATE is idempotent).
  await env.DB.batch(stmts);
  return { archived: notes.length, skipped: "none" };
}
