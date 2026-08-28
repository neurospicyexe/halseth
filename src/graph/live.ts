// src/graph/live.ts
//
// Graph memory Phase 1 continued: LIVE edge writes at source-writer call sites, so graph_edges
// (mig 0127) tracks truth between nightly rebuilds (src/graph/rebuild.ts) instead of lagging up
// to 24h behind. rebuild.ts remains the reference for edge SHAPE and provenance conventions --
// every helper below returns the exact same GraphEdgeRow a rebuild pass would derive for the same
// source row. Tests import rebuild.ts's own builders (buildNoteEdges, buildSupersedesEdges) and
// compare byte-for-byte against these helpers' output, because a live writer and a rebuild pass
// disagreeing about one row's shape is a silent, permanent split-brain -- INSERT OR IGNORE means
// whichever writes first wins, so "byte-identical or don't write it" is the only safe contract.
//
// PROVENANCE LANES (see also migrations/0127_graph_edges.sql header and rebuild.ts):
//   'mechanical' / 'mechanical:broadcast' / 'mechanical:status=<v>' / 'mechanical:dangling'
//       -- REBUILD-OWNED. rebuildGraph's DELETE matches `provenance LIKE 'mechanical%'` and
//          re-derives every row in that lane from source tables. A live writer using one of these
//          provenances is filling a lane the nightly rebuild ALSO fills -- INSERT OR IGNORE means
//          whichever write lands first wins, and if this live write is ever missed or rolled back,
//          the next rebuild silently re-derives the identical row. Safe to lose; never load-bearing.
//   'live'
//       -- WRITE-TIME-ONLY. rebuild.ts's DELETE never matches this (it only matches the
//          'mechanical%' pattern) and rebuild never derives it -- there is no persisted column to
//          derive it from (see edgeForResumedFrom below for why). A 'live' row exists ONLY because
//          a live writer put it there; it is the sole record of that relationship and MUST survive
//          every rebuild untouched. Do not repurpose this lane for anything rebuild could re-derive.
//
// SITES WIRED (verified against source, 2026-08-28):
//   1. inter_companion_notes INSERTs --
//        src/handlers/siblings.ts (postSiblingDisclose's conditional copy into the witnessed lane)
//        src/lib/task-completion.ts (completeTask's per-recipient completion notify)
//        src/librarian/backends/halseth.ts (addCompanionNote, the general companion-note path)
//      -> edgeForNote (sent_to, one per to_id or fanned out per broadcast) + edgeForNoteRef
//         (references, when ref_type/ref_id present). Provenance 'mechanical'/'mechanical:broadcast'
//         (rebuild-owned) -- reuses NOTE_REF_TABLES as the single source of truth for the ref
//         type -> table map, same as rebuild.ts.
//   2. companion_conclusions supersede writes that actually SET superseded_by --
//        src/handlers/conclusions.ts (postConclusion)
//        src/librarian/executors/writes.ts (execConclusionAdd)
//      -> edgeForConclusionSupersede, provenance 'mechanical' (rebuild-owned). src/librarian/
//         executors/session.ts's session-close conclusion fan-out is DELIBERATELY NOT wired: it only
//         ever writes supersede_candidate_id/score, a gate PROPOSAL (mig 0112) -- the older belief
//         stays live, no superseded_by UPDATE ever runs there. Wiring a live edge for that site would
//         fabricate a confirmed 'supersedes' edge for a belief no mind has actually retired.
//   3. Session open with prior_handover_id -- src/mcp/tools/session.ts (halseth_session_open).
//      NEW edge_type 'resumed_from', provenance 'live' (see the lane note above): rebuild.ts's own
//      section (g) documents that there is no persisted column recording which session consumed a
//      handover packet -- the opening session's id is never written anywhere else. This call site is
//      the ONLY writer of this relationship, so it cannot use a rebuild-owned lane.
//      -> edgeForResumedFrom.
//
// SITES DELIBERATELY SKIPPED (Raziel's call, 2026-08-28): relational_deltas, companion_journal,
// companion_tensions. These are among the highest write-volume tables in the system, and the
// nightly rebuild already covers all three; adding a graph write to every one of those inserts
// would trade write-path cost for a same-session graph read nothing currently needs. Revisit only
// if a specific consumer needs same-session graph reads over one of these three.
//
// FAILURE CONTRACT: a graph edge write must NEVER fail the primary write it rides alongside.
//   - Where the call site already batches (env.DB.batch([...])), append these statements to that
//     SAME array via insertEdgeStatements -- atomic with the primary write, never a second,
//     separately-failable batch that could diverge from the primary write's success/failure.
//   - Where the call site does not batch, insert the edge(s) immediately AFTER the primary write's
//     confirmed success (never before), wrapped in try/catch with console.warn on failure.

import { NOTE_REF_TABLES, type NoteRefType } from "../librarian/backends/halseth.js";
import { COMPANION_IDS } from "../companions.js";
import type { GraphEdgeRow } from "./rebuild.js";

export type { GraphEdgeRow };

/**
 * inter_companion_notes -> 'sent_to' edge(s). Mirrors rebuild.ts's buildNoteEdges sent_to half
 * exactly: to_id set -> one edge to that companion; to_id NULL -> fan out to every OTHER
 * companion, provenance 'mechanical:broadcast' so a reader can tell "addressed" from "fanned out"
 * apart from row count alone.
 */
