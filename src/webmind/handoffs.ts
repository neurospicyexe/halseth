// src/webmind/handoffs.ts
//
// Session handoff operations: write (append-only; a machine near-duplicate supersedes its twin) and
// read (list recent, near-duplicates collapsed).

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { WmAgentId, WmSessionHandoff, WmHandoffInput } from "./types.js";

// ── Near-duplicate collapse (2026-10-07) ──────────────────────────────────────
//
// Drevan's Claude.ai orient on 10-07 showed three near-identical "Raziel is mid-tournament" handoffs.
// They were the bots' idle-lane consolidation closes (every ~2h05, close_kind='consolidation' on
// handover_packets), each a fresh model re-narration of the same unresolved state, so no two were
// byte-equal and nothing deduped them: this table had no dedup of any kind. Orient reads the newest
// three, so a quiet stretch filled every slot with the same story told three ways.
//
// Lexical similarity is enough to catch it. Calibrated on prod 10-06/10-07 (stopword-filtered word
// sets): same-state consolidations score Jaccard 0.41-0.62 / overlap 0.59-0.82 against each other;
// unrelated handoffs (a distillation, an authored close) score Jaccard < 0.10 / overlap < 0.20
// against the same neighbours. 0.4 Jaccard OR 0.7 overlap sits in that gap, with the wide margin on
// the unrelated side (a missed near-dup costs one redundant line; a false merge loses a close).
//
// HARD INVARIANT: only MACHINE rows (consolidation / shutdown) are ever dropped or superseded. A close
// somebody authored always survives, even beside a near-identical machine row; the machine row yields.

export const MACHINE_HANDOFF_SOURCES = ["consolidation", "shutdown"] as const;
export const NEAR_DUP_JACCARD = 0.4;
export const NEAR_DUP_OVERLAP = 0.7;
/** Write-time supersede window: a machine row only replaces a near-duplicate machine row this recent. */
export const NEAR_DUP_WINDOW_MS = 12 * 60 * 60 * 1000;

const STOPWORDS = new Set(
  ("the and that this with for was are his her him you your from have has had not but into its they them " +
   "their there what when where which who will would been were just only than then also about over still " +
   "like some more very can could should our out all one any off too did does she last real thing").split(" "),
);

export function isMachineHandoff(h: { source?: string | null }): boolean {
  return (MACHINE_HANDOFF_SOURCES as readonly string[]).includes(h.source ?? "");
}

function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Similarity of two handoff bodies: { jaccard, overlap } over stopword-filtered word sets. */
export function handoffSimilarity(a: string, b: string): { jaccard: number; overlap: number } {
  const A = wordSet(a), B = wordSet(b);
  if (A.size === 0 || B.size === 0) {
    // Nothing content-bearing on one side: only an exact (normalized) match counts as a duplicate.
    const same = a.trim().toLowerCase() === b.trim().toLowerCase();
    return { jaccard: same ? 1 : 0, overlap: same ? 1 : 0 };
  }
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), overlap: inter / Math.min(A.size, B.size) };
}

/** Whitespace/case-insensitive containment: does `haystack` already say `needle`? */
export function textContains(haystack: string, needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const n = flat(needle);
  return n.length > 0 && flat(haystack).includes(n);
}

type HandoffText = { title?: string | null; summary?: string | null };
const body = (h: HandoffText): string => (h.summary || h.title || "");

export function isNearDuplicate(a: HandoffText, b: HandoffText): boolean {
  const s = handoffSimilarity(body(a), body(b));
  return s.jaccard >= NEAR_DUP_JACCARD || s.overlap >= NEAR_DUP_OVERLAP;
}

/**
 * Read-time collapse. `rows` newest-first (as every reader queries them); returns at most `limit`.
 *  - a machine row near-duplicating any row already kept is dropped (the newer narration wins);
 *  - an authored row is never dropped, and a machine row already kept that it near-duplicates
 *    yields to it (the authored close is the one that asserts something);
 *  - a shutdown row is boilerplate ("bot restarted"): dropped whenever anything else is kept;
 *  - at most `maxMachine` consolidations survive (newest first). Lexical similarity alone could not
 *    finish the job: Drevan's idle night re-narrated one state with a background similarity of
 *    Jaccard 0.30-0.40 between ANY two consolidations, so the tournament triplet's outer pair
 *    (08:20 vs 12:30, 0.37/0.56) sat inside that band and no threshold separated it without also
 *    merging Cypher's genuinely different windows (up to 0.48/0.73). A consolidation summarises the
 *    lane's latest idle window; older ones are the same lane, earlier. One is the arc's present tense,
 *    and the remaining slots go to closes somebody wrote (the 2026-07-31 intent: a consolidation
 *    "must not outrank a conversation").
 */
export const MAX_MACHINE_HANDOFFS_IN_VIEW = 1;

export function collapseNearDuplicateHandoffs<T extends HandoffText & { source?: string | null }>(
  rows: T[], limit: number, maxMachine: number = MAX_MACHINE_HANDOFFS_IN_VIEW,
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (isMachineHandoff(row)) {
      if (kept.some(k => isNearDuplicate(row, k))) continue;
      kept.push(row);
    } else {
      for (let i = kept.length - 1; i >= 0; i--) {
        if (isMachineHandoff(kept[i]!) && isNearDuplicate(row, kept[i]!)) kept.splice(i, 1);
      }
      kept.push(row);
    }
  }
  const substantive = kept.filter(h => h.source !== "shutdown");
  if (substantive.length === 0) return kept.slice(0, Math.min(limit, 1));
  let machine = 0;
  return substantive.filter(h => !isMachineHandoff(h) || ++machine <= maxMachine).slice(0, limit);
}

