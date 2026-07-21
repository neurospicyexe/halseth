// src/webmind/conversations.ts
//
// Thread spine core (migration 0106): durable conversation threads for live surfaces
// (Discord commons, Raziel dialogue; later Claude.ai/Layer B). A thread = seed + ledger +
// state + optional shared-object ref (mig 0104 convention: question|tension|council).
// One ACTIVE ('open'|'moving') thread per channel, enforced by a partial unique index on
// conversation_threads(channel_id); openConversation handles the resulting UNIQUE race by
// reading back and returning the winner instead of erroring. Ledger appends are idempotent
// per Discord message (three bot processes can witness the same message) via
// INSERT OR IGNORE against the unique (thread_id, message_id) index. Active threads that
// go quiet longer than FADE_HOURS are lazily faded on next read rather than swept by a cron.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";

export const FADE_HOURS = 12;
export const LEDGER_RETURN_LIMIT = 12;
export const GIST_MAX = 140;
export const SEED_MAX = 1000;

const REF_TYPES = ["question", "tension", "council"] as const;

export interface ConvoThread {
  id: string; channel_id: string; surface: string;
  seed_text: string; seed_author: string; seed_message_id: string | null;
  ref_type: string | null; ref_id: string | null; ref_label: string | null;
  participants: string; state: string;
  resolution: string | null; landed_by: string | null; landed_at: string | null;
  turn_count: number; last_turn_at: string; created_at: string;
}

export interface LedgerRow { id: string; author: string; gist: string; message_id: string | null; said_at: string; }

function isTerminal(state: string): boolean {
  return state === "landed" || state === "faded";
}

export async function openConversation(env: Env, input: {
  channel_id: string; seed_text: string; seed_author: string;
  seed_message_id?: string; surface?: string;
  ref_type?: string; ref_id?: string; ref_label?: string;
}): Promise<{ thread: ConvoThread; created: boolean } | { error: string }> {
  const hasRefType = input.ref_type != null;
  const hasRefId = input.ref_id != null;
  if (hasRefType !== hasRefId) {
    return { error: "ref_type and ref_id must be provided together (all-or-nothing)" };
  }
  if (hasRefType && !REF_TYPES.includes(input.ref_type as (typeof REF_TYPES)[number])) {
    return { error: `ref_type must be one of ${REF_TYPES.join("|")}` };
  }

  const now = new Date().toISOString();
  const id = generateId();
  const surface = input.surface ?? "discord";
  const seedText = input.seed_text.slice(0, SEED_MAX);
  const participants = JSON.stringify([input.seed_author]);

  try {
    await env.DB.prepare(`
      INSERT INTO conversation_threads
        (id, channel_id, surface, seed_text, seed_author, seed_message_id, ref_type, ref_id, ref_label, participants, state, turn_count, last_turn_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)
    `).bind(
      id, input.channel_id, surface, seedText, input.seed_author,
      input.seed_message_id ?? null,
      input.ref_type ?? null, input.ref_id ?? null, input.ref_label ?? null,
      participants, now, now,
    ).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("UNIQUE")) {
      return { error: msg };
    }
    const existing = await env.DB.prepare(
      "SELECT * FROM conversation_threads WHERE channel_id = ? AND state IN ('open','moving')"
    ).bind(input.channel_id).first<ConvoThread>();
    if (!existing) {
      return { error: "UNIQUE conflict but no active thread found for channel" };
    }
    return { thread: existing, created: false };
  }

  const thread: ConvoThread = {
    id, channel_id: input.channel_id, surface, seed_text: seedText, seed_author: input.seed_author,
    seed_message_id: input.seed_message_id ?? null,
    ref_type: input.ref_type ?? null, ref_id: input.ref_id ?? null, ref_label: input.ref_label ?? null,
    participants, state: "open",
    resolution: null, landed_by: null, landed_at: null,
    turn_count: 0, last_turn_at: now, created_at: now,
  };

  return { thread, created: true };
}

