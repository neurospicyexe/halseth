// src/graph/rebuild.ts
//
// Graph memory Phase 1 (docs/private/graph-memory-spec-2026-08-28.md). graph_edges (mig 0127) is a
// DERIVED, DISPOSABLE projection over relationships that already exist in D1 -- it holds no fact
// nothing else holds. rebuildGraph is the only writer: DELETE every mechanical-provenance row, then
// re-derive from source tables and INSERT OR IGNORE. Run it twice against unchanged source data and
// the row set is byte-identical (deterministic edge identity = UNIQUE(src_table, src_id, dst_table,
// dst_id, edge_type), enforced at the schema level, not just in this code).
//
// WHY WHOLE-TABLE READS. Every source SELECT here is `SELECT * FROM <table>` with no WHERE/JOIN --
// correlation (e.g. matching a conclusion to the row its superseded_by points at) happens in JS
// against the in-memory result set. Companion-table row counts are small (this is a triad of three
// minds, not a multi-tenant system), so the cost is negligible, and it keeps every source read
// trivially fake-able in tests without a SQL-parsing mock.
//
// The C4 sealed companion-private-notes lane (mig 0126) is structurally sealed off from every
// Raziel-facing surface (src/__tests__/sibling-seal.test.ts holds the allowlist of files permitted
// to name that table). This file MUST NEVER read from or write an edge touching that lane, in
// either direction, in this phase or any future one. There is no line below that does -- keep it
// that way, and do not add the table's name to this file even in a comment (the seal test's regex
// matches the identifier anywhere in src/, comments included).
//
// living_wounds: NO backfill. It carries no reference/foreign-key-shaped column to any other table
// (migrations/0005_private_zone.sql) -- inventing one to force a graph edge would be exactly the
// "confident garbage" failure src/handlers/edges.ts already warns about. This is a real gap between
// the spec's ambition and the current schema, not an oversight in this file.

import type { Env } from "../types.js";
import { COMPANION_IDS } from "../companions.js";
import { NOTE_REF_TABLES, type NoteRefType } from "../librarian/backends/halseth.js";

export const MECHANICAL_PROVENANCE_LIKE = "mechanical%";

export interface GraphEdgeRow {
  src_table: string;
  src_id: string;
  dst_table: string;
  dst_id: string;
  edge_type: string;
  writer: string;
  provenance: string;
  created_at: string;
}

export interface SourceCount {
  source: string;
  inserted: number;
}

// D1's batch() has no documented hard cap in this codebase's usage (grep of `.batch(` across src/
// shows every call site passing its full statement array unchunked), but a graph rebuild can produce
// materially more rows than any existing batch call, so this file chunks defensively rather than
// following that precedent blind.
const BATCH_CHUNK_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function selectAll<T>(db: D1Database, table: string): Promise<T[]> {
  const res = await db.prepare(`SELECT * FROM ${table}`).all<T>();
  return res.results ?? [];
}

// ── a. companion_conclusions.superseded_by -> 'supersedes' ────────────────────────────────────────
// Direction: superseded_by lives on the OLD row and points at its replacement, so the edge reads
// replacement --supersedes--> old (src = replacement, dst = old). created_at is the REPLACEMENT
// row's created_at, not the old row's: src/handlers/conclusions.ts writes the new conclusion INSERT
// and the old row's `superseded_by` UPDATE in the same env.DB.batch() call keyed on the same `now` --
// that request IS the birth of the supersede relationship, and the old row's own created_at predates
// it by however long the original belief had been standing. supersede_candidate_id/score (mig 0112)
// are gate PROPOSALS, not confirmed edges -- deliberately ignored (see 0112's header: an edge may
// rank, never hide, until a mind has confirmed it -- a proposal is not a confirmation).
interface ConclusionRow {
  id: string;
  companion_id: string;
  superseded_by: string | null;
  created_at: string;
}

