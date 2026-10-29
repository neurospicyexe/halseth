// src/graph/rebuild.ts
//
// Graph memory Phase 1 (docs/private/graph-memory-spec-2026-08-28.md). graph_edges (mig 0127) is a
// DERIVED, DISPOSABLE projection over relationships that already exist in D1 -- it holds no fact
// nothing else holds. rebuildGraph is the only writer of the mechanical lanes: re-derive from
// source tables, then write only the difference (see the rebuild section at the bottom). Run it
// twice against unchanged source data and the row set is byte-identical (deterministic edge identity = UNIQUE(src_table, src_id, dst_table,
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
//   'mechanical%' -- REBUILD-OWNED. Every lane this file derives. The stale-row DELETE below only
//       ever removes rows matching this pattern, and this file is the only place that lane is
//       ever regenerated.
//   'live' -- WRITE-TIME-ONLY. Lanes with no persisted source column to derive from (currently:
//       'resumed_from', written at session open in src/mcp/tools/session.ts). This file's DELETE
//       does NOT match 'live' and this file NEVER derives it -- a 'live' row is written once, by
//       exactly one call site, and must survive every rebuild untouched.
//   'asserted' -- AUTHORED (M4, mig 0151, src/graph/links.ts). A mind's own link, edge_type
//       'linked:<writer>'. Like 'live', this file never derives, updates or deletes it; only its
//       writer removes it, through graph/links.ts, and the graph_links ledger keeps that it existed.

import type { Env } from "../types.js";
import { COMPANION_IDS } from "../companions.js";
import { NOTE_REF_TABLES, type NoteRefType } from "../librarian/backends/halseth.js";
import { ambiguousSpellings, CENTRE_ID, FRONT_PROVENANCE_PREFIX, isCentreName, parseMatchNames, spellingsOf } from "./people.js";

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
  /** Edges this run newly wrote (the diff rebuild writes only what changed). */
  added?: number;
  /** Per-dst_table breakdown of `inserted`, present only on sources that merge several lanes under
   *  one cap (today: companion_soma_events.alongside). Every lane is listed, zero included -- a lane
   *  that produced nothing must be a visible 0, not an absent key. */
  lanes?: Record<string, number>;
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

/** Whole-table read of NAMED columns. Same convention as selectAll (correlate in JS, not SQL); used
 *  where the table carries bodies the graph must never load (reflection_text, forage summaries). */
