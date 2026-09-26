// src/webmind/tray-insert.ts  (2026-09-26, imp tray pass 2)
//
// THE ONLY INSERTs into companion_journal and wm_continuity_notes. Every writer builds its row here,
// and the row's review_state comes from reviewStateFor() -- never from the caller. Before this, the
// birth rule was a function each writer had to remember to call; four of them (the MCP journal tool,
// held marks, session-close witness notes, the soma_arc/spiral notes) did not, so "decided in one
// place" was true of the rule and false of the writes. src/__tests__/tray-sweep.test.ts fails if an
// INSERT INTO either table appears anywhere else in src/.
//
// Returns a bound D1 statement (not a promise) so a caller can .run() it, or put it in a batch().
// Column names are module literals; only values are bound. Columns are emitted in the tables'
// historical order and an OMITTED optional field is left out entirely (the column default applies),
// so each writer's statement is the same shape it always was plus review_state.

import { reviewStateFor, type ReviewState } from "./review-state.js";

type D1Like = { prepare: (sql: string) => { bind: (...v: unknown[]) => any } };

export interface JournalInsertRow {
  id: string;
  agent: string;
  note_text: string;
  /** ISO string. Omitted: SQLite `datetime('now')`, which is what the letter writers always used. */
  created_at?: string;
  tags?: string | null;
  session_id?: string | null;
  source?: string | null;
  topic_tags?: string | null;
  external_id?: string | null;
}

export interface NoteInsertRow {
  note_id: string;
  agent_id: string;
  content: string;
  created_at: string;
  thread_key?: string | null;
  note_type?: string | null;
  salience?: string | null;
  actor?: string | null;
  source?: string | null;
  correlation_id?: string | null;
}

/** created_at with no value becomes SQL datetime('now') (never bound); other undefined columns are skipped. */
const NOW_SQL = Symbol("now");

function build(table: string, cols: Array<[string, unknown]>, tail = "") {
  const names: string[] = [];
  const marks: string[] = [];
  const binds: unknown[] = [];
  for (const [c, v] of cols) {
    if (v === undefined) continue;
    names.push(c);
    if (v === NOW_SQL) { marks.push("datetime('now')"); continue; }
    marks.push("?");
    binds.push(v);
  }
  return { sql: `INSERT INTO ${table} (${names.join(", ")}) VALUES (${marks.join(", ")})${tail}`, binds };
}

/** The journal row's birth state, exposed so a caller can report it without re-deriving it. */
export function journalBirthState(row: Pick<JournalInsertRow, "source">): ReviewState {
  return reviewStateFor("journal", { source: row.source ?? null });
}

export function noteBirthState(row: Pick<NoteInsertRow, "source" | "correlation_id" | "content">): ReviewState {
  return reviewStateFor("note", { source: row.source ?? null, correlation_id: row.correlation_id ?? null, content: row.content });
}

/**
 * INSERT one companion_journal row. `onConflictExternalId` adds the idempotency clause the speech
 * writer needs (mig 0098's unique index is PARTIAL, so the conflict target repeats its predicate).
 */
export function journalInsert(db: D1Like, row: JournalInsertRow, opts: { onConflictExternalId?: boolean } = {}) {
  const { sql, binds } = build("companion_journal", [
    ["id", row.id],
    ["created_at", row.created_at ?? NOW_SQL],
    ["agent", row.agent],
    ["note_text", row.note_text],
    ["tags", row.tags],
    ["session_id", row.session_id],
    ["source", row.source],
    ["topic_tags", row.topic_tags],
    ["external_id", row.external_id],
    ["review_state", journalBirthState(row)],
  ], opts.onConflictExternalId ? " ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING" : "");
  return db.prepare(sql).bind(...binds);
}

/** INSERT one wm_continuity_notes row. Defaults mirror addNote's historical ones. */
export function noteInsert(db: D1Like, row: NoteInsertRow) {
  const { sql, binds } = build("wm_continuity_notes", [
    ["note_id", row.note_id],
    ["agent_id", row.agent_id],
    ["thread_key", row.thread_key ?? null],
    ["note_type", row.note_type ?? "continuity"],
    ["content", row.content],
    ["salience", row.salience ?? "normal"],
    ["actor", row.actor ?? "agent"],
    ["source", row.source ?? "system"],
    ["correlation_id", row.correlation_id ?? null],
    ["created_at", row.created_at],
    ["review_state", noteBirthState({ source: row.source ?? "system", correlation_id: row.correlation_id, content: row.content })],
  ]);
  return db.prepare(sql).bind(...binds);
}