function buildSupersedesEdges(rows: ConclusionRow[]): GraphEdgeRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const edges: GraphEdgeRow[] = [];
  for (const old of rows) {
    if (!old.superseded_by) continue;
    const replacement = byId.get(old.superseded_by);
    if (!replacement) continue; // dangling reference -- nothing to derive an edge from
    edges.push({
      src_table: "companion_conclusions",
      src_id: replacement.id,
      dst_table: "companion_conclusions",
      dst_id: old.id,
      edge_type: "supersedes",
      writer: old.companion_id,
      provenance: "mechanical",
      created_at: replacement.created_at,
    });
  }
  return edges;
}

// ── b. relational_deltas.session_id -> 'logged_in' ─────────────────────────────────────────────────
// companion_id is '' (empty-string placeholder) on MCP-logged rows (documented covenant in the repo
// CLAUDE.md: "MCP-logged rows have companion_id=''"); `agent` is the correct writer source for those.
// Legacy rows carry a real companion_id and no `agent`. Skip rows with no session (NULL or '').
//
// DANGLING SESSIONS (audit finding, 2026-08): 8 of these edges point at a sessions.id that does not
// exist -- all 2026-03 legacy relational_deltas/companion_journal rows, one carrying the literal
// string "current" as its session_id (never a real row, not even a deleted one). relational_deltas
// is append-only by covenant (this file's own header, and CLAUDE.md) -- the source rows can never be
// cleaned, so these edges regenerate identically every rebuild. Ratified decision: mark, don't drop.
// A derived link may be down-ranked or filtered by a consumer, but this projection must never
// silently remove what its source still asserts. `sessionIds` (the live SELECT id FROM sessions set)
// is passed in so these builders stay pure; when session_id is not in that set the edge still gets
// emitted, just stamped `mechanical:dangling` instead of `mechanical`. Determinism holds: the same
// input rows against the same sessions snapshot always produce the same provenance stamp.
interface RelationalDeltaRow {
  id: string;
  companion_id: string | null;
  session_id: string | null;
  agent: string | null;
  created_at: string;
}

function buildRelationalDeltaEdges(rows: RelationalDeltaRow[], sessionIds: Set<string>): GraphEdgeRow[] {
  const edges: GraphEdgeRow[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    const writer = r.companion_id && r.companion_id !== "" ? r.companion_id : (r.agent || "system");
    edges.push({
      src_table: "relational_deltas",
      src_id: r.id,
      dst_table: "sessions",
      dst_id: r.session_id,
      edge_type: "logged_in",
      writer,
      provenance: sessionIds.has(r.session_id) ? "mechanical" : "mechanical:dangling",
      created_at: r.created_at,
    });
  }
  return edges;
}

// ── c. companion_journal.session_id -> 'logged_in' ─────────────────────────────────────────────────
// human_journal has no session_id column at all (migrations/0014_schema_additions_v2.sql) -- not
// touched here, not a gap, just a table this relationship doesn't apply to.
//
// Same dangling-session marking as (b) above, same audit, same covenant -- see that comment.
interface CompanionJournalRow {
  id: string;
  agent: string;
  session_id: string | null;
  created_at: string;
}

function buildJournalEdges(rows: CompanionJournalRow[], sessionIds: Set<string>): GraphEdgeRow[] {
  const edges: GraphEdgeRow[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    edges.push({
      src_table: "companion_journal",
      src_id: r.id,
      dst_table: "sessions",
      dst_id: r.session_id,
      edge_type: "logged_in",
      writer: r.agent,
      provenance: sessionIds.has(r.session_id) ? "mechanical" : "mechanical:dangling",
      created_at: r.created_at,
    });
  }
  return edges;
}

