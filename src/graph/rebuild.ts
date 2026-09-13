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
//
// TWO PROVENANCE LANES, one table (src/graph/live.ts carries the live-write half of this split):
//   'mechanical%' -- REBUILD-OWNED. Every lane this file derives. The DELETE below matches this
//       pattern and this file is the only place that lane is ever regenerated from scratch.
//   'live' -- WRITE-TIME-ONLY. Lanes with no persisted source column to derive from (currently:
//       'resumed_from', written at session open in src/mcp/tools/session.ts). This file's DELETE
//       does NOT match 'live' and this file NEVER derives it -- a 'live' row is written once, by
//       exactly one call site, and must survive every rebuild untouched.

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

export function buildSupersedesEdges(rows: ConclusionRow[]): GraphEdgeRow[] {
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
  note_text: string | null;
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

export function buildNoteEdges(rows: InterCompanionNoteRow[]): GraphEdgeRow[] {
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
// A genuinely different relationship lives at src/mcp/tools/session.ts -- when a session opens
// with `prior_handover_id`, that packet is marked `returned = 1` but the OPENING session's id is
// never written anywhere else. This file cannot derive it (no persisted column to read it from),
// so it is written LIVE at that exact call site (src/graph/live.ts::edgeForResumedFrom, appended
// to the same env.DB.batch() as the existing UPDATE), provenance 'live' -- NOT 'mechanical', so
// this file's DELETE never touches it and this file never tries to re-derive it. See this file's
// top-of-file "TWO PROVENANCE LANES" note.

// ── h. companion_journal.note_text ~ shelf title -> 'mentions' ────────────────────────────────────
// The graph's first content-derived edge, and deliberately mechanical (zero LLM): the Phase 1.5
// neighborhood traversal has never rendered a non-empty result because no edge connected a journal
// row to the thing it was actually about. A title match is a coarse signal on purpose -- structure,
// not salience (mig 0127's own header) -- and the whole point is a graph line that reads "-> Fargo"
// instead of an opaque row id.
//
// Title source is two shelves: `watch_shelf` (every row -- a finished/paused show is still something
// a journal entry can be about) and `obsession_shelf` restricted to `status = 'active'` (the caller
// filters before this function ever sees the rows, so this function has no status branch of its
// own). Titles under 4 characters or that are exactly one common English word are excluded --
// short/common strings match constantly and produce noise edges pointing at nothing meaningful.
//
// MATCH RULE: case-insensitive, word-bounded substring of the title inside note_text. Word-bounded
// means the character immediately before and after the match (if any) is neither a letter nor a
// digit -- "Fargo" matches "watched Fargo tonight" but not "Fargoish" or "Fargon". Title regex
// metacharacters are escaped before compiling; a title that itself contains something like "(" is
// still matched as a literal string, never as a pattern.
//
// DETERMINISM: both inputs arrive pre-sorted from the caller (journal rows by id, titles by
// (table, id)) rather than trusting `SELECT *` row order, which SQLite makes no ordering guarantee
// about absent an explicit ORDER BY. The nested-loop order below (journal outer, titles inner) is
// what makes two rebuilds against unchanged data byte-identical in edge order, not just edge count.
const MENTIONS_STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "what", "when",
  "home", "life", "love", "time", "work", "night", "day",
]);
const MENTIONS_MIN_TITLE_LEN = 4;

export interface CompanionJournalMentionRow {
  id: string;
  agent: string;
  note_text: string | null;
  created_at: string;
}

export interface ShelfTitleRow {
  table: "watch_shelf" | "obsession_shelf";
  id: string;
  title: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A title is skippable noise if it is too short, or reduces (trimmed, lowercased) to exactly one
 *  common English word -- both match constantly and would flood the graph with meaningless edges. */
function isSkippableTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < MENTIONS_MIN_TITLE_LEN) return true;
  return MENTIONS_STOPWORDS.has(t.toLowerCase());
}

