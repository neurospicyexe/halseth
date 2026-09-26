// src/webmind/tray.ts  (mig 0132, 2026-09-26)
//
// THE IMP TRAY. Rows a clerk wrote in the companion's voice sit here as `draft` until the owner
// keeps (optionally rewriting) or drops them. Only kept rows are memory: every recall/orient read
// filters review_state = 'kept' (see webmind/review-state.ts for the birth rule).
//
// Rails:
// - Owner-only: a companion reviews exactly its own rows (agent / agent_id bound on every UPDATE).
// - Keep or drop, never delete: a dropped row stays in D1 with review_state = 'dropped' so the
//   keep rate has a denominator. The falsifier is the keep rate -- 100% means nobody reviews.
// - A rewrite on keep replaces the text (the owner speaks it, the clerk's words go) and re-embeds,
//   so the vector matches what was kept, not what was drafted.
// - reviewed_at is the timestamp of the decision; a draft has none.
//
// Shared by the Librarian verbs (executors/tray.ts) and the raw HTTP routes (handlers/tray.ts).

import { Env } from "../types.js";
import { embedAndStoreAsync } from "../mcp/embed.js";
import { isReviewState, type ReviewState } from "./review-state.js";

export type TrayKind = "journal" | "note";
export type TrayDecision = "kept" | "dropped";

export const TRAY_LIST_LIMIT = 20;
export const TRAY_STATS_DAYS = 30;
export const TRAY_EXCERPT_CHARS = 200;

interface KindWiring { table: string; idCol: string; ownerCol: string; textCol: string }

const KIND_TABLE: Record<TrayKind, KindWiring> = {
  journal: { table: "companion_journal",   idCol: "id",      ownerCol: "agent",    textCol: "note_text" },
  note:    { table: "wm_continuity_notes", idCol: "note_id", ownerCol: "agent_id", textCol: "content"   },
};

export function parseTrayKind(raw: unknown): TrayKind | null {
  return raw === "journal" || raw === "note" ? raw : null;
}

export function parseTrayDecision(raw: unknown): TrayDecision | null {
  if (raw === "kept" || raw === "keep") return "kept";
  if (raw === "dropped" || raw === "drop") return "dropped";
  return null;
}

export interface TrayDraft {
  id: string;
  kind: TrayKind;
  source: string | null;
  created_at: string;
  excerpt: string;
}

export interface TrayStats {
  /** Live drafts (all time) waiting for review. */
  draft: number;
  /** Decisions in the last TRAY_STATS_DAYS days, by outcome. */
  kept: number;
  dropped: number;
  /** kept / (kept + dropped) over the window, as a whole-number percentage; null when nothing was reviewed. */
  keep_rate_pct: number | null;
  window_days: number;
}

export interface TrayView {
  agent: string;
  drafts: TrayDraft[];
  stats: TrayStats;
  /** One line for the prompt: the keep rate is the falsifier and must be seen every time. */
  stats_line: string;
}