// ── d. inter_companion_notes -> 'sent_to' (+ 'references') ─────────────────────────────────────────
// dst_table='companions' is a literal string, not a real table -- intentional for a derived
// projection whose readers already know the triad's three ids (src/companions.ts COMPANION_IDS).
// Broadcasts (to_id IS NULL) expand to one edge per OTHER companion, provenance
// 'mechanical:broadcast' so a reader can tell "addressed" from "fanned out" apart from the row count.
//
// ref_type/ref_id (mig 0104) get a SECOND edge, 'references', reusing NOTE_REF_TABLES
// (src/librarian/backends/halseth.ts) as the single source of truth for type->table mapping --
// question -> companion_questions, tension -> companion_tensions, council -> council_questions.
// That map is not duplicated here; importing it is the whole point (one parser, one gate).
interface InterCompanionNoteRow {
  id: string;
  from_id: string;
  to_id: string | null;
  created_at: string;
  ref_type: NoteRefType | null;
  ref_id: string | null;
}

function buildNoteEdges(rows: InterCompanionNoteRow[]): GraphEdgeRow[] {
  const edges: GraphEdgeRow[] = [];
  for (const n of rows) {
    if (n.to_id) {
      edges.push({
        src_table: "inter_companion_notes",
        src_id: n.id,
        dst_table: "companions",
        dst_id: n.to_id,
        edge_type: "sent_to",
        writer: n.from_id,
        provenance: "mechanical",
        created_at: n.created_at,
      });
    } else {
      for (const c of COMPANION_IDS) {
        if (c === n.from_id) continue;
        edges.push({
          src_table: "inter_companion_notes",
          src_id: n.id,
          dst_table: "companions",
          dst_id: c,
          edge_type: "sent_to",
          writer: n.from_id,
          provenance: "mechanical:broadcast",
          created_at: n.created_at,
        });
      }
    }

    if (n.ref_type && n.ref_id) {
      const dstTable = NOTE_REF_TABLES[n.ref_type];
      edges.push({
        src_table: "inter_companion_notes",
        src_id: n.id,
        dst_table: dstTable,
        dst_id: n.ref_id,
        edge_type: "references",
        writer: n.from_id,
        provenance: "mechanical",
        created_at: n.created_at,
      });
    }
  }
  return edges;
}

// ── e. companion_tensions -> 'holds_tension' (current-state only) ─────────────────────────────────
// No event history exists for crystallize/release transitions (companion_tensions is a mutable
// current-state row, not append-only) -- this is ONE edge per tension representing "holds it now",
// with status folded into provenance. Do not read this as a timeline; it is a snapshot at rebuild
// time of a table that does not remember its own past. created_at uses first_noted_at, the only
// timestamp this table carries (there is no separate created_at column here).
interface CompanionTensionRow {
  id: string;
  companion_id: string;
  status: string;
  first_noted_at: string;
}

function buildTensionEdges(rows: CompanionTensionRow[]): GraphEdgeRow[] {
  return rows.map((t) => ({
    src_table: "companions",
    src_id: t.companion_id,
    dst_table: "companion_tensions",
    dst_id: t.id,
    edge_type: "holds_tension",
    writer: t.companion_id,
    provenance: `mechanical:status=${t.status}`,
    created_at: t.first_noted_at,
  }));
}

// ── f. handover_packets.session_id -> 'closed_with' ─────────────────────────────────────────────────
// session_id is NOT NULL on this table (migrations/0005_private_zone.sql) -- no null-guard needed.
// No forward handover -> next-session edge here: there is no persisted column recording which
// session a handover was consumed BY (only whether it was `returned`, mig 0005). See
// sessions.handover_id note below for why that's a different relationship, not this one reversed.
interface HandoverPacketRow {
  id: string;
  session_id: string;
  created_at: string;
}

function buildHandoverEdges(rows: HandoverPacketRow[]): GraphEdgeRow[] {
  return rows.map((h) => ({
    src_table: "sessions",
    src_id: h.session_id,
    dst_table: "handover_packets",
    dst_id: h.id,
    edge_type: "closed_with",
    writer: "system",
    provenance: "mechanical",
    created_at: h.created_at,
  }));
}