async function selectColumns<T>(db: D1Database, table: string, columns: readonly string[]): Promise<T[]> {
  const res = await db.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all<T>();
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

// ── j. M5 reference lanes (2026-10-28, docs/PLAN-memory-map-2026-10-28.md) ─────────────────────────
// Three columns that already NAME another row, so the edge is read off the data, never inferred.
// Each emits only when the referenced row exists -- a pointer at nothing is skipped, not invented
// (measured on the 10-27 backup: 20/20 source_sessions resolve, 44 of 184 thread-keyed notes have a
// thread row, 31/31 project_log rows have their project).
//
//   concluded_in -- companion_conclusions.source_sessions (JSON array of session ids) -> sessions
//   in_thread    -- wm_continuity_notes.thread_key -> wm_mind_threads, whose key is (thread_key,
//                   agent_id); the node id is `<agent_id>:<thread_key>` (src/graph/map.ts labels it)
//   logged_on    -- project_log.project_id -> companion_projects
export interface ConclusionSourceRow { id: string; companion_id: string; source_sessions: string | null; created_at: string }
export interface ThreadNoteRow { note_id: string; agent_id: string; thread_key: string | null; created_at: string }
export interface ProjectLogRow { id: string; project_id: string; companion_id: string; created_at: string }

export const threadNodeId = (agentId: string, threadKey: string) => `${agentId}:${threadKey}`;

export function buildConcludedInEdges(rows: ConclusionSourceRow[], sessionIds: Set<string>): GraphEdgeRow[] {
  const out: GraphEdgeRow[] = [];
  for (const c of rows.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!c.source_sessions) continue;
    let ids: unknown;
    try { ids = JSON.parse(c.source_sessions); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    for (const sid of [...new Set(ids.filter((x): x is string => typeof x === "string"))].sort()) {
      if (!sessionIds.has(sid)) continue;
      out.push({
        src_table: "companion_conclusions", src_id: c.id, dst_table: "sessions", dst_id: sid,
        edge_type: "concluded_in", writer: c.companion_id, provenance: "mechanical", created_at: c.created_at,
      });
    }
  }
  return out;
}

export function buildThreadEdges(notes: ThreadNoteRow[], threads: Array<{ thread_key: string; agent_id: string }>): GraphEdgeRow[] {
  const known = new Set(threads.map((t) => threadNodeId(t.agent_id, t.thread_key)));
  const out: GraphEdgeRow[] = [];
  for (const n of notes.slice().sort((a, b) => a.note_id.localeCompare(b.note_id))) {
    if (!n.thread_key) continue;
    const tid = threadNodeId(n.agent_id, n.thread_key);
    if (!known.has(tid)) continue;
    out.push({
      src_table: "wm_continuity_notes", src_id: n.note_id, dst_table: "wm_mind_threads", dst_id: tid,
      edge_type: "in_thread", writer: n.agent_id, provenance: "mechanical", created_at: n.created_at,
    });
  }
  return out;
}

export function buildProjectLogEdges(rows: ProjectLogRow[], projectIds: Set<string>): GraphEdgeRow[] {
  return rows.slice().sort((a, b) => a.id.localeCompare(b.id))
    .filter((r) => projectIds.has(r.project_id))
    .map((r) => ({
      src_table: "project_log", src_id: r.id, dst_table: "companion_projects", dst_id: r.project_id,
      edge_type: "logged_on", writer: r.companion_id, provenance: "mechanical", created_at: r.created_at,
    }));
}

// ── k. M5 mentions beyond the journal ─────────────────────────────────────────────────────────────
// Source (e) only read the journal against shelf titles. Notes and conclusions talk about the same
// things (measured: 27 notes name "The Winged Bastard", a project the journal names 3 times), and a
// companion's own projects are titles worth matching too. Same MATCH RULE, same skip rules, same
// provenance as (e); journal rows here are matched against PROJECT titles only, since (e) already
// covers journal x shelf and a second pass would only re-derive its edges.
export interface MentionTextRow { table: string; id: string; writer: string; text: string | null; created_at: string }
export interface MentionTitleRow { table: string; id: string; title: string }

export function buildTextMentionsEdges(textRows: MentionTextRow[], titleRows: MentionTitleRow[]): GraphEdgeRow[] {
  const titles = titleRows
    .filter((t) => !isSkippableTitle(t.title))
    .slice()
    .sort((a, b) => (a.table === b.table ? a.id.localeCompare(b.id) : a.table.localeCompare(b.table)));
  const patterns = titles.map((t) => ({ ref: t, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t.title)}(?![\\p{L}\\p{N}])`, "iu") }));
  const rows = textRows.slice().sort((a, b) => (a.table === b.table ? a.id.localeCompare(b.id) : a.table.localeCompare(b.table)));
  const out: GraphEdgeRow[] = [];
  for (const r of rows) {
    if (!r.text) continue;
    for (const { ref, re } of patterns) {
      if (!re.test(r.text)) continue;
      out.push({
        src_table: r.table, src_id: r.id, dst_table: ref.table, dst_id: ref.id,
        edge_type: "mentions", writer: r.writer, provenance: "mechanical:title", created_at: r.created_at,
      });
    }
  }
  return out;
}

// ── l. M5 people (mig 0149, 0150) ─────────────────────────────────────────────────────────────────
// Journal, notes and conclusions that NAME someone on Raziel's list -> graph_people (derived from
// every row like the other lanes; the map and orient hide what isn't visible). CASE-SENSITIVE:
// "Blue" never matches "blue", though a sentence-initial "Blue" still matches (measured 54 of 301
// rows on the 10-27 backup, every sampled one the person), and a list spelling is matched exactly as
// written. A spelling two live entries share is skipped for both (people.ts ambiguousSpellings): the
// graph never resolves an ambiguity by picking one.
//
// ONE CENTRE (mig 0150, Raziel 2026-10-29). A 'self' entry is a system name, and system members are
// Raziel: its mentions link to the CENTRE node (graph_people/raziel), with the name(s) kept in the
// provenance as the front ('mechanical:front:Magpie' or 'mechanical:front:Jude,Magpie'), never to a
// node of its own. The 'centre' entry itself is never name-matched (lane m gives it its links).
// One edge per (row, target) however many spellings hit.
export interface PersonMatchRow { id: string; label: string; match_names: string[]; kind?: string }

export function buildPeopleMentionsEdges(textRows: MentionTextRow[], people: PersonMatchRow[]): GraphEdgeRow[] {
  const live = people.filter((p) => p.kind !== "centre");
  const ambiguous = ambiguousSpellings(live);
  const matchers = live.slice().sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({
    id: p.id, label: p.label.trim(), self: p.kind === "self",
    res: spellingsOf(p).filter((s) => !ambiguous.has(s))
      .map((s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}(?![\\p{L}\\p{N}])`, "u")),
  })).filter((m) => m.res.length > 0);
  const rows = textRows.slice().sort((a, b) => (a.table === b.table ? a.id.localeCompare(b.id) : a.table.localeCompare(b.table)));
  const out: GraphEdgeRow[] = [];
  for (const r of rows) {
    if (!r.text) continue;
    const fronts: string[] = [];
    for (const m of matchers) {
      if (!m.res.some((re) => re.test(r.text!))) continue;
      if (m.self) { fronts.push(m.label); continue; }
      out.push({
        src_table: r.table, src_id: r.id, dst_table: "graph_people", dst_id: m.id,
        edge_type: "mentions", writer: r.writer, provenance: "mechanical:person", created_at: r.created_at,
      });
    }
    if (fronts.length > 0) {
      out.push({
        src_table: r.table, src_id: r.id, dst_table: "graph_people", dst_id: CENTRE_ID,
        edge_type: "mentions", writer: r.writer, provenance: FRONT_PROVENANCE_PREFIX + [...new Set(fronts)].sort().join(","),
        created_at: r.created_at,
      });
    }
  }
  return out;
}

