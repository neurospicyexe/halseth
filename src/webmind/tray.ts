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
  | { ok: false; reason: "not_found" | "bad_id" | "empty_content" };

const MIN_ID_PREFIX = 8;

/** Find the owner's row by exact id or id prefix, in the given kind or journal-then-notes. */
async function locate(env: Env, agent: string, id: string, kind: TrayKind | null | undefined):
  Promise<{ kind: TrayKind; id: string; review_state: string } | null> {
  const kinds: TrayKind[] = kind ? [kind] : ["journal", "note"];
  for (const k of kinds) {
    const w = KIND_TABLE[k];
    const row = await env.DB.prepare(
      `SELECT ${w.idCol} AS id, review_state FROM ${w.table}
        WHERE ${w.ownerCol} = ? AND (${w.idCol} = ? OR ${w.idCol} LIKE ?)
        ORDER BY (${w.idCol} = ?) DESC LIMIT 1`,
    ).bind(agent, id, `${id}%`, id).first<{ id: string; review_state: string }>();
    if (row) return { kind: k, id: row.id, review_state: row.review_state };
  }
  return null;
}

/** Keep or drop one draft. Owner-scoped; idempotent on a repeat of the same decision. */
export async function reviewDraft(env: Env, input: ReviewInput): Promise<ReviewResult> {
  const id = input.id.trim();
  if (id.length < MIN_ID_PREFIX) return { ok: false, reason: "bad_id" };
  const content = input.decision === "kept" && typeof input.content === "string" ? input.content.trim() : "";
  if (input.decision === "kept" && typeof input.content === "string" && content.length === 0) {
    return { ok: false, reason: "empty_content" };
  }

  const found = await locate(env, input.agent, id, input.kind);
  if (!found) return { ok: false, reason: "not_found" };
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