export async function appendTurn(env: Env, threadId: string, input: {
  author: string; gist: string; message_id?: string;
}): Promise<{ ok: boolean; deduped?: boolean; state?: string; reason?: string }> {
  const thread = await env.DB.prepare(
    "SELECT * FROM conversation_threads WHERE id = ?"
  ).bind(threadId).first<ConvoThread>();

  if (!thread) return { ok: false, reason: "not_found" };
  if (isTerminal(thread.state)) return { ok: false, reason: "terminal" };

  const now = new Date().toISOString();
  const gist = input.gist.slice(0, GIST_MAX);
  const ledgerId = generateId();
  const messageId = input.message_id ?? null;

  const insertSql = messageId != null
    ? "INSERT OR IGNORE INTO thread_ledger (id, thread_id, author, gist, message_id, said_at) VALUES (?, ?, ?, ?, ?, ?)"
    : "INSERT INTO thread_ledger (id, thread_id, author, gist, message_id, said_at) VALUES (?, ?, ?, ?, ?, ?)";

  const insertResult = await env.DB.prepare(insertSql)
    .bind(ledgerId, threadId, input.author, gist, messageId, now)
    .run();

  if (insertResult.meta.changes === 0) {
    return { ok: true, deduped: true };
  }

  let participants: string[];
  try {
    const parsed = JSON.parse(thread.participants);
    participants = Array.isArray(parsed) ? parsed : [];
  } catch {
    participants = [];
  }
  if (!participants.includes(input.author)) participants.push(input.author);

  const nextState = thread.state === "open" && participants.length >= 2 ? "moving" : thread.state;

  await env.DB.prepare(
    "UPDATE conversation_threads SET turn_count = turn_count + 1, last_turn_at = ?, participants = ?, state = ? WHERE id = ?"
  ).bind(now, JSON.stringify(participants), nextState, threadId).run();

  return { ok: true, state: nextState };
}

export async function landConversation(env: Env, threadId: string, input: {
  resolution: string; landed_by: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const thread = await env.DB.prepare(
    "SELECT * FROM conversation_threads WHERE id = ?"
  ).bind(threadId).first<ConvoThread>();

  if (!thread) return { ok: false, reason: "not_found" };
  if (isTerminal(thread.state)) return { ok: false, reason: "terminal" };

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE conversation_threads SET state = 'landed', resolution = ?, landed_by = ?, landed_at = ? WHERE id = ?"
  ).bind(input.resolution, input.landed_by, now, threadId).run();

  return { ok: true };
}

export async function getActiveConversation(env: Env, channelId: string):
  Promise<{ thread: ConvoThread; ledger: LedgerRow[] } | null> {
  const thread = await env.DB.prepare(
    "SELECT * FROM conversation_threads WHERE channel_id = ? AND state IN ('open','moving')"
  ).bind(channelId).first<ConvoThread>();

  if (!thread) return null;

  const elapsedMs = Date.now() - Date.parse(thread.last_turn_at);
  if (elapsedMs > FADE_HOURS * 3_600_000) {
    await env.DB.prepare(
      "UPDATE conversation_threads SET state = 'faded' WHERE id = ?"
    ).bind(thread.id).run();
    return null;
  }

  const ledgerRes = await env.DB.prepare(`
    SELECT * FROM (
      SELECT * FROM thread_ledger WHERE thread_id = ? ORDER BY said_at DESC LIMIT ?
    ) ORDER BY said_at ASC
  `).bind(thread.id, LEDGER_RETURN_LIMIT).all<LedgerRow>();

  return { thread, ledger: ledgerRes.results ?? [] };
}

export async function listConversations(env: Env, opts: {
  state?: string; days?: number; limit?: number;
}): Promise<ConvoThread[]> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (opts.state) {
    conditions.push("state = ?");
    bindings.push(opts.state);
  }
  if (opts.days !== undefined) {
    conditions.push("datetime(created_at) >= datetime('now', ?)");
    bindings.push(`-${opts.days} days`);
  }

  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const res = await env.DB.prepare(
    `SELECT * FROM conversation_threads ${where} ORDER BY last_turn_at DESC LIMIT ?`
  ).bind(...bindings, limit).all<ConvoThread>();

  return res.results ?? [];
}