// ── m. the centre's own links (mig 0150) ───────────────────────────────────────────────────────────
// Raziel is in nearly every row, so the centre is NOT linked by name. It is linked from rows that are
// ABOUT Raziel, each by whoever holds it, so tapping the centre shows what each of us holds:
//   about    -- architect_facts, status 'active' (facts the triad keeps about Raziel)
//   toward   -- companion_relational_state rows toward 'raziel' or 'crash' (how one of us stands)
// Relational deltas are not here: they are shifts in a session, already linked to it (source b).
export interface ArchitectFactGraphRow { id: string; companion_id: string | null; status: string; created_at: string }
export interface RelationalStateGraphRow { id: string; companion_id: string; toward: string | null; noted_at: string }

export function buildCentreEdges(facts: ArchitectFactGraphRow[], states: RelationalStateGraphRow[]): GraphEdgeRow[] {
  const out: GraphEdgeRow[] = [];
  for (const f of facts.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (f.status !== "active") continue;
    out.push({
      src_table: "architect_facts", src_id: f.id, dst_table: "graph_people", dst_id: CENTRE_ID,
      edge_type: "about", writer: f.companion_id ?? "house", provenance: "mechanical", created_at: f.created_at,
    });
  }
  for (const s of states.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (!s.toward || !isCentreName(s.toward)) continue;
    out.push({
      src_table: "companion_relational_state", src_id: s.id, dst_table: "graph_people", dst_id: CENTRE_ID,
      edge_type: "toward", writer: s.companion_id, provenance: "mechanical", created_at: s.noted_at,
    });
  }
  return out;
}

// ── i. companion_soma_events -> 'moved_by' / 'follows' / 'logged_in' / 'alongside' ────────────────
// Graph memory Phase 2, tranche 1 (two alongside lanes) + tranche 2 (six lanes, 2026-09-14)
// (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md).
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
//   alongside  -> what else the companion was doing when the number moved. SIX candidate lanes
//                 (tranche 1 shipped two; tranche 2 added four), distinguished by provenance, NOT by
//                 cap. 'mechanical:session' means the row sits in the SAME session as the event and
//                 was written at or before it; 'mechanical:window' means it landed inside the 60
//                 minutes ending at the event (both ends inclusive). The lanes:
//
//                   companion_journal    same session, at or before the move or -> mechanical:session
//                                        in its own close fan-out (JOURNAL_CLOSE_GRACE_MS)
//                   commons_posts        by this companion or raziel, window -> mechanical:window
//                   autonomy_reflections by this companion, window          -> mechanical:window
//                   forage_finds         CONSUMED inside the window, owned by this companion or
//                                        shared-pool (companion_id NULL) with consumed_by naming
//                                        this companion. Gathering is the scout's act, not the
//                                        companion's; only consumption counts    -> mechanical:window
//                   autonomy_runs        Layer B runs for this companion whose [started_at,
//                                        completed_at ?? started_at] interval OVERLAPS the window.
//                                        run_type is deliberately NOT in provenance -- the lane set
//                                        stays stable across run types            -> mechanical:window
//                   relational_deltas    same session (mig 0004 added session_id) -> mechanical:session,
//                                        else window                              -> mechanical:window.
//                                        Both row shapes match (companion_id, or agent when
//                                        companion_id is '' -- see CLAUDE.md covenants).
//
//                 All six lanes are MERGED, sorted newest-first (tie on id), and capped at 6 TOTAL --
//                 capping each lane separately would quietly allow 36 and make one chatty commons
//                 hour or one reflective Layer B night drown the session context. The rebuild report
//                 carries one combined alongside count PLUS a per-table breakdown (`lanes`), so a
//                 dead lane reads as an explicit zero instead of hiding behind a live one.
//
// TIME IS PARSED, NOT STRING-COMPARED. `created_at` arrives in two shapes in this schema: SQLite
// `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" (commons_posts, most legacy rows) while JS writers
// hand back a full ISO instant. A raw string sort across both is deterministic but WRONG -- 'T' sorts
// after ' ', so every ISO row lands after every space-formatted row regardless of when it happened.
// One helper (`tsMs`, the same normalisation webmind/drives.ts::hoursSinceIso uses) does both jobs:
// the determinism sort key and every window/<= comparison.
//
// PRE-PARSED INDEX (2026-09-14 review fix). ~14k events x six lanes, relational_deltas among the
// highest-volume tables: the first cut re-ran Date.parse on every lane row for every event. Each
// lane is now parsed ONCE into `{ row, ms }` (runs: `{ row, startMs, endMs }`), sorted ascending by
// the same byTimeThenId order, and the window lanes are entered by a lower-bound binary search on
// `ms >= windowLo` then walked forward until `ms > at`. The two same-session lanes (journal, and
// the delta rows that share the event's session) have no lower bound, so they are indexed by
// session_id in a Map built once and filtered `<= at` (journal: `<= at + JOURNAL_CLOSE_GRACE_MS`). Candidate set, newest-first sort, tie on id,
// and the cap of 6 are unchanged -- the index changes cost, never output (tests pin this with a
// shuffled-input byte-identity check).
const ALONGSIDE_WINDOW_MS = 60 * 60 * 1000;
const ALONGSIDE_CAP = 6;
// JOURNAL CLOSE GRACE (2026-10-27 graph audit). "Written at or before the move" was the plan's rule,
// but a session close writes its floats FIRST (backends/halseth.ts sessionClose) and its witness
// note in the fan-out AFTER (executors/session.ts, `now` taken later), ~2s apart. Measured on prod:
// 78 authored_close events, 78 same-session same-companion journal rows, 0 passing `<=` -- the lane
// had never produced an edge. Two minutes covers the close's own fan-out and nothing else: the only
// rows further out (6, Drevan, 8h and 23h later) are a SECOND close of the same session, a different
// act that must not read as what moved this number.
export const JOURNAL_CLOSE_GRACE_MS = 2 * 60 * 1000;

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