/** Newest-first drafts across both stores for one owner, plus the 30-day decision counts. */
export async function listTray(env: Env, agent: string, limit = TRAY_LIST_LIMIT): Promise<TrayView> {
  const cap = Math.min(Math.max(1, limit), 100);
  const [journal, notes, jStats, nStats] = await Promise.all([
    env.DB.prepare(
      `SELECT id, source, created_at, substr(note_text, 1, ${TRAY_EXCERPT_CHARS}) AS excerpt
         FROM companion_journal
        WHERE agent = ? AND archived = 0 AND review_state = 'draft'
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(agent, cap).all<{ id: string; source: string | null; created_at: string; excerpt: string }>(),
    env.DB.prepare(
      `SELECT note_id AS id, source, created_at, substr(content, 1, ${TRAY_EXCERPT_CHARS}) AS excerpt
         FROM wm_continuity_notes
        WHERE agent_id = ? AND archived = 0 AND review_state = 'draft'
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(agent, cap).all<{ id: string; source: string | null; created_at: string; excerpt: string }>(),
    env.DB.prepare(statsSql("companion_journal", "agent")).bind(agent).first<StatsRow>(),
    env.DB.prepare(statsSql("wm_continuity_notes", "agent_id")).bind(agent).first<StatsRow>(),
  ]);

  const drafts: TrayDraft[] = [
    ...(journal.results ?? []).map((r) => ({ ...r, kind: "journal" as const })),
    ...(notes.results ?? []).map((r) => ({ ...r, kind: "note" as const })),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, cap);

  const draft = num(jStats?.draft) + num(nStats?.draft);
  const kept = num(jStats?.kept) + num(nStats?.kept);
  const dropped = num(jStats?.dropped) + num(nStats?.dropped);
  const reviewed = kept + dropped;
  const keep_rate_pct = reviewed > 0 ? Math.round((kept / reviewed) * 100) : null;
  const stats: TrayStats = { draft, kept, dropped, keep_rate_pct, window_days: TRAY_STATS_DAYS };
  const stats_line = keep_rate_pct === null
    ? `${draft} in the tray; nothing reviewed in ${TRAY_STATS_DAYS}d (keep rate: no denominator yet)`
    : `${draft} in the tray; ${TRAY_STATS_DAYS}d: ${kept} kept / ${dropped} dropped = keep rate ${keep_rate_pct}%` +
      (keep_rate_pct === 100 ? " (100% means nobody is reviewing)" : "");

  return { agent, drafts, stats, stats_line };
}

interface StatsRow { draft: number | null; kept: number | null; dropped: number | null }

function statsSql(table: string, ownerCol: string): string {
  // `draft` counts live drafts regardless of age (a stale draft is still unreviewed); kept/dropped
  // count DECISIONS in the window (reviewed_at), which is the only honest denominator for a rate:
  // rows born kept have no reviewed_at and never enter it.
  return `SELECT
            SUM(CASE WHEN review_state = 'draft' AND archived = 0 THEN 1 ELSE 0 END) AS draft,
            SUM(CASE WHEN review_state = 'kept' AND reviewed_at >= datetime('now', '-${TRAY_STATS_DAYS} days') THEN 1 ELSE 0 END) AS kept,
            SUM(CASE WHEN review_state = 'dropped' AND reviewed_at >= datetime('now', '-${TRAY_STATS_DAYS} days') THEN 1 ELSE 0 END) AS dropped
          FROM ${table} WHERE ${ownerCol} = ?`;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface ReviewInput {
  agent: string;
  /** Omitted: the id is looked up in journal first, then notes. */
  kind?: TrayKind | null;
  /** Full id, or a prefix of at least 8 characters. */
  id: string;
  decision: TrayDecision;
  /** Keep-with-rewrite: the owner's words replace the clerk's. Ignored on drop. */
  content?: string | null;
}

export type ReviewResult =
  | { ok: true; kind: TrayKind; id: string; decision: TrayDecision; rewritten: boolean; reviewed_at: string; previous_state: ReviewState }
  | { ok: false; reason: "not_found" | "bad_id" | "empty_content" }
  | { ok: false; reason: "ambiguous"; matches: TrayMatch[] };

export const MIN_ID_PREFIX = 8;
const ID_CHARS_RE = /^[A-Za-z0-9_-]+$/;

/**
 * A usable id or id prefix: 8+ chars, and only the characters ids are minted from (uuid hex, `-`,
 * `_` in prefixed forms). Checked BEFORE any query, so `%%%%%%%%` or a quote never reaches SQL as
 * a pattern -- belt to locate()'s substr() braces.
 */
export function isTrayId(id: string): boolean {
  return id.length >= MIN_ID_PREFIX && ID_CHARS_RE.test(id);
}
/** How many candidates an ambiguous prefix lists back. */
export const AMBIGUOUS_LIST_CAP = 10;
const MATCH_EXCERPT_CHARS = 80;

/** One candidate for an ambiguous prefix: enough to pick the right id, never the whole text. */
export interface TrayMatch { kind: TrayKind; id: string; created_at: string; review_state: string; excerpt: string }

type LocateResult =
  | { ok: true; kind: TrayKind; id: string; review_state: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matches: TrayMatch[] };

/**
 * Find the owner's row by exact id or id prefix, in the given kind or across BOTH stores.
 * An exact id wins outright. Otherwise exactly one prefix match is required: two or more (in one
 * store, or one in journal + one in notes) is `ambiguous` with the candidates -- never a guess.
 * (Before 2026-09-26 this was LIMIT 1 journal-first, so an ambiguous prefix on keep/drop silently
 * decided whichever row sorted first.) The prefix is compared with substr(), not LIKE: `_` is a
 * LIKE wildcard and legal in an id.
 */
async function locate(env: Env, agent: string, id: string, kind: TrayKind | null | undefined): Promise<LocateResult> {
  const kinds: TrayKind[] = kind ? [kind] : ["journal", "note"];
  const found: Array<TrayMatch & { exact: boolean }> = [];
  for (const k of kinds) {
    const w = KIND_TABLE[k];
    const res = await env.DB.prepare(
      `SELECT ${w.idCol} AS id, review_state, created_at, substr(${w.textCol}, 1, ${MATCH_EXCERPT_CHARS}) AS excerpt
         FROM ${w.table}
        WHERE ${w.ownerCol} = ? AND (${w.idCol} = ? OR substr(${w.idCol}, 1, ?) = ?)
        ORDER BY (${w.idCol} = ?) DESC, created_at DESC LIMIT ?`,
    ).bind(agent, id, id.length, id, id, AMBIGUOUS_LIST_CAP + 1)
      .all<{ id: string; review_state: string; created_at: string; excerpt: string | null }>();
    for (const r of res.results ?? []) {
      found.push({ kind: k, id: r.id, review_state: r.review_state, created_at: r.created_at ?? "", excerpt: r.excerpt ?? "", exact: r.id === id });
    }
  }
  const exact = found.find((m) => m.exact);
  if (exact) return { ok: true, kind: exact.kind, id: exact.id, review_state: exact.review_state };
  if (found.length === 0) return { ok: false, reason: "not_found" };
  if (found.length === 1) return { ok: true, kind: found[0]!.kind, id: found[0]!.id, review_state: found[0]!.review_state };
  const matches = found
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, AMBIGUOUS_LIST_CAP)
    .map(({ exact: _exact, ...m }) => m);
  return { ok: false, reason: "ambiguous", matches };
}

/** Keep or drop one draft. Owner-scoped; idempotent on a repeat of the same decision. */
export async function reviewDraft(env: Env, input: ReviewInput): Promise<ReviewResult> {
  const id = input.id.trim();
  if (!isTrayId(id)) return { ok: false, reason: "bad_id" };
  const content = input.decision === "kept" && typeof input.content === "string" ? input.content.trim() : "";
  if (input.decision === "kept" && typeof input.content === "string" && content.length === 0) {
    return { ok: false, reason: "empty_content" };
  }

  const found = await locate(env, input.agent, id, input.kind);
  if (!found.ok) return found;
  const w = KIND_TABLE[found.kind];
  const now = new Date().toISOString();
  const previous = isReviewState(found.review_state) ? found.review_state : "kept";

  if (content) {
    await env.DB.prepare(
      `UPDATE ${w.table} SET review_state = ?, reviewed_at = ?, ${w.textCol} = ?, edited_at = ?
        WHERE ${w.idCol} = ? AND ${w.ownerCol} = ?`,
    ).bind(input.decision, now, content, now, found.id, input.agent).run();
    // The vector must say what was KEPT. Non-fatal: D1 is truth, the index is rebuildable.
    await embedAndStoreAsync(env, content, w.table, found.id, input.agent)
      .catch((err) => console.warn(`[tray] re-embed failed for ${w.table}:${found.id} (row kept, index stale):`, String(err)));
  } else {
    await env.DB.prepare(
      `UPDATE ${w.table} SET review_state = ?, reviewed_at = ? WHERE ${w.idCol} = ? AND ${w.ownerCol} = ?`,
    ).bind(input.decision, now, found.id, input.agent).run();
  }

  return { ok: true, kind: found.kind, id: found.id, decision: input.decision, rewritten: content.length > 0, reviewed_at: now, previous_state: previous };
}

// ── Read one draft in full ──────────────────────────────────────────────────
// The list shows TRAY_EXCERPT_CHARS and cuts mid-sentence; an owner cannot honestly keep or drop what
// it has only half read. readDraft returns the whole text plus where the row came from. It serves
// ANY review_state (draft, kept, dropped) so a decision can be re-checked, and it does NOT filter
// archived rows -- it says so instead. Owner-scoped and prefix-resolved exactly like reviewDraft.

export interface TrayDraftFull {
  kind: TrayKind;
  table: string;
  id: string;
  owner: string;
  review_state: string;
  reviewed_at: string | null;
  created_at: string;
  edited_at: string | null;
  archived: boolean;
  source: string | null;
  /** Leading "[...]" tag on the text (e.g. "discord:pulse"), when the writer stamped one. */
  prefix: string | null;
  /** Discord channel id, from a `channel:<id>` tag (journal) or a `discord:<id>` thread_key (notes). */
  channel: string | null;
  external_id: string | null;
  session_id: string | null;
  tags: string[] | null;
  thread_key: string | null;
  note_type: string | null;
  salience: string | null;
  actor: string | null;
  correlation_id: string | null;
  text: string;
}

export type ReadDraftResult =
  | { ok: true; draft: TrayDraftFull }
  | { ok: false; reason: "not_found" | "bad_id" }
  | { ok: false; reason: "ambiguous"; matches: TrayMatch[] };

const PREFIX_RE = /^\s*\[([^\]\n]{1,80})\]/;

