// src/webmind/notes.ts
//
// Continuity note: fast append-only write.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmContinuityNote, WmNoteInput } from "./types.js";
import { effectiveHeatSql } from "./heat.js";

// Active-note cap for the evictable (non-high) tier, enforced lazily on write.
const NOTE_CAP = 100;

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

  // ROOT CAUSE of bug #7 (2026-06-24): the cap DELETE sorts the note set by
  // effectiveHeatSql() (julianday math) inside a NOT IN subquery. Running that on EVERY
  // insert, in the same D1 batch as the INSERT, intermittently exceeded D1's storage-
  // operation timeout ("object was reset"), which rolled back the WHOLE batch -- the
  // just-written note included -- while the request still returned ack:true. Freshly
  // written continuity notes silently vanished (the original Hermes/OpenClaw handover,
  // and every probe in this session).
  //
  // Fix: a cheap COUNT gate. The cap only matters when the EVICTABLE tier (non-high;
  // high-salience notes are never cap-evicted) is at/over NOTE_CAP. The common case is
  // under cap -> we skip the digest + heavy DELETE entirely and the batch is a single
  // fast INSERT, so the note always commits. Heavy work runs only when there is genuinely
  // overflow to trim. Guards retained for that path: high notes are never candidates, and
  // `note_id != ?` makes the cap structurally unable to evict the row it just wrote.
  const evictableRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM wm_continuity_notes WHERE agent_id = ? AND archived = 0 AND salience != 'high'`
  ).bind(input.agent_id).first<{ c: number }>();
  const overCap = (evictableRow?.c ?? 0) >= NOTE_CAP;

  // SECOND ROOT CAUSE of bug #7 (2026-06-24): this write used env.DB.batch(). Via the
  // Librarian MCP path (handleLibrarianMcp -> fetch-to-node toReqRes/toFetchResponse),
  // the Node-compat response shim tears the request context down as the result serializes,
  // and D1 batch()'s commit does not flush in time -- the INSERT is silently discarded
  // while the tool still returns {ack:true}. Every OTHER write executor that persists via
  // Librarian (deltaLog, conclusion_add, the soma_arc note) uses single-statement .run(),
  // which commits in-line. So addNote now uses .run() too. The cap cleanup runs as separate
  // awaited .run() calls (it was never a real transaction -- D1 batch isn't atomic across
  // these statements anyway, per the original comment).
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

  if (overCap) {
    // Digest the coldest evictable overflow before deleting it (capacity debt, heat-aware
    // since 0074). High-salience notes are excluded from both digest and delete, and the
    // just-inserted row is excluded by id so the cap can never evict what it just wrote.
    const overflow = await env.DB.prepare(`
      SELECT note_id, content, created_at FROM wm_continuity_notes
      WHERE agent_id = ? AND archived = 0 AND salience != 'high' AND note_id != ? AND note_id NOT IN (
        SELECT note_id FROM wm_continuity_notes
        WHERE agent_id = ? AND archived = 0 AND salience != 'high' ORDER BY ${effectiveHeatSql()} DESC LIMIT 100
      )
      ORDER BY created_at ASC
    `).bind(input.agent_id, id, input.agent_id)
      .all<{ note_id: string; content: string; created_at: string }>()
      .then(r => r.results ?? [])
      .catch(() => []);
    if (overflow.length > 0) {
      const summary = overflow
        .map(r => `[${r.created_at.slice(0, 10)}] ${r.content.slice(0, 200)}`)
        .join("\n")
        .slice(0, 8000);
      await env.DB.prepare(`
        INSERT INTO wm_archive_notes (id, agent_id, summary, note_ids, note_count, period_from, period_to)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        generateId(), input.agent_id, summary,
        JSON.stringify(overflow.map(r => r.note_id)), overflow.length,
        overflow[0]!.created_at, overflow[overflow.length - 1]!.created_at,
      ).run();
      await env.DB.prepare(
        `DELETE FROM wm_continuity_notes WHERE note_id IN (${overflow.map(() => "?").join(", ")})`
      ).bind(...overflow.map(r => r.note_id)).run();
    }
  }

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