export function buildMentionsEdges(
  journalRows: CompanionJournalMentionRow[],
  titleRows: ShelfTitleRow[],
): GraphEdgeRow[] {
  const titles = titleRows
    .filter((t) => !isSkippableTitle(t.title))
    .slice()
    .sort((a, b) => (a.table === b.table ? a.id.localeCompare(b.id) : a.table.localeCompare(b.table)));
  // Cache one compiled pattern per title -- a nested loop over (journal x titles) would otherwise
  // recompile the same RegExp once per journal row.
  const patterns = titles.map((t) => ({ ref: t, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t.title)}(?![\\p{L}\\p{N}])`, "iu") }));

  const edges: GraphEdgeRow[] = [];
  const sortedJournal = journalRows.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (const j of sortedJournal) {
    if (!j.note_text) continue;
    for (const { ref, re } of patterns) {
      if (!re.test(j.note_text)) continue;
      edges.push({
        src_table: "companion_journal",
        src_id: j.id,
        dst_table: ref.table,
        dst_id: ref.id,
        edge_type: "mentions",
        writer: j.agent,
        provenance: "mechanical:title",
        created_at: j.created_at,
      });
    }
  }
  return edges;
}

// ── i. companion_soma_events -> 'moved_by' / 'follows' / 'logged_in' / 'alongside' ────────────────
// Graph memory Phase 2, tranche 1 (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md).
// mig 0130's `companion_soma_events` is the first append-only record of WHY a felt float moved --
// before it, "heat 0.68, apparently" was literally true, because no writer logged a before/after or
// its own identity. This source turns each of those events into its structural surroundings:
//
//   moved_by   -> the detail row that caused it (handover packet, ferment event, drift shift). Emitted
//                 ONLY when cause_table AND cause_id are both present: a bare authored_update has
//                 neither yet (tranche 2 candidate), and an edge with a null dst is garbage, not a gap.
//   follows    -> the previous event for the SAME (companion, float). writer 'system' -- the chain is
//                 derived by this file, not asserted by whoever wrote either endpoint (the plan's one
//                 stated exception to "writer = event.writer").
//   logged_in  -> sessions, with the same dangling-session marking as (b)/(c) above. Same covenant:
//                 mark, don't drop -- a derived link may be down-ranked, never silently removed.
//   alongside  -> what else the companion was doing when the number moved. Two candidate lanes,
//                 distinguished by provenance, NOT by cap: companion_journal rows in the SAME session
//                 written at or before the event ('mechanical:session'), and commons_posts by this
//                 companion or raziel inside the 60 minutes ending at the event
//                 ('mechanical:window', both ends inclusive). The two lanes are MERGED, sorted
//                 newest-first, and capped at 6 TOTAL -- capping each lane separately would quietly
//                 allow 12 and make a chatty commons hour drown the session context.
//
// TIME IS PARSED, NOT STRING-COMPARED. `created_at` arrives in two shapes in this schema: SQLite
// `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" (commons_posts, most legacy rows) while JS writers
// hand back a full ISO instant. A raw string sort across both is deterministic but WRONG -- 'T' sorts
// after ' ', so every ISO row lands after every space-formatted row regardless of when it happened.
// One helper (`tsMs`, the same normalisation webmind/drives.ts::hoursSinceIso uses) does both jobs:
// the determinism sort key and every window/<= comparison.
const ALONGSIDE_WINDOW_MS = 60 * 60 * 1000;
const ALONGSIDE_CAP = 6;

export interface SomaEventGraphRow {
  id: string;
  companion_id: string;
  float_key: string;
  kind: string;
  writer: string;
  cause_table: string | null;
  cause_id: string | null;
  session_id: string | null;
  created_at: string;
}

export interface CommonsPostGraphRow {
  id: string;
  author: string;
  created_at: string;
}

/** Normalise both `created_at` shapes this schema carries to a comparable instant. NaN-safe: an
 *  unparseable stamp sorts as 0 rather than poisoning every comparison it touches. */
function tsMs(s: string | null | undefined): number {
  if (!s) return 0;
  const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? 0 : ms;
}

function byTimeThenId<T extends { id: string; created_at: string }>(a: T, b: T): number {
  const d = tsMs(a.created_at) - tsMs(b.created_at);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

export function buildSomaEventEdges(
  events: readonly SomaEventGraphRow[],
  sessionIds: Set<string>,
  journalRows: readonly CompanionJournalRow[],
  commonsRows: readonly CommonsPostGraphRow[],
): GraphEdgeRow[] {
  // Sorted inputs before the nested loops -- SQLite guarantees no row order absent an ORDER BY, and
  // this file's contract is that two rebuilds over unchanged data agree on edge ORDER, not just count.
  const sortedEvents = events.slice().sort(byTimeThenId);
  const sortedJournal = journalRows.slice().sort(byTimeThenId);
  const sortedCommons = commonsRows.slice().sort(byTimeThenId);

  const edges: GraphEdgeRow[] = [];
  const prevByFloat = new Map<string, SomaEventGraphRow>();

  for (const e of sortedEvents) {
    const at = tsMs(e.created_at);

    if (e.cause_table && e.cause_id) {
      edges.push({
        src_table: "companion_soma_events",
        src_id: e.id,
        dst_table: e.cause_table,
        dst_id: e.cause_id,
        edge_type: "moved_by",
        writer: e.writer,
        provenance: "mechanical",
        created_at: e.created_at,
      });
    }

    const chainKey = `${e.companion_id}|${e.float_key}`;
    const prev = prevByFloat.get(chainKey);
    if (prev) {
      edges.push({
        src_table: "companion_soma_events",
        src_id: e.id,
        dst_table: "companion_soma_events",
        dst_id: prev.id,
        edge_type: "follows",
        // The chain is DERIVED here; neither endpoint's writer asserted it.
        writer: "system",
        provenance: "mechanical",
        created_at: e.created_at,
      });
    }
    prevByFloat.set(chainKey, e);

    if (e.session_id) {
      edges.push({
        src_table: "companion_soma_events",
        src_id: e.id,
        dst_table: "sessions",
        dst_id: e.session_id,
        edge_type: "logged_in",
        writer: e.writer,
        provenance: sessionIds.has(e.session_id) ? "mechanical" : "mechanical:dangling",
        created_at: e.created_at,
      });
    }

    const alongside: Array<{ table: string; id: string; created_at: string; provenance: string }> = [];
    if (e.session_id) {
      for (const j of sortedJournal) {
        if (j.session_id !== e.session_id) continue;
        if (j.agent !== e.companion_id) continue;
        if (tsMs(j.created_at) > at) continue;
        alongside.push({ table: "companion_journal", id: j.id, created_at: j.created_at, provenance: "mechanical:session" });
      }
    }
    for (const c of sortedCommons) {
      if (c.author !== e.companion_id && c.author !== "raziel") continue;
      const cAt = tsMs(c.created_at);
      if (cAt > at || cAt < at - ALONGSIDE_WINDOW_MS) continue;
      alongside.push({ table: "commons_posts", id: c.id, created_at: c.created_at, provenance: "mechanical:window" });
    }
    alongside.sort((a, b) => {
      const d = tsMs(b.created_at) - tsMs(a.created_at);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
    for (const a of alongside.slice(0, ALONGSIDE_CAP)) {
      edges.push({
        src_table: "companion_soma_events",
        src_id: e.id,
        dst_table: a.table,
        dst_id: a.id,
        edge_type: "alongside",
        writer: e.writer,
        provenance: a.provenance,
        created_at: e.created_at,
      });
    }
  }

  return edges;
}

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

  const [conclusions, deltas, journal, notes, tensions, handovers, sessions, watchTitles, obsessionTitles, somaEvents, commonsPosts] = await Promise.all([
    selectAll<ConclusionRow>(db, "companion_conclusions"),
    selectAll<RelationalDeltaRow>(db, "relational_deltas"),
    selectAll<CompanionJournalRow>(db, "companion_journal"),
    selectAll<InterCompanionNoteRow>(db, "inter_companion_notes"),
    selectAll<CompanionTensionRow>(db, "companion_tensions"),
    selectAll<HandoverPacketRow>(db, "handover_packets"),
    selectAll<{ id: string }>(db, "sessions"),
    selectAll<{ id: string; title: string }>(db, "watch_shelf"),
    selectAll<{ id: string; title: string; status: string }>(db, "obsession_shelf"),
    selectAll<SomaEventGraphRow>(db, "companion_soma_events"),
    selectAll<CommonsPostGraphRow>(db, "commons_posts"),
  ]);
  const shelfTitles: ShelfTitleRow[] = [
    ...watchTitles.map((r) => ({ table: "watch_shelf" as const, id: r.id, title: r.title })),
    // Whole-table read (this file's convention: correlate in JS, not in SQL) filtered here to
    // status = 'active' -- a retired obsession is still a real row, just not a live title source.
    ...obsessionTitles.filter((r) => r.status === "active").map((r) => ({ table: "obsession_shelf" as const, id: r.id, title: r.title })),
  ];
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
    { source: "companion_journal.note_text~title", edges: buildMentionsEdges(journal, shelfTitles) },
    // Source (i) is ONE builder reported as FOUR source rows. The builder has to walk the events once
    // (the `follows` chain and the merged alongside cap are both per-event state), but a single
    // "companion_soma_events: 412" count would be illegible -- four families with very different
    // expected magnitudes collapsed into one number is how a dead family hides behind a live one.
    // Partitioning by edge_type preserves the builder's emission order, so determinism is unaffected.
    ...(() => {
      const all = buildSomaEventEdges(somaEvents, sessionIds, journal, commonsPosts);
      const of = (t: string) => all.filter((e) => e.edge_type === t);
      return [
        { source: "companion_soma_events.cause", edges: of("moved_by") },
        { source: "companion_soma_events.follows", edges: of("follows") },
        { source: "companion_soma_events.session", edges: of("logged_in") },
        { source: "companion_soma_events.alongside", edges: of("alongside") },
      ];
    })(),
  ];

  const counts: SourceCount[] = [];
  for (const s of sources) {
    const inserted = await insertEdges(db, s.edges);
    counts.push({ source: s.source, inserted });
  }
  return counts;
}