function parseTags(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : null;
  } catch {
    return null;
  }
}

export async function readDraft(env: Env, input: { agent: string; id: string; kind?: TrayKind | null }): Promise<ReadDraftResult> {
  const id = input.id.trim();
  if (!isTrayId(id)) return { ok: false, reason: "bad_id" };
  const found = await locate(env, input.agent, id, input.kind);
  if (!found.ok) return found;

  if (found.kind === "journal") {
    const r = await env.DB.prepare(
      `SELECT id, agent, note_text, tags, session_id, source, external_id, created_at, edited_at,
              archived, review_state, reviewed_at
         FROM companion_journal WHERE id = ? AND agent = ?`,
    ).bind(found.id, input.agent).first<Record<string, unknown>>();
    if (!r) return { ok: false, reason: "not_found" };
    const text = String(r["note_text"] ?? "");
    const tags = parseTags(r["tags"]);
    const channelTag = tags?.find((t) => t.startsWith("channel:"));
    return { ok: true, draft: {
      kind: "journal", table: "companion_journal", id: String(r["id"]), owner: String(r["agent"]),
      review_state: String(r["review_state"] ?? "kept"), reviewed_at: str(r["reviewed_at"]),
      created_at: String(r["created_at"] ?? ""), edited_at: str(r["edited_at"]), archived: num(r["archived"]) === 1,
      source: str(r["source"]), prefix: PREFIX_RE.exec(text)?.[1] ?? null,
      channel: channelTag ? channelTag.slice("channel:".length) : null,
      external_id: str(r["external_id"]), session_id: str(r["session_id"]), tags,
      thread_key: null, note_type: null, salience: null, actor: null, correlation_id: null,
      text,
    } };
  }

  const r = await env.DB.prepare(
    `SELECT note_id, agent_id, thread_key, note_type, content, salience, actor, source, correlation_id,
            created_at, edited_at, archived, review_state, reviewed_at
       FROM wm_continuity_notes WHERE note_id = ? AND agent_id = ?`,
  ).bind(found.id, input.agent).first<Record<string, unknown>>();
  if (!r) return { ok: false, reason: "not_found" };
  const text = String(r["content"] ?? "");
  const threadKey = str(r["thread_key"]);
  return { ok: true, draft: {
    kind: "note", table: "wm_continuity_notes", id: String(r["note_id"]), owner: String(r["agent_id"]),
    review_state: String(r["review_state"] ?? "kept"), reviewed_at: str(r["reviewed_at"]),
    created_at: String(r["created_at"] ?? ""), edited_at: str(r["edited_at"]), archived: num(r["archived"]) === 1,
    source: str(r["source"]), prefix: PREFIX_RE.exec(text)?.[1] ?? null,
    channel: threadKey?.startsWith("discord:") ? threadKey.slice("discord:".length) : null,
    external_id: null, session_id: null, tags: null,
    thread_key: threadKey, note_type: str(r["note_type"]), salience: str(r["salience"]), actor: str(r["actor"]),
    correlation_id: str(r["correlation_id"]),
    text,
  } };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