export function edgeForNote(note: {
  id: string;
  from_id: string;
  to_id: string | null;
  created_at: string;
}): GraphEdgeRow[] {
  if (note.to_id) {
    return [
      {
        src_table: "inter_companion_notes",
        src_id: note.id,
        dst_table: "companions",
        dst_id: note.to_id,
        edge_type: "sent_to",
        writer: note.from_id,
        provenance: "mechanical",
        created_at: note.created_at,
      },
    ];
  }
  return COMPANION_IDS.filter((c) => c !== note.from_id).map((c) => ({
    src_table: "inter_companion_notes",
    src_id: note.id,
    dst_table: "companions",
    dst_id: c,
    edge_type: "sent_to",
    writer: note.from_id,
    provenance: "mechanical:broadcast",
    created_at: note.created_at,
  }));
}

/**
 * inter_companion_notes.ref_type/ref_id -> 'references' edge. Reuses NOTE_REF_TABLES (the single
 * source of truth for type -> table mapping, imported from src/librarian/backends/halseth.ts) --
 * exactly the same map rebuild.ts's buildNoteEdges uses, so the two never diverge on where a
 * ref_type points.
 */
export function edgeForNoteRef(note: {
  id: string;
  from_id: string;
  created_at: string;
  ref_type: NoteRefType | null;
  ref_id: string | null;
}): GraphEdgeRow[] {
  if (!note.ref_type || !note.ref_id) return [];
  return [
    {
      src_table: "inter_companion_notes",
      src_id: note.id,
      dst_table: NOTE_REF_TABLES[note.ref_type],
      dst_id: note.ref_id,
      edge_type: "references",
      writer: note.from_id,
      provenance: "mechanical",
      created_at: note.created_at,
    },
  ];
}

/**
 * companion_conclusions.superseded_by -> 'supersedes' edge. Direction matches rebuild.ts's
 * buildSupersedesEdges: replacement --supersedes--> old (src = replacement, dst = old).
 * created_at is the REPLACEMENT's created_at (when the supersede actually happened), never the
 * old row's own created_at -- see rebuild.ts's section (a) for the full reasoning.
 *
 * Only call this where the write ACTUALLY sets superseded_by (a caller-declared `supersedes`,
 * never a gate proposal recorded via supersede_candidate_id/score).
 */
export function edgeForConclusionSupersede(args: {
  replacementId: string;
  oldId: string;
  writer: string;
  createdAt: string;
}): GraphEdgeRow {
  return {
    src_table: "companion_conclusions",
    src_id: args.replacementId,
    dst_table: "companion_conclusions",
    dst_id: args.oldId,
    edge_type: "supersedes",
    writer: args.writer,
    provenance: "mechanical",
    created_at: args.createdAt,
  };
}

/**
 * sessions.prior_handover_id -> 'resumed_from' edge, written at session OPEN
 * (src/mcp/tools/session.ts). Provenance 'live' -- see this file's header: rebuild.ts cannot
 * derive this edge (no persisted column records which session consumed a handover packet), so
 * this call site is the only writer and the row must survive every rebuild untouched.
 */
export function edgeForResumedFrom(args: {
  sessionId: string;
  priorHandoverId: string;
  writer: string | null;
  createdAt: string;
}): GraphEdgeRow {
  return {
    src_table: "sessions",
    src_id: args.sessionId,
    dst_table: "handover_packets",
    dst_id: args.priorHandoverId,
    edge_type: "resumed_from",
    writer: args.writer ?? "system",
    provenance: "live",
    created_at: args.createdAt,
  };
}

/**
 * Turns a batch of GraphEdgeRow into D1PreparedStatements for the caller to append to an
 * EXISTING env.DB.batch() array -- never a second, separately-failable batch. INSERT OR IGNORE:
 * identity is the UNIQUE(src_table, src_id, dst_table, dst_id, edge_type) constraint (migrations/
 * 0127_graph_edges.sql), so re-running a batch that already landed these rows is a no-op, not a
 * duplicate or an error.
 */
export function insertEdgeStatements(db: D1Database, edges: GraphEdgeRow[]): D1PreparedStatement[] {
  return edges.map((e) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO graph_edges
           (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.src_table, e.src_id, e.dst_table, e.dst_id, e.edge_type, e.writer, e.provenance, e.created_at),
  );
}

/**
 * Best-effort edge write for call sites that do NOT batch their primary write. Runs each edge
 * insert sequentially via .run() (not .batch(), so this works against the lighter test doubles
 * that only implement prepare().bind().run()) and swallows any failure -- a graph edge write must
 * never surface as, or cause, a failure of the primary write it rides alongside.
 */
export async function writeEdgesBestEffort(db: D1Database, edges: GraphEdgeRow[]): Promise<void> {
  if (edges.length === 0) return;
  try {
    for (const stmt of insertEdgeStatements(db, edges)) {
      await stmt.run();
    }
  } catch (err) {
    console.warn("[graph/live] best-effort edge write failed (primary write unaffected):", String(err));
  }
}
