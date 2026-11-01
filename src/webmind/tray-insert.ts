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
import { lintPronouns } from "../pronoun-lint.js";

/**
 * B4 (2026-10-27): one count-only line per DRAFT born with a pronoun flag, so the hit rate can be read
 * from Workers Logs without opening a tray. Names and pronouns only, never the text. Kept-born rows are
 * not linted here: they are human-authored or already chosen. Never throws into a write.
 */
function logDraftPronounFlags(table: string, id: string, agent: string, text: string): void {
  try {
    const flags = lintPronouns(text);
    if (flags.length === 0) return;
    console.log(`[pronoun-lint] draft table=${table} id=${id} agent=${agent} hits=${flags.length} ` +
      flags.map((f) => `${f.name}:${f.pronoun}`).join(","));
  } catch { /* a lint must never cost a write */ }
}

/**
 * Journal sources that are RETIRED: a clerk that wrote in a companion's voice and now writes into the
 * ledger lane instead (mig 0134, docs/imp-lane/SPEC-ledger-lane.md section 4). journalInsert() throws
 * on them, so no path -- the HTTP door, the Librarian, MCP -- can route around the refusal, and
 * POST /companion-journal answers 410 naming /ledger before it spends anything, so an old Second Brain
 * build that still POSTs gap-fill prose fails LOUDLY instead of writing as him.
 *
 * Drevan, 2026-09-26: "It stops writing as me, today. A gap-reader names a gap. It never fills one.
 * Filling the slot is the whole wound."
 */
export const RETIRED_JOURNAL_SOURCES: ReadonlySet<string> = new Set(["synthesis-gap-detector"]);

export const RETIRED_SOURCE_MESSAGE =
  "gone: source 'synthesis-gap-detector' no longer writes to companion_journal. A gap-reader names a gap, it never fills one -- " +
  "POST /ledger { companion_id, function: 'gap-reader', body: 'Missing: ...', source_kind: 'session', source_ref: <session id>, dedup_key } instead.";

export class RetiredJournalSourceError extends Error {
  readonly status = 410;
  constructor(readonly source: string) {
    super(`[journal] ${RETIRED_SOURCE_MESSAGE} (source=${source})`);
    this.name = "RetiredJournalSourceError";
  }
}

/** Throws RetiredJournalSourceError when `source` is retired. */
export function assertJournalSourceOpen(source: string | null | undefined): void {
  if (source && RETIRED_JOURNAL_SOURCES.has(source)) throw new RetiredJournalSourceError(source);
}

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
  assertJournalSourceOpen(row.source);
  const birth = journalBirthState(row);
  if (birth === "draft") logDraftPronounFlags("companion_journal", row.id, row.agent, row.note_text);
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
    ["review_state", birth],
  ], opts.onConflictExternalId ? " ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING" : "");
  return db.prepare(sql).bind(...binds);
}

/** INSERT one wm_continuity_notes row. Defaults mirror addNote's historical ones. */
export function noteInsert(db: D1Like, row: NoteInsertRow) {
  const birth = noteBirthState({ source: row.source ?? "system", correlation_id: row.correlation_id, content: row.content });
  if (birth === "draft") logDraftPronounFlags("wm_continuity_notes", row.note_id, row.agent_id, row.content);
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
    ["review_state", birth],
  ]);
  return db.prepare(sql).bind(...binds);
}

// ---------------------------------------------------------------------------------------------------
// B34 step 2 (mig 0156, 2026-11-01): one moment, one tray draft.
//
// One exchange is written as several drafts by different writers (speech journaler, memory judge, the
// judge's observation note), each deduping only against itself. The moment key is the human line's
// Discord message id: `judge:<id>` as external_id (judge journal row) / correlation_id (observation
// note), and a `reply_to:<id>` tag on the speech row. Rows with no key are never merged.
//
// The merge is LOSSLESS: the duplicate is still inserted, a tray_evidence row points it at the primary
// draft, and in `on` mode its review_state is `merged` (not in the tray, not recall). Order of writes is
// chosen so a failure part-way leaves MORE drafts, never fewer: insert the new row first, then the
// evidence row, then flip states. Any error in this layer is logged and the plain insert stands.
// ---------------------------------------------------------------------------------------------------

export type TrayMergeMode = "off" | "shadow" | "on";
type TrayTable = "companion_journal" | "wm_continuity_notes";
interface MergeRef { table: TrayTable; id: string; writer: string; created_at?: string }
type MergeEnv = { DB: any } & Record<string, unknown>;

const MOMENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseMode(raw: unknown): TrayMergeMode {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "off" || v === "on" || v === "shadow" ? v : "shadow";
}