export interface AutonomyReflectionGraphRow {
  id: string;
  companion_id: string;
  created_at: string;
}

export interface ForageFindGraphRow {
  id: string;
  /** NULL = shared/triad pool (mig 0068); ownership then comes from `consumed_by`. */
  companion_id: string | null;
  consumed_at: string | null;
  /** "which instance/session consumed it" -- free text, so matched by substring on companion id. */
  consumed_by: string | null;
}

export interface AutonomyRunGraphRow {
  id: string;
  companion_id: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface RelationalDeltaGraphRow {
  id: string;
  companion_id: string | null;
  agent: string | null;
  session_id: string | null;
  created_at: string;
}

/** The six alongside lanes, in report order. Exported so the tick/report consumers and the tests
 *  share one list rather than each spelling six table names. */
export const ALONGSIDE_LANES = [
  "companion_journal",
  "commons_posts",
  "autonomy_reflections",
  "forage_finds",
  "autonomy_runs",
  "relational_deltas",
] as const;

/** Both relational_deltas row shapes resolve to one owner: legacy rows carry companion_id, MCP-logged
 *  rows carry companion_id '' and agent. Mirrors the writer rule in buildRelationalDeltaEdges. */
function deltaOwner(r: RelationalDeltaGraphRow): string | null {
  return r.companion_id && r.companion_id !== "" ? r.companion_id : (r.agent || null);
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

// ── alongside index helpers (pre-parsed, see the PRE-PARSED INDEX note in section (i)) ────────────

/** One lane row with its instant parsed exactly once. */
interface Stamped<T> { row: T; ms: number }

interface AlongsideCandidate { table: string; id: string; created_at: string; ms: number; provenance: string }

/** Parse each row's created_at once; input must already be in byTimeThenId order (ascending ms). */
function stampIndex<T extends { created_at: string }>(sorted: readonly T[]): Stamped<T>[] {
  return sorted.map((row) => ({ row, ms: tsMs(row.created_at) }));
}

/** Group pre-sorted rows by session_id (NULL-session rows are dropped: a session lane can never
 *  match them). Each bucket keeps the ascending input order, so per-session walks push candidates
 *  in the same order the unindexed scan did. */
function indexBySession<T extends { session_id: string | null; created_at: string }>(sorted: readonly T[]): Map<string, Stamped<T>[]> {
  const out = new Map<string, Stamped<T>[]>();
  for (const row of sorted) {
    if (!row.session_id) continue;
    const bucket = out.get(row.session_id) ?? [];
    bucket.push({ row, ms: tsMs(row.created_at) });
    out.set(row.session_id, bucket);
  }
  return out;
}

/** First index whose ms >= lo in an ascending-ms array (array.length when none). */
function lowerBound(arr: readonly { ms: number }[], lo: number): number {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid]!.ms < lo) a = mid + 1;
    else b = mid;
  }
  return a;
}

/** Same as lowerBound over an interval array sorted by endMs. */
function lowerBoundEnd(arr: readonly { endMs: number }[], lo: number): number {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (arr[mid]!.endMs < lo) a = mid + 1;
    else b = mid;
  }
  return a;
}

