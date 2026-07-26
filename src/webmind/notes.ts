// src/webmind/notes.ts
//
// Continuity note: fast append-only write.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmContinuityNote, WmNoteInput } from "./types.js";
import { effectiveHeatSql, warmSql } from "./heat.js";
import { embedText, embedAndStoreAsync, composeHandoverText } from "../mcp/embed.js";

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

  // Reachable by meaning from the moment it exists (2026-07-09). Awaited, not fire-and-forget:
  // a floating promise here dies under write pressure exactly as it did on companion_journal,
  // and an unembedded note is an orphan by construction -- the very thing orphan_memory flags.
  await embedNote(env, id, input.agent_id, input.content);

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
  note_type: string | null;
  source: string | null;
  created_at: string;
}

export async function readRecentNotes(
  env: Env,
  opts: { sinceHours?: number; limit?: number; source?: string; agent_id?: string; note_type?: string } = {},
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
  if (opts.agent_id) {
    conditions.push("agent_id = ?");
    bindings.push(opts.agent_id);
  }
  if (opts.note_type) {
    conditions.push("note_type = ?");
    bindings.push(opts.note_type);
  }
  bindings.push(limit);

  const rows = await env.DB.prepare(
    `SELECT note_id, agent_id, content, salience, note_type, source, created_at
     FROM wm_continuity_notes
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(...bindings).all<RecentNote>();

  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// Salience demotion (day-distillation, 2026-07-06)
// ---------------------------------------------------------------------------

/**
 * Demote a companion's high-salience notes of one type to normal. Used by the nightly
 * day-distillation: after the rich first-person day note lands (salience=high), the
 * day's session fragments drop out of the orient diet (orient reads salience='high'
 * only) without being archived or deleted -- they stay readable on Hearth and in
 * recall, so digests can be audited against their raw material.
 */
export async function demoteNotes(
  env: Env,
  opts: { agent_id: string; note_type: string; before?: string },
): Promise<number> {
  const before = opts.before ?? new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE wm_continuity_notes SET salience = 'normal'
     WHERE agent_id = ? AND note_type = ? AND salience = 'high' AND archived = 0 AND created_at <= ?`,
  ).bind(opts.agent_id, opts.note_type, before).run();
  return r.meta.changes ?? 0;
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

export interface RecalledNote {
  note_id: string;
  content: string;
  created_at: string;
  salience: string;
  thread_key: string | null;
}

/**
 * Recall by MEANING, not by label. The core gap the boot audit kept circling.
 *
 * Before this, `wm_continuity_notes` could only be recalled if something already knew a
 * note's id: they were never embedded, orient surfaced them through a ~3-slot salience+recency
 * pool, and nothing searched them semantically. Result: 4,202 of 4,441 notes never once
 * accessed, and Guardian's `orphan_memory` correctly flagged 2026-04-15 notes as unreachable.
 * The retrieval mandates fired on an explicit label they'd never see.
 *
 * Warming is deliberate here BY CONSTRUCTION: a note is warmed because a companion ASKED for
 * this meaning and RECEIVED it -- only the final returned set warms, never every candidate
 * fetched for ranking, and never anything merely displayed. Warming on surfacing would silence
 * Guardian's orphan_memory without improving recall, which is gaming the metric.
 *
 * 2026-07-19 (coverage + composition fix): recall now also searches handover_packets -- the
 * durable human-session surface (spine, last_real_thing, open_threads) that was never embedded --
 * and companion_journal, source-classified since mig 0103.
 * And because the embedded corpus is ~2/3 machine-written, life-queries (`source_class: "life"`,
 * the default) soft re-rank by source class: human-session sources full weight, swarm/system/cron
 * down-weighted, unknown/legacy in between. `source_class: "all"` disables the re-rank -- the
 * full corpus stays reachable on demand. Soft re-rank, not a hard wall: a machine-written note
 * that matches strongly still beats a weak human match.
 */
export type SourceClass = "life" | "all";

export interface RecalledMemory {
  note_id: string;
  content: string;
  created_at: string;
  salience: string;
  thread_key: string | null;
  kind: "note" | "handover" | "journal";
  source: string | null;
  score: number;
}

// Source classes observed in prod (2026-07-19 census). Unlisted sources score neutral --
// new writers land at 0.85 until classified, never silently zeroed.
export const HUMAN_SOURCES = new Set([
  "claude_code", "session_close", "session", "session-log", "cypher-session", "hearth_ritual_compost",
]);
export const MACHINE_SOURCES = new Set([
  "synthesis_loop", "system", "soma_update", "autonomous", "discord_swarm", "discord_speech",
  "deploy-verified", "evaluator", "metronome", "pattern_worker", "synthesis-gap-detector",
]);

function sourceWeight(kind: RecalledMemory["kind"], source: string | null): number {
  if (kind === "handover") return 1.0;             // human-session by construction
  if (source && HUMAN_SOURCES.has(source)) return 1.0;
  if (source && MACHINE_SOURCES.has(source)) return 0.6;
  return 0.85;                                      // 'legacy' (mig 0103) / 'discord' (mixed) / unknown
}

const RECALL_SCORE_FLOOR = 0.35;  // don't warm noise; leave until A+B have data (fix set D)

export async function recallNotesByMeaning(
  env: Env,
  agentId: string,
  query: string,
  limit = 5,
  sourceClass: SourceClass = "life",
): Promise<RecalledMemory[]> {
  const text = query.trim();
  if (!text) return [];
  const vector = await embedText(env, text);
  if (!vector) return [];

  // One query per table (two $eq filters beat relying on $in support), in parallel.
  // Over-fetch both: the floor and the re-rank both cut after the fact.
  const topK = Math.min(limit * 6, 60);
  const [noteRes, handoverRes, journalRes] = await Promise.all([
    env.VECTORIZE.query(vector, {
      topK, returnMetadata: "all",
      filter: { table: "wm_continuity_notes", companion_id: agentId },
    }),
    env.VECTORIZE.query(vector, {
      topK, returnMetadata: "all",
      filter: { table: "handover_packets", companion_id: agentId },
    }),
    env.VECTORIZE.query(vector, {
      topK, returnMetadata: "all",
      filter: { table: "companion_journal", companion_id: agentId },
    }),
  ]);

  const candidateIds = (res: { matches?: Array<{ score?: number; metadata?: unknown }> }, tbl: string) =>
    (res.matches ?? [])
      .filter(m => typeof m.score === "number" && m.score >= RECALL_SCORE_FLOOR)
      .map(m => {
        const rowId = (m.metadata as Record<string, unknown> | undefined)?.row_id;
        return typeof rowId === "string" && rowId.length > 0
          ? { rowId, score: m.score as number, table: tbl }
          : null;
      })
      .filter((v): v is { rowId: string; score: number; table: string } => v !== null);

  const noteCands = candidateIds(noteRes, "wm_continuity_notes");
  const handoverCands = candidateIds(handoverRes, "handover_packets");
  const journalCands = candidateIds(journalRes, "companion_journal");
  if (noteCands.length === 0 && handoverCands.length === 0 && journalCands.length === 0) return [];

  // Fetch candidate rows WITHOUT warming -- ranking needs `source` from D1 (it is not in
  // vector metadata), and only what is actually returned may warm.
  const entries: Array<RecalledMemory & { effective: number }> = [];

  if (noteCands.length > 0) {
    const placeholders = noteCands.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT note_id, content, created_at, salience, thread_key, source FROM wm_continuity_notes
       WHERE agent_id = ? AND note_id IN (${placeholders})`
    ).bind(agentId, ...noteCands.map(c => c.rowId))
      .all<RecalledNote & { source: string | null }>();
    const scoreById = new Map(noteCands.map(c => [c.rowId, c.score]));
    for (const r of rows.results ?? []) {
      const score = scoreById.get(r.note_id) ?? 0;
      const weight = sourceClass === "life" ? sourceWeight("note", r.source) : 1;
      entries.push({
        note_id: r.note_id, content: r.content, created_at: r.created_at,
        salience: r.salience, thread_key: r.thread_key,
        kind: "note", source: r.source, score, effective: score * weight,
      });
    }
  }

  if (handoverCands.length > 0) {
    const placeholders = handoverCands.map(() => "?").join(", ");
    // No agent_id column here -- per-companion scoping came from the vector metadata filter
    // (handovers of pre-0019 sessions embed with companion "" and never reach this query).
    const rows = await env.DB.prepare(
      `SELECT id, spine, last_real_thing, open_threads, created_at FROM handover_packets
       WHERE id IN (${placeholders})`
    ).bind(...handoverCands.map(c => c.rowId))
      .all<{ id: string; spine: string; last_real_thing: string | null; open_threads: string | null; created_at: string }>();
    const scoreById = new Map(handoverCands.map(c => [c.rowId, c.score]));
    for (const r of rows.results ?? []) {
      const score = scoreById.get(r.id) ?? 0;
      entries.push({
        note_id: r.id,
        content: composeHandoverText(r.spine, r.last_real_thing, r.open_threads),
        created_at: r.created_at,
        salience: "handover", thread_key: null,
        kind: "handover", source: "session_close", score, effective: score,
      });
    }
  }

  if (journalCands.length > 0) {
    const placeholders = journalCands.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, note_text, created_at, source FROM companion_journal
       WHERE agent = ? AND archived = 0 AND id IN (${placeholders})`
    ).bind(agentId, ...journalCands.map(c => c.rowId))
      .all<{ id: string; note_text: string; created_at: string; source: string | null }>();
    const scoreById = new Map(journalCands.map(c => [c.rowId, c.score]));
    for (const r of rows.results ?? []) {
      const score = scoreById.get(r.id) ?? 0;
      const weight = sourceClass === "life" ? sourceWeight("journal", r.source) : 1;
      entries.push({
        note_id: r.id, content: r.note_text, created_at: r.created_at,
        salience: "journal", thread_key: null,
        kind: "journal", source: r.source, score, effective: score * weight,
      });
    }
  }

  entries.sort((a, b) => b.effective - a.effective);
  const selected = entries.slice(0, limit);

  // Warm ONLY the returned notes (handovers have no heat machinery).
  const warmIds = selected.filter(e => e.kind === "note").map(e => e.note_id);
  if (warmIds.length > 0) {
    await env.DB.prepare(warmSql("wm_continuity_notes", "note_id", warmIds.length))
      .bind(...warmIds).run();
  }

  // Warm ONLY the returned journal rows (mig 0105: journal earns salience the same way).
  const journalWarmIds = selected.filter(e => e.kind === "journal").map(e => e.note_id);
  if (journalWarmIds.length > 0) {
    await env.DB.prepare(warmSql("companion_journal", "id", journalWarmIds.length))
      .bind(...journalWarmIds).run();
  }

  return selected.map(({ effective: _effective, ...rest }) => rest);
}

/** Embed a continuity note so it is reachable by meaning. Never throws: D1 is truth. */
export async function embedNote(env: Env, noteId: string, agentId: string, content: string): Promise<void> {
  try {
    await embedAndStoreAsync(env, content, "wm_continuity_notes", noteId, agentId);
  } catch (e) {
    console.warn(`[wm_note] embed failed for ${noteId} (row kept, index stale):`, String(e));
  }
}

// Deliberate recall: fetch specific notes AND warm them (heat bump + last_access_at).
// This is the rescue path for the Guardian's orphan_memory flags -- setting
// last_access_at is what stops the detector re-flagging the same note forever.
export async function recallNotes(env: Env, agentId: string, noteIds: string[]): Promise<RecalledNote[]> {
  if (noteIds.length === 0) return [];
  const placeholders = noteIds.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT note_id, content, created_at, salience, thread_key FROM wm_continuity_notes
     WHERE agent_id = ? AND note_id IN (${placeholders})`
  ).bind(agentId, ...noteIds).all<RecalledNote>();
  const found = rows.results ?? [];
  if (found.length > 0) {
    await env.DB.prepare(warmSql("wm_continuity_notes", "note_id", found.length))
      .bind(...found.map(n => n.note_id)).run();
  }
  return found;
}