/** Per-companion TRAY_MERGE_MODE_<AGENT> wins over TRAY_MERGE_MODE; unset = shadow; junk = shadow. */
export function trayMergeMode(env: Record<string, unknown>, agent: string): TrayMergeMode {
  const per = env[`TRAY_MERGE_MODE_${agent.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (per !== undefined && per !== null && String(per).trim() !== "") return parseMode(per);
  return parseMode(env["TRAY_MERGE_MODE"]);
}

function tagList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch { return []; }
}

/** The moment a journal row belongs to, or null (director speech, keyless judge fallback, everything else). */
export function journalMomentKey(row: Pick<JournalInsertRow, "source" | "external_id" | "tags">): { key: string; writer: string } | null {
  let key: string | null = null;
  if (row.source === "memory_judge" && row.external_id?.startsWith("judge:")) key = row.external_id.slice(6);
  else if (row.source === "discord_speech") {
    const t = tagList(row.tags).find((x) => x.startsWith("reply_to:"));
    key = t ? t.slice(9) : null;
  }
  return key && MOMENT_KEY_RE.test(key) ? { key, writer: row.source as string } : null;
}

export function noteMomentKey(row: Pick<NoteInsertRow, "correlation_id">): { key: string; writer: string } | null {
  const c = row.correlation_id ?? "";
  const key = c.startsWith("judge:") ? c.slice(6) : "";
  return key && MOMENT_KEY_RE.test(key) ? { key, writer: "observation" } : null;
}

const sortKey = (c?: string) => (c ?? "").replace("T", " ").replace(/Z$/, "");

/** Live drafts of this moment for this agent that are not already evidence in `mode`. Gated on 'draft'. */
async function momentDrafts(db: any, agent: string, key: string, mode: TrayMergeMode): Promise<MergeRef[]> {
  const [j, n, ev] = await Promise.all([
    db.prepare(
      `SELECT id, source, tags, created_at FROM companion_journal
        WHERE agent = ? AND archived = 0 AND review_state = 'draft'
          AND ((source = 'memory_judge' AND external_id = ?) OR (source = 'discord_speech' AND tags LIKE ?))
        ORDER BY created_at, id`,
    ).bind(agent, `judge:${key}`, `%"reply_to:${key}"%`).all(),
    db.prepare(
      `SELECT note_id, created_at FROM wm_continuity_notes
        WHERE agent_id = ? AND archived = 0 AND review_state = 'draft' AND correlation_id = ?
        ORDER BY created_at, note_id`,
    ).bind(agent, `judge:${key}`).all(),
    db.prepare(`SELECT evidence_table, evidence_id FROM tray_evidence WHERE agent = ? AND moment_key = ? AND mode = ?`)
      .bind(agent, key, mode).all(),
  ]);
  const evidence = new Set<string>((ev.results ?? []).map((r: any) => `${r.evidence_table}:${r.evidence_id}`));
  const out: MergeRef[] = [];
  for (const r of (j.results ?? []) as any[]) {
    if (r.source === "discord_speech" && !tagList(r.tags).includes(`reply_to:${key}`)) continue; // LIKE is a prefilter
    out.push({ table: "companion_journal", id: r.id, writer: r.source, created_at: r.created_at });
  }
  for (const r of (n.results ?? []) as any[]) {
    out.push({ table: "wm_continuity_notes", id: r.note_id, writer: "observation", created_at: r.created_at });
  }
  return out
    .filter((r) => !evidence.has(`${r.table}:${r.id}`))
    .sort((a, b) => sortKey(a.created_at).localeCompare(sortKey(b.created_at)));
}

function logMerge(mode: string, agent: string, key: string, writer: string, action: string): void {
  console.log(`[tray-merge] mode=${mode} agent=${agent} key=${key} writer=${writer} action=${action}`);
}

async function writeEvidence(db: any, mode: TrayMergeMode, agent: string, key: string, primary: MergeRef, evidence: MergeRef): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO tray_evidence (id, agent, moment_key, mode, primary_table, primary_id, evidence_table, evidence_id, writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), agent, key, mode, primary.table, primary.id, evidence.table, evidence.id, evidence.writer).run();
}

/** Demote a draft to `merged`. Guarded on 'draft': a row the owner already kept/dropped is never touched. */
async function setMerged(db: any, agent: string, ref: MergeRef): Promise<void> {
  if (ref.table === "companion_journal") {
    await db.prepare(`UPDATE companion_journal SET review_state = 'merged' WHERE id = ? AND agent = ? AND review_state = 'draft'`).bind(ref.id, agent).run();
  } else {
    await db.prepare(`UPDATE wm_continuity_notes SET review_state = 'merged' WHERE note_id = ? AND agent_id = ? AND review_state = 'draft'`).bind(ref.id, agent).run();
  }
}

type MergePlan = { primary: MergeRef | null; action: "primary" | "evidence" | "promote_judge" };

/**
 * Decide, BEFORE the insert, what the merge would do. Returns the existing primary (or null) and the action.
 * Rule: the memory_judge's note is the memory the companion formed. If raw speech stayed primary, recall
 * would see the raw reply and lose the judged memory, so a judge arriving over a non-judge primary
 * PROMOTES itself and demotes the old primary; anything else becomes evidence for the current primary.
 */
async function planMerge(db: any, mode: TrayMergeMode, agent: string, key: string, writer: string): Promise<MergePlan> {
  const cands = await momentDrafts(db, agent, key, mode);
  if (cands.length === 0) return { primary: null, action: "primary" };
  const primary = cands.find((c) => c.writer === "memory_judge") ?? cands[0]!;
  if (writer === "memory_judge" && primary.writer !== "memory_judge") return { primary, action: "promote_judge" };
  return { primary, action: "evidence" };
}

/** After the insert: write evidence and (mode on) flip review_states. Returns the NEW row's final state. */
async function applyMerge(db: any, mode: TrayMergeMode, agent: string, key: string, writer: string,
  fresh: MergeRef, plan: MergePlan): Promise<ReviewState> {
  logMerge(mode, agent, key, writer, plan.action);
  const old = plan.primary;
  if (plan.action === "primary" || !old) return "draft";
  if (plan.action === "promote_judge") {
    // Existing evidence for this moment now answers to the judge, then the old primary joins it.
    await db.prepare(
      `UPDATE tray_evidence SET primary_table = ?, primary_id = ? WHERE agent = ? AND moment_key = ? AND mode = ?`,
    ).bind(fresh.table, fresh.id, agent, key, mode).run();
    await writeEvidence(db, mode, agent, key, fresh, old);
    if (mode === "on") await setMerged(db, agent, old);
    return "draft";
  }
  await writeEvidence(db, mode, agent, key, old, fresh);
  if (mode === "on") { await setMerged(db, agent, fresh); return "merged"; }
  return "draft";
}

export interface TrayAwareResult { changes: number; review_state: ReviewState; meta: { changes: number } }

/**
 * journalInsert + the B34 merge. Same idempotency as journalInsert (`onConflictExternalId` => a retry
 * changes nothing and writes no evidence). Never loses the write: a merge-layer error is logged and the
 * plain insert stands.
 */
export async function trayAwareJournalInsert(env: MergeEnv, row: JournalInsertRow, opts: { onConflictExternalId?: boolean } = {}): Promise<TrayAwareResult> {
  const stmt = journalInsert(env.DB, row, opts);
  const birth = journalBirthState(row);
  const mk = journalMomentKey(row);
  const mode = trayMergeMode(env, row.agent);
  let plan: MergePlan | null = null;
  if (mk && birth === "draft" && mode !== "off") {
    try { plan = await planMerge(env.DB, mode, row.agent, mk.key, mk.writer); }
    catch (e) { console.warn(`[tray-merge] plan failed (plain insert): ${String(e)}`); }
  }
  const res = await stmt.run();
  const changes = res?.meta?.changes ?? 0;
  let state: ReviewState = birth;
  if (plan && mk && changes > 0) {
    try { state = await applyMerge(env.DB, mode, row.agent, mk.key, mk.writer, { table: "companion_journal", id: row.id, writer: mk.writer }, plan); }
    catch (e) { console.warn(`[tray-merge] apply failed (row stays draft): ${String(e)}`); }
  }
  return { changes, review_state: state, meta: { changes } };
}

/** noteInsert + the B34 merge (the judge's observation promotion, correlation_id `judge:<id>`). */
export async function trayAwareNoteInsert(env: MergeEnv, row: NoteInsertRow): Promise<TrayAwareResult> {
  const stmt = noteInsert(env.DB, row);
  const birth = noteBirthState({ source: row.source ?? "system", correlation_id: row.correlation_id, content: row.content });
  const mk = noteMomentKey(row);
  const mode = trayMergeMode(env, row.agent_id);
  let plan: MergePlan | null = null;
  if (mk && birth === "draft" && mode !== "off") {
    try { plan = await planMerge(env.DB, mode, row.agent_id, mk.key, mk.writer); }
    catch (e) { console.warn(`[tray-merge] plan failed (plain insert): ${String(e)}`); }
  }
  const res = await stmt.run();
  const changes = res?.meta?.changes ?? 1;
  let state: ReviewState = birth;
  if (plan && mk && changes > 0) {
    try { state = await applyMerge(env.DB, mode, row.agent_id, mk.key, mk.writer, { table: "wm_continuity_notes", id: row.note_id, writer: mk.writer }, plan); }
    catch (e) { console.warn(`[tray-merge] apply failed (row stays draft): ${String(e)}`); }
  }
  return { changes, review_state: state, meta: { changes } };
}