export function buildSomaEventEdges(
  events: readonly SomaEventGraphRow[],
  sessionIds: Set<string>,
  journalRows: readonly CompanionJournalRow[],
  commonsRows: readonly CommonsPostGraphRow[],
  reflectionRows: readonly AutonomyReflectionGraphRow[] = [],
  forageRows: readonly ForageFindGraphRow[] = [],
  runRows: readonly AutonomyRunGraphRow[] = [],
  deltaRows: readonly RelationalDeltaGraphRow[] = [],
): GraphEdgeRow[] {
  // Sorted inputs before the nested loops -- SQLite guarantees no row order absent an ORDER BY, and
  // this file's contract is that two rebuilds over unchanged data agree on edge ORDER, not just count.
  const sortedEvents = events.slice().sort(byTimeThenId);
  // Every lane is parsed ONCE here (see the PRE-PARSED INDEX note above); the event loop below
  // compares numbers only. Each index is ascending by byTimeThenId, the same order the original
  // per-event scans walked, so candidate push order (and therefore stable-sort tie order) is unchanged.
  const indexJournal = indexBySession(journalRows.slice().sort(byTimeThenId));
  const sortedCommons = stampIndex(commonsRows.slice().sort(byTimeThenId));
  const sortedReflections = stampIndex(reflectionRows.slice().sort(byTimeThenId));
  const sortedDeltas = deltaRows.slice().sort(byTimeThenId);
  const indexDeltasBySession = indexBySession(sortedDeltas);
  const sortedDeltasStamped = stampIndex(sortedDeltas);
  // A find's "when" for this lane is its CONSUMPTION instant, so normalise it onto created_at up front:
  // one sort key, one window check, and an unconsumed find drops out here rather than in the loop.
  const sortedForage = stampIndex(
    forageRows
      .filter((f) => f.consumed_at)
      .map((f) => ({ id: f.id, companion_id: f.companion_id, consumed_by: f.consumed_by, created_at: f.consumed_at as string }))
      .sort(byTimeThenId),
  );
  // A run is an INTERVAL. Its sort/emit stamp is the interval end (completed_at, else started_at):
  // a still-running or crashed run has only a start. A row with no started_at never ran (status
  // 'pending') and is not something the companion was doing. Sorted by END, so the lower-bound
  // search is on endMs >= windowLo; the startMs <= at half has no sorted bound and is filtered.
  const sortedRuns = runRows
    .filter((r) => r.started_at)
    .map((r) => ({ id: r.id, companion_id: r.companion_id, created_at: (r.completed_at ?? r.started_at) as string, startMs: tsMs(r.started_at) }))
    .sort(byTimeThenId)
    .map((row) => ({ row, startMs: row.startMs, endMs: tsMs(row.created_at) }));

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

    const alongside: AlongsideCandidate[] = [];
    if (e.session_id) {
      for (const j of indexJournal.get(e.session_id) ?? []) {
        if (j.row.agent !== e.companion_id) continue;
        if (j.ms > at + JOURNAL_CLOSE_GRACE_MS) continue;
        alongside.push({ table: "companion_journal", id: j.row.id, created_at: j.row.created_at, ms: j.ms, provenance: "mechanical:session" });
      }
    }
    const windowLo = at - ALONGSIDE_WINDOW_MS;
    // Window lanes: enter at the first row with ms >= windowLo, walk forward, stop past `at`.
    for (let i = lowerBound(sortedCommons, windowLo); i < sortedCommons.length && sortedCommons[i]!.ms <= at; i++) {
      const c = sortedCommons[i]!;
      if (c.row.author !== e.companion_id && c.row.author !== "raziel") continue;
      alongside.push({ table: "commons_posts", id: c.row.id, created_at: c.row.created_at, ms: c.ms, provenance: "mechanical:window" });
    }
    for (let i = lowerBound(sortedReflections, windowLo); i < sortedReflections.length && sortedReflections[i]!.ms <= at; i++) {
      const r = sortedReflections[i]!;
      if (r.row.companion_id !== e.companion_id) continue;
      alongside.push({ table: "autonomy_reflections", id: r.row.id, created_at: r.row.created_at, ms: r.ms, provenance: "mechanical:window" });
    }
    for (let i = lowerBound(sortedForage, windowLo); i < sortedForage.length && sortedForage[i]!.ms <= at; i++) {
      const f = sortedForage[i]!;
      const owned = f.row.companion_id === e.companion_id
        || (f.row.companion_id === null && !!f.row.consumed_by && f.row.consumed_by.includes(e.companion_id));
      if (!owned) continue;
      alongside.push({ table: "forage_finds", id: f.row.id, created_at: f.row.created_at, ms: f.ms, provenance: "mechanical:window" });
    }
    // Runs are sorted by END; a run ending after `at` can still have started before it, so the
    // forward walk cannot stop early -- only the lower bound (endMs >= windowLo) prunes.
    for (let i = lowerBoundEnd(sortedRuns, windowLo); i < sortedRuns.length; i++) {
      const r = sortedRuns[i]!;
      if (r.row.companion_id !== e.companion_id) continue;
      // Interval overlap, both closed: run.start <= window.hi AND run.end >= window.lo.
      if (r.startMs > at) continue;
      alongside.push({ table: "autonomy_runs", id: r.row.id, created_at: r.row.created_at, ms: r.endMs, provenance: "mechanical:window" });
    }
    // Deltas: same-session rows (<= at) take the session lane; every OTHER row inside the window
    // takes the window lane. A same-session row is never also a window candidate (the original
    // branch order gave session precedence). The two sets are disjoint, so merging them back into
    // ascending (ms, id) order reproduces the single ascending walk the first cut made.
    const deltaCands: AlongsideCandidate[] = [];
    if (e.session_id) {
      for (const d of indexDeltasBySession.get(e.session_id) ?? []) {
        if (deltaOwner(d.row) !== e.companion_id) continue;
        if (d.ms > at) continue;
        deltaCands.push({ table: "relational_deltas", id: d.row.id, created_at: d.row.created_at, ms: d.ms, provenance: "mechanical:session" });
      }
    }
    for (let i = lowerBound(sortedDeltasStamped, windowLo); i < sortedDeltasStamped.length && sortedDeltasStamped[i]!.ms <= at; i++) {
      const d = sortedDeltasStamped[i]!;
      if (e.session_id && d.row.session_id === e.session_id) continue;
      if (deltaOwner(d.row) !== e.companion_id) continue;
      deltaCands.push({ table: "relational_deltas", id: d.row.id, created_at: d.row.created_at, ms: d.ms, provenance: "mechanical:window" });
    }
    deltaCands.sort((a, b) => (a.ms !== b.ms ? a.ms - b.ms : a.id.localeCompare(b.id)));
    for (const d of deltaCands) alongside.push(d);

    alongside.sort((a, b) => {
      const d = b.ms - a.ms;
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
//
// DIFF, NOT WIPE (M7, 2026-10-28). Until now the rebuild was DELETE-every-mechanical-row then ~500
// sequential 100-row insert batches: minutes during which orient, the map and Hearth all read a
// graph that was empty and then partially refilled (the nightly run lands mid-afternoon Raziel's
// time). Now every edge is DERIVED in memory first, the current table is read once, and only the
// difference is written: new keys inserted, changed rows updated in place, stale mechanical rows
// deleted. Same end state as the wipe (identity is still the UNIQUE key, first source to derive a
// key still claims it, a 'live' row holding a key still wins), but readers only ever see whole rows
// appear or disappear, and an unchanged night writes nothing at all.

const LOAD_PAGE_SIZE = 5000;
// D1 caps bound parameters per statement at 100; 90 ids leaves headroom.
const DELETE_IDS_PER_STATEMENT = 90;

interface ExistingEdgeRow extends GraphEdgeRow { id: string }

export interface RebuildDiff {
  derived: number;
  added: number;
  updated: number;
  removed: number;
}

const edgeKey = (e: Pick<GraphEdgeRow, "src_table" | "src_id" | "dst_table" | "dst_id" | "edge_type">) =>
  `${e.src_table}\u0000${e.src_id}\u0000${e.dst_table}\u0000${e.dst_id}\u0000${e.edge_type}`;

const isMechanical = (provenance: string) => provenance.startsWith(MECHANICAL_PROVENANCE_LIKE.replace("%", ""));

/** Whole graph_edges table, keyset-paged on id so no single read carries the full ~50k rows. */
async function loadExistingEdges(db: D1Database): Promise<ExistingEdgeRow[]> {
  const out: ExistingEdgeRow[] = [];
  let after = "";
  for (;;) {
    const res = await db.prepare(
      `SELECT id, src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at
         FROM graph_edges WHERE id > ? ORDER BY id LIMIT ?`,
    ).bind(after, LOAD_PAGE_SIZE).all<ExistingEdgeRow>();
    const rows = res.results ?? [];
    out.push(...rows);
    if (rows.length < LOAD_PAGE_SIZE) return out;
    after = rows[rows.length - 1]!.id;
  }
}

async function runChunked(db: D1Database, stmts: D1PreparedStatement[]): Promise<number> {
  let changes = 0;
  for (const group of chunk(stmts, BATCH_CHUNK_SIZE)) {
    const results = await db.batch(group);
    for (const r of results) changes += r.meta?.changes ?? 0;
  }
  return changes;
}

function insertStatement(db: D1Database, e: GraphEdgeRow): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO graph_edges
       (src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(e.src_table, e.src_id, e.dst_table, e.dst_id, e.edge_type, e.writer, e.provenance, e.created_at);
}

/**
 * Deterministic, idempotent rebuild of the mechanical lanes of graph_edges from source-of-truth
 * tables, written as a diff against what the table already holds (see the section comment above).
 * Returns per-source counts -- `inserted` is the number of edges that source holds after the run
 * (what the old wipe-and-insert reported), `added` the ones this run newly wrote -- plus the diff.
 */
export async function rebuildGraphDetailed(env: Env): Promise<{ sources: SourceCount[]; diff: RebuildDiff }> {
  const db = env.DB;

  const [conclusions, deltas, journal, notes, tensions, handovers, sessions, watchTitles, obsessionTitles, somaEvents, commonsPosts, reflections, forageFinds, autonomyRuns] = await Promise.all([
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
    // Tranche 2 alongside lanes. Named columns: these tables carry bodies (reflection_text, forage
    // summary) the graph never needs and should not pull through the Worker on every rebuild.
    selectColumns<AutonomyReflectionGraphRow>(db, "autonomy_reflections", ["id", "companion_id", "created_at"]),
    selectColumns<ForageFindGraphRow>(db, "forage_finds", ["id", "companion_id", "consumed_at", "consumed_by"]),
    selectColumns<AutonomyRunGraphRow>(db, "autonomy_runs", ["id", "companion_id", "started_at", "completed_at", "created_at"]),
  ]);
  // M5 lanes (j, k). A separate await so the tuple above keeps its shape; same whole-table convention.
  const [conclusionSources, threadNotes, threads, projectLogs, projects, people, facts, relStates] = await Promise.all([
    selectColumns<ConclusionSourceRow & { conclusion_text: string | null }>(db, "companion_conclusions", ["id", "companion_id", "source_sessions", "created_at", "conclusion_text"]),
    selectColumns<ThreadNoteRow & { content: string | null }>(db, "wm_continuity_notes", ["note_id", "agent_id", "thread_key", "created_at", "content"]),
    selectColumns<{ thread_key: string; agent_id: string }>(db, "wm_mind_threads", ["thread_key", "agent_id"]),
    selectColumns<ProjectLogRow>(db, "project_log", ["id", "project_id", "companion_id", "created_at"]),
    selectColumns<{ id: string; title: string; status: string }>(db, "companion_projects", ["id", "title", "status"]),
    // mig 0149. Tolerates the table not existing yet (a Worker deployed ahead of its migration
    // derives no people lane rather than failing the whole rebuild).
    db.prepare("SELECT id, label, match_names, kind FROM graph_people WHERE archived = 0").all<{ id: string; label: string; match_names: string; kind: string }>()
      .then((r) => (r.results ?? []).map((p) => ({ id: p.id, label: p.label, match_names: parseMatchNames(p.match_names), kind: p.kind })))
      .catch((e: unknown): PersonMatchRow[] | null => {
        // 2026-10-29: ONLY "table not created yet" reads as an empty list. Any other D1 error (a
        // transient blip) used to read as "nobody on the list" and the stale pass deleted every
        // people edge. null = the source is unknown this run; see peopleUnread below.
        if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return [];
        console.warn("[graph] graph_people read failed; skipping the people source this run", e);
        return null;
      }),
    selectColumns<ArchitectFactGraphRow>(db, "architect_facts", ["id", "companion_id", "status", "created_at"]),
    selectColumns<RelationalStateGraphRow>(db, "companion_relational_state", ["id", "companion_id", "toward", "noted_at"]),
  ]);
  const peopleUnread = people === null;
  const peopleRows: PersonMatchRow[] = people ?? [];
  const projectTitles: MentionTitleRow[] = projects
    .filter((p) => p.status === "open" || p.status === "paused")
    .map((p) => ({ table: "companion_projects", id: p.id, title: p.title }));
  const shelfTitles: ShelfTitleRow[] = [
    ...watchTitles.map((r) => ({ table: "watch_shelf" as const, id: r.id, title: r.title })),
    // Whole-table read (this file's convention: correlate in JS, not in SQL) filtered here to
    // status = 'active' -- a retired obsession is still a real row, just not a live title source.
    ...obsessionTitles.filter((r) => r.status === "active").map((r) => ({ table: "obsession_shelf" as const, id: r.id, title: r.title })),
  ];
  // Read once, shared by both dangling-session checks below (b, c) -- see their comments for why
  // a session_id can point at nothing (append-only source, 8-row 2026-03 audit finding).
  const sessionIds = new Set(sessions.map((s) => s.id));

  const sources: Array<{ source: string; edges: GraphEdgeRow[]; lanes?: readonly string[] }> = [
    { source: "companion_conclusions.superseded_by", edges: buildSupersedesEdges(conclusions) },
    { source: "relational_deltas.session_id", edges: buildRelationalDeltaEdges(deltas, sessionIds) },
    { source: "companion_journal.session_id", edges: buildJournalEdges(journal, sessionIds) },
    { source: "inter_companion_notes", edges: buildNoteEdges(notes) },
    { source: "companion_tensions", edges: buildTensionEdges(tensions) },
    { source: "handover_packets.session_id", edges: buildHandoverEdges(handovers) },
    { source: "companion_journal.note_text~title", edges: buildMentionsEdges(journal, shelfTitles) },
    { source: "companion_conclusions.source_sessions", edges: buildConcludedInEdges(conclusionSources, sessionIds) },
    { source: "wm_continuity_notes.thread_key", edges: buildThreadEdges(threadNotes, threads) },
    { source: "project_log.project_id", edges: buildProjectLogEdges(projectLogs, new Set(projects.map((p) => p.id))) },
    { source: "graph_people.centre", edges: buildCentreEdges(facts, relStates) },
    {
      source: "graph_people~name",
      edges: buildPeopleMentionsEdges([
        ...journal.map((j) => ({ table: "companion_journal", id: j.id, writer: j.agent, text: j.note_text, created_at: j.created_at })),
        ...threadNotes.map((n) => ({ table: "wm_continuity_notes", id: n.note_id, writer: n.agent_id, text: n.content, created_at: n.created_at })),
        ...conclusionSources.map((c) => ({ table: "companion_conclusions", id: c.id, writer: c.companion_id, text: c.conclusion_text, created_at: c.created_at })),
      ], peopleRows),
    },
    {
      source: "notes+conclusions+journal~title",
      edges: [
        ...buildTextMentionsEdges([
          ...threadNotes.map((n) => ({ table: "wm_continuity_notes", id: n.note_id, writer: n.agent_id, text: n.content, created_at: n.created_at })),
          ...conclusionSources.map((c) => ({ table: "companion_conclusions", id: c.id, writer: c.companion_id, text: c.conclusion_text, created_at: c.created_at })),
        ], [...shelfTitles, ...projectTitles]),
        ...buildTextMentionsEdges(
          journal.map((j) => ({ table: "companion_journal", id: j.id, writer: j.agent, text: j.note_text, created_at: j.created_at })),
          projectTitles,
        ),
      ],
    },
    // Source (i) is ONE builder reported as FOUR source rows. The builder has to walk the events once
    // (the `follows` chain and the merged alongside cap are both per-event state), but a single
    // "companion_soma_events: 412" count would be illegible -- four families with very different
    // expected magnitudes collapsed into one number is how a dead family hides behind a live one.
    // Partitioning by edge_type preserves the builder's emission order, so determinism is unaffected.
    ...(() => {
      // relational_deltas is read once above for source (b); the same rows feed the alongside lane
      // here (RelationalDeltaRow is structurally a RelationalDeltaGraphRow).
      const all = buildSomaEventEdges(somaEvents, sessionIds, journal, commonsPosts, reflections, forageFinds, autonomyRuns, deltas);
      const of = (t: string) => all.filter((e) => e.edge_type === t);
      return [
        { source: "companion_soma_events.cause", edges: of("moved_by") },
        { source: "companion_soma_events.follows", edges: of("follows") },
        { source: "companion_soma_events.session", edges: of("logged_in") },
        // One merged count (the cap is on the merged list, so that is the number that means
        // something) PLUS a per-table breakdown, so a lane that stopped producing is a visible 0.
        { source: "companion_soma_events.alongside", edges: of("alongside"), lanes: ALONGSIDE_LANES },
      ];
    })(),
  ];

  // Desired state. First source to derive a key claims it -- the order INSERT OR IGNORE used to
  // enforce by statement order, kept so per-source counts mean what they always meant.
  const desired = new Map<string, { edge: GraphEdgeRow; source: string }>();
  for (const s of sources) {
    for (const e of s.edges) {
      const k = edgeKey(e);
      if (!desired.has(k)) desired.set(k, { edge: e, source: s.source });
    }
  }

  const existing = new Map<string, ExistingEdgeRow>();
  for (const row of await loadExistingEdges(db)) existing.set(edgeKey(row), row);

  const held = new Map<string, number>();
  const toInsert: Array<{ edge: GraphEdgeRow; source: string }> = [];
  const updates: D1PreparedStatement[] = [];
  for (const [k, d] of desired) {
    const ex = existing.get(k);
    if (!ex) { toInsert.push(d); continue; }
    // A 'live' row already holds this identity: it wins, exactly as INSERT OR IGNORE let it.
    if (!isMechanical(ex.provenance)) continue;
    held.set(d.source, (held.get(d.source) ?? 0) + 1);
    if (ex.writer !== d.edge.writer || ex.provenance !== d.edge.provenance || ex.created_at !== d.edge.created_at) {
      updates.push(db.prepare(
        "UPDATE graph_edges SET writer = ?, provenance = ?, created_at = ? WHERE id = ?",
      ).bind(d.edge.writer, d.edge.provenance, d.edge.created_at, ex.id));
    }
  }
  const staleIds: string[] = [];
  for (const [k, ex] of existing) {
    // A failed people read derived nothing, which is not the same as "no edges wanted": leave
    // that source's edges (everything pointing at graph_people) alone this run.
    if (peopleUnread && ex.dst_table === "graph_people") continue;
    if (isMechanical(ex.provenance) && !desired.has(k)) staleIds.push(ex.id);
  }

  // Inserts first, deletes last: a reader mid-run sees the new graph arriving before the old one
  // leaves, never a hole where both are gone.
  const added = new Map<string, number>();
  for (const group of chunk(toInsert, BATCH_CHUNK_SIZE)) {
    const results = await db.batch(group.map((d) => insertStatement(db, d.edge)));
    results.forEach((r, i) => {
      if ((r.meta?.changes ?? 0) > 0) {
        const src = group[i]!.source;
        added.set(src, (added.get(src) ?? 0) + 1);
        held.set(src, (held.get(src) ?? 0) + 1);
      }
    });
  }
  const updated = await runChunked(db, updates);
  const removed = await runChunked(db, chunk(staleIds, DELETE_IDS_PER_STATEMENT).map((ids) =>
    db.prepare(`DELETE FROM graph_edges WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids),
  ));

  const counts: SourceCount[] = [];
  for (const s of sources) {
    const base: SourceCount = { source: s.source, inserted: held.get(s.source) ?? 0, added: added.get(s.source) ?? 0 };
    if (s.lanes) {
      // Derived from the source's own edge list, keyed on dst_table: the breakdown counts what was
      // DERIVED per lane, which is the question "is this lane alive" actually asks.
      const lanes: Record<string, number> = {};
      for (const lane of s.lanes) lanes[lane] = 0;
      for (const e of s.edges) lanes[e.dst_table] = (lanes[e.dst_table] ?? 0) + 1;
      base.lanes = lanes;
    }
    counts.push(base);
  }
  let addedTotal = 0;
  for (const n of added.values()) addedTotal += n;
  return { sources: counts, diff: { derived: desired.size, added: addedTotal, updated, removed } };
}

/** Per-source counts only -- the shape every caller before the diff rebuild used. */
export async function rebuildGraph(env: Env): Promise<SourceCount[]> {
  return (await rebuildGraphDetailed(env)).sources;
}
