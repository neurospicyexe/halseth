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
//
// CAS discipline (2026-07-21 review fix): three bot processes hit these functions on the
// SAME thread concurrently, by design. Every writer that transitions state guards its
// UPDATE with `WHERE id = ? AND state IN ('open','moving')` so a late writer can never
// clobber a land/fade another process already committed between that writer's read and
// its write. appendTurn additionally mutates `participants` SQL-side (json_each/
// json_insert, deduped by author) instead of read-modify-write in JS -- the old path read
// participants in JS, pushed, and wrote the whole blob back, so two concurrent appends by
// different authors could drop one, and the open->moving transition rode the same stale
// snapshot. The transition is now computed from the POST-mutation array length inside the
// same guarded statement.

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";

export const FADE_HOURS = 12;
export const LEDGER_RETURN_LIMIT = 12;
export const GIST_MAX = 140;
export const SEED_MAX = 1000;

const REF_TYPES = ["question", "tension", "council"] as const;

// Ref-existence check table map -- mirrors the mig-0104 convention in
// src/librarian/backends/halseth.ts (NOTE_REF_TABLES / addCompanionNote, ~L619): validate
// enum + pairing first, then confirm the referenced row actually exists before writing.
// Declared locally rather than imported -- a webmind module importing from
// src/librarian/backends would be the wrong dependency direction.
const REF_TABLES: Record<(typeof REF_TYPES)[number], string> = {
  question: "companion_questions",
  tension: "companion_tensions",
  council: "council_questions",
};

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
  if (hasRefType) {
    const table = REF_TABLES[input.ref_type as (typeof REF_TYPES)[number]];
    const found = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(input.ref_id).first();
    if (!found) {
      return { error: `ref_id "${input.ref_id}" not found in ${table}` };
    }
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

  // Finding 1 + 2 (2026-07-21 review): single CAS-guarded, SQL-side mutation. participants
  // is deduped and appended against the CURRENT row via json_each/json_insert (not the
  // `thread` snapshot read above, which two concurrent callers could both be holding
  // stale), the open->moving transition is computed from the POST-mutation participant
  // count in the same statement, and the WHERE guard means a thread landed/faded by
  // another process between our SELECT and this write is never clobbered.
  const updateResult = await env.DB.prepare(`
    UPDATE conversation_threads SET turn_count = turn_count + 1, last_turn_at = ?,
      participants = CASE
        WHEN EXISTS (SELECT 1 FROM json_each(participants) WHERE value = ?) THEN participants
        ELSE json_insert(participants, '$[#]', ?)
      END,
      state = CASE
        WHEN state = 'open'
          AND json_array_length(participants)
            + (CASE WHEN EXISTS (SELECT 1 FROM json_each(participants) WHERE value = ?) THEN 0 ELSE 1 END)
            >= 2
        THEN 'moving'
        ELSE state
      END
    WHERE id = ? AND state IN ('open','moving')
    RETURNING state, participants
  `).bind(now, input.author, input.author, input.author, threadId)
    // .all() rather than .run() -- both return the same D1Result<T> shape (docs call
    // run() "functionally equivalent to all(), can be treated as an alias"), but .all()
    // is the unambiguous choice for a statement whose whole point is reading back
    // RETURNING rows, not just meta.changes.
    .all<{ state: string; participants: string }>();

  if (updateResult.meta.changes === 0) {
    // Thread transitioned (land/fade) between our initial SELECT and this write. The turn
    // is already durably recorded in thread_ledger above -- report success, but this call
    // did not cause (and must not claim) a state transition.
    return { ok: true };
  }

  return { ok: true, state: updateResult.results[0]?.state };
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
  // Finding 1 (2026-07-21 review): compare-and-set. WHERE guard means this can never
  // overwrite a concurrent land/fade that landed between our SELECT above and this write.
  const updateResult = await env.DB.prepare(
    "UPDATE conversation_threads SET state = 'landed', resolution = ?, landed_by = ?, landed_at = ? WHERE id = ? AND state IN ('open','moving')"
  ).bind(input.resolution, input.landed_by, now, threadId).run();

  if (updateResult.meta.changes === 0) {
    // CAS lost the race -- another process already landed or faded it. Re-check so the
    // reason reflects reality instead of silently reporting an ok that didn't happen.
    const recheck = await env.DB.prepare(
      "SELECT * FROM conversation_threads WHERE id = ?"
    ).bind(threadId).first<ConvoThread>();
    return recheck ? { ok: false, reason: "terminal" } : { ok: false, reason: "not_found" };
  }

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
    // Finding 1 (2026-07-21 review): CAS-guarded so this can never clobber a concurrent
    // land that landed the thread between our SELECT above and this write.
    await env.DB.prepare(
      "UPDATE conversation_threads SET state = 'faded' WHERE id = ? AND state IN ('open','moving')"
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