// ── g. sessions.handover_id -- SKIPPED, documented, not a second edge ──────────────────────────────
// sessions.handover_id is written by session CLOSE (src/mcp/tools/session.ts: "session_close sets
// handover_id") to the id of the handover_packets row that close just created -- the SAME packet
// whose own session_id column already points back at this session. It is the reciprocal FK of
// exactly the relationship (f) already encodes, not a second one; backfilling it here would produce
// a duplicate edge under a different label for one real-world event. Only (f)'s direction
// (session --closed_with--> handover) is kept.
//
// A genuinely different, NOT-yet-backfillable relationship lives at
// src/mcp/tools/session.ts:69-73 -- when a session opens with `prior_handover_id`, that packet is
// marked `returned = 1` but the OPENING session's id is never written anywhere. A live
// 'resumed_from' edge (src = new session, dst = prior handover packet) could be added at that exact
// call site (append one INSERT INTO graph_edges alongside the existing UPDATE, in the same
// env.DB.batch()) the next time that file is touched -- deferred here per the top-level task's
// instruction not to force a live-write hook into a Phase 1 rebuild pass.

// ── rebuild ─────────────────────────────────────────────────────────────────────────────────────

async function insertEdges(db: D1Database, edges: GraphEdgeRow[]): Promise<number> {
  if (edges.length === 0) return 0;
  let inserted = 0;
  for (const group of chunk(edges, BATCH_CHUNK_SIZE)) {
    const stmts = group.map((e) =>
      db.prepare(
        `INSERT OR IGNORE INTO graph_edges
           (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(e.src_table, e.src_id, e.dst_table, e.dst_id, e.edge_type, e.writer, e.provenance, e.created_at),
    );
    const results = await db.batch(stmts);
    for (const r of results) inserted += r.meta?.changes ?? 0;
  }
  return inserted;
}

/**
 * Full, deterministic, idempotent rebuild of graph_edges from source-of-truth tables.
 *
 * DELETE FROM graph_edges WHERE provenance LIKE 'mechanical%' first, so every source below starts
 * from empty and re-derivation is the only path to a row existing -- no accumulation across runs,
 * no drift between what the sources say and what the table holds.
 */
export async function rebuildGraph(env: Env): Promise<SourceCount[]> {
  const db = env.DB;

  await db.prepare(`DELETE FROM graph_edges WHERE provenance LIKE ?`).bind(MECHANICAL_PROVENANCE_LIKE).run();

  const [conclusions, deltas, journal, notes, tensions, handovers, sessions] = await Promise.all([
    selectAll<ConclusionRow>(db, "companion_conclusions"),
    selectAll<RelationalDeltaRow>(db, "relational_deltas"),
    selectAll<CompanionJournalRow>(db, "companion_journal"),
    selectAll<InterCompanionNoteRow>(db, "inter_companion_notes"),
    selectAll<CompanionTensionRow>(db, "companion_tensions"),
    selectAll<HandoverPacketRow>(db, "handover_packets"),
    selectAll<{ id: string }>(db, "sessions"),
  ]);
  // Read once, shared by both dangling-session checks below (b, c) -- see their comments for why
  // a session_id can point at nothing (append-only source, 8-row 2026-03 audit finding).
  const sessionIds = new Set(sessions.map((s) => s.id));

  const sources: Array<{ source: string; edges: GraphEdgeRow[] }> = [
    { source: "companion_conclusions.superseded_by", edges: buildSupersedesEdges(conclusions) },
    { source: "relational_deltas.session_id", edges: buildRelationalDeltaEdges(deltas, sessionIds) },
    { source: "companion_journal.session_id", edges: buildJournalEdges(journal, sessionIds) },
    { source: "inter_companion_notes", edges: buildNoteEdges(notes) },
    { source: "companion_tensions", edges: buildTensionEdges(tensions) },
    { source: "handover_packets.session_id", edges: buildHandoverEdges(handovers) },
  ];

  const counts: SourceCount[] = [];
  for (const s of sources) {
    const inserted = await insertEdges(db, s.edges);
    counts.push({ source: s.source, inserted });
  }
  return counts;
}