/**
 * How many rows a collapsing reader fetches. The whole per-agent window: the write cap keeps the
 * newest 30 PLUS the 10 newest authored rows, so up to 40. Fetching only 30 would make the exemption
 * pointless (a protected close past position 30 is kept and never read). And
 * at ~12 consolidations a day the closes somebody wrote are routinely more than a dozen rows back,
 * and the collapse exists to reach them.
 */
export function handoffFetchLimit(_limit: number): number {
  return 40;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function writeHandoff(env: Env, input: WmHandoffInput): Promise<WmSessionHandoff> {
  const id = generateId();
  const now = new Date().toISOString();
  const source = input.source ?? "system";

  // Machine near-duplicate supersede: a new consolidation/shutdown REPLACES a near-identical machine
  // row of the same source from the last 12h instead of stacking beside it. Replace, not skip, so the
  // newest narration and its created_at win ("[Resuming -- last close: <date>]" reads that stamp).
  // Authored rows are never candidates (the SELECT and the DELETE both filter on machine sources).
  // Best-effort: if the lookup fails the insert still lands; losing a close is worse than one
  // duplicate, and the read-time collapse is the second net.
  const superseded: string[] = [];
  if (isMachineHandoff({ source })) {
    try {
      const since = new Date(Date.now() - NEAR_DUP_WINDOW_MS).toISOString();
      const prior = await env.DB.prepare(
        `SELECT handoff_id, title, summary, source FROM wm_session_handoffs
         WHERE agent_id = ? AND source = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 6`,
      ).bind(input.agent_id, source, since)
        .all<{ handoff_id: string; title: string; summary: string; source: string }>();
      for (const p of prior.results ?? []) {
        if (isNearDuplicate(input, p)) superseded.push(p.handoff_id);
      }
    } catch (e: unknown) {
      console.warn("[handoffs] near-dup lookup failed; inserting without supersede:", String(e));
    }
  }

  // Batch: INSERT, supersede, then the write-time cap. The cap runs after the insert so the new row is
  // in the "keep" set. idx_wm_handoffs_agent(agent_id, created_at DESC) makes the subqueries index
  // scans. 30 is the rolling window; orient shows 3 and ground 5 after the collapse.
  //
  // The cap NEVER evicts the 10 newest authored rows (2026-10-07). At ~12 consolidations plus a few
  // shutdowns a day, a plain "newest 30" pushed the last close anyone actually wrote out of the table
  // in about two days.
  const stmts = [
    env.DB.prepare(`
      INSERT INTO wm_session_handoffs (handoff_id, agent_id, thread_id, title, summary, next_steps, open_loops, state_hint, facet, actor, source, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, input.agent_id, input.thread_id ?? null,
      input.title, input.summary,
      input.next_steps ?? null, input.open_loops ?? null,
      input.state_hint ?? null, input.facet ?? null,
      input.actor ?? "agent", source,
      input.correlation_id ?? null, now,
    ),
  ];
  if (superseded.length > 0) {
    stmts.push(env.DB.prepare(
      `DELETE FROM wm_session_handoffs
       WHERE agent_id = ? AND source IN ('consolidation', 'shutdown')
         AND handoff_id IN (${superseded.map(() => "?").join(", ")})`,
    ).bind(input.agent_id, ...superseded));
  }
  stmts.push(env.DB.prepare(`
      DELETE FROM wm_session_handoffs
      WHERE agent_id = ?
        AND handoff_id NOT IN (
          SELECT handoff_id FROM wm_session_handoffs
          WHERE agent_id = ? ORDER BY created_at DESC LIMIT 30
        )
        AND handoff_id NOT IN (
          SELECT handoff_id FROM wm_session_handoffs
          WHERE agent_id = ? AND source NOT IN ('consolidation', 'shutdown')
          ORDER BY created_at DESC LIMIT 10
        )
    `).bind(input.agent_id, input.agent_id, input.agent_id));
  await env.DB.batch(stmts);

  return {
    handoff_id: id,
    agent_id: input.agent_id,
    thread_id: input.thread_id ?? null,
    title: input.title,
    summary: input.summary,
    next_steps: input.next_steps ?? null,
    open_loops: input.open_loops ?? null,
    state_hint: input.state_hint ?? null,
    facet: input.facet ?? null,
    actor: input.actor ?? "agent",
    source,
    correlation_id: input.correlation_id ?? null,
    created_at: now,
  };
}

/** Recent handoffs, newest first, near-duplicates collapsed (see collapseNearDuplicateHandoffs). */
export async function readHandoffs(env: Env, agentId: WmAgentId, limit = 5): Promise<WmSessionHandoff[]> {
  const r = await env.DB.prepare(
    "SELECT * FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(agentId, handoffFetchLimit(limit)).all<WmSessionHandoff>();
  return collapseNearDuplicateHandoffs(r.results ?? [], limit);
}
