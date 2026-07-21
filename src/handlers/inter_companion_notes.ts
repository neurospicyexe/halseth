// src/handlers/inter_companion_notes.ts
//
// GET /inter-companion-notes/unread/:companionId
// Returns unread inter_companion_notes addressed to the given companion
// (or broadcast notes with to_id IS NULL). Does NOT mark them read.
// POST /inter-companion-notes/ack
// Marks a list of note IDs as read after the bot has processed them.
// Used by Discord bots to poll for notes left by Claude.ai companions.
// GET /inter-companion-notes/moves
// Task 16 (2026-07-20) measurability endpoint -- see getInterCompanionNoteMoves below.
// Task 6 of the thread-spine plan (2026-07-21) added a `landed_conversations` section
// to this same endpoint -- resolved conversation_threads (mig 0106) carrying a ref_type.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { COMPANION_ID_SET } from "../companions.js";
import { NOTE_REF_TABLES, type NoteRefType } from "../librarian/backends/halseth.js";

const VALID_COMPANIONS = COMPANION_ID_SET;
const MAX_ITEMS = 20;

interface NoteRow {
  id: string;
  from_id: string;
  to_id: string | null;
  content: string;
  created_at: string;
  ref_type: string | null;
  ref_id: string | null;
  reason: string | null;
}

export async function getUnreadInterCompanionNotes(
  request: Request,
  env: Env,
  params: { companionId?: string },
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params.companionId ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return new Response("Invalid companion_id", { status: 400 });
  }

  const rows = await env.DB.prepare(
    `SELECT id, from_id, to_id, content, created_at, ref_type, ref_id, reason
     FROM inter_companion_notes
     WHERE read_at IS NULL AND (to_id = ? OR to_id IS NULL)
     ORDER BY created_at ASC
     LIMIT ${MAX_ITEMS}`,
  ).bind(companionId).all<NoteRow>();

  return new Response(JSON.stringify({ items: rows.results ?? [] }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function ackInterCompanionNotes(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as { ids?: string[]; companion_id?: string };
  const ids = body?.ids;
  const companionId = typeof body?.companion_id === "string" && body.companion_id.length > 0
    ? body.companion_id
    : null;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS) {
    return new Response("ids must be a non-empty array (max 20)", { status: 400 });
  }

  // Validate all IDs are strings (prevent injection via parameterized query)
  if (!ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 36)) {
    return new Response("Invalid id format", { status: 400 });
  }

  const placeholders = ids.map(() => "?").join(", ");
  const now = new Date().toISOString();
  // Scope to the acking companion when provided so one companion can't mark a
  // sibling's addressed notes read (broadcasts, to_id NULL, stay ackable by anyone).
  const scope = companionId ? " AND (to_id = ? OR to_id IS NULL)" : "";
  const bindings: unknown[] = [now, ...ids];
  if (companionId) bindings.push(companionId);
  await env.DB.prepare(
    `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL${scope}`,
  ).bind(...bindings).run();

  return new Response(JSON.stringify({ acked: ids.length }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET /inter-companion-notes/moves?days=30 ────────────────────────────────
// Measurability half of migration 0104 (Task 15 was the write path). A note that
// references a shared object (ref_type/ref_id) is a "move". This asks: of the
// moves in the last N days, how many saw their referenced object's state change
// AFTER the move (compared against note.created_at)?
//
// "State changed" per ref_type:
//   question -> status != 'open' AND answered_at > note.created_at
//   tension  -> status != 'simmering' OR last_surfaced_at > note.created_at
//     (approximation: companion_tensions has no status-history table, so a
//      last_surfaced_at bump with the status unchanged still counts as movement --
//      that's the only trace a re-surfaced-but-not-yet-resolved tension leaves.)
//   council  -> status = 'closed' AND closed_at > note.created_at
//
// Read-only. `moves` reflects the (possibly LIMIT-capped) fetched set, not a
// separate count -- see MOVES_FETCH_LIMIT.
const MOVES_FETCH_LIMIT = 200;
const MOVES_DAYS_DEFAULT = 30;
const MOVES_DAYS_MAX = 365;

interface RefNoteRow {
  id: string;
  from_id: string;
  to_id: string | null;
  ref_type: NoteRefType;
  ref_id: string;
  reason: string | null;
  created_at: string;
}

interface RefObjectRow {
  id: string;
  status: string;
  answered_at?: string | null;
  last_surfaced_at?: string | null;
  closed_at?: string | null;
}

// Task 6 (thread-spine plan, 2026-07-21): landed_conversations section on the moves
// endpoint. A landed conversation_threads row (mig 0106) that carries a ref_type is a
// resolved thread on a shared object -- report it alongside note-moves, read-only.
interface LandedConversationRow {
  id: string;
  channel_id: string;
  seed_author: string;
  ref_type: NoteRefType;
  ref_id: string;
  ref_label: string | null;
  resolution: string | null;
  landed_by: string | null;
  landed_at: string;
}

const REF_OBJECT_COLUMNS: Record<NoteRefType, string> = {
  question: "id, status, answered_at",
  tension: "id, status, last_surfaced_at",
  council: "id, status, closed_at",
};

async function lookupRefObjects(
  env: Env,
  ref_type: NoteRefType,
  ids: string[],
): Promise<Map<string, RefObjectRow>> {
  const map = new Map<string, RefObjectRow>();
  if (ids.length === 0) return map;
  const table = NOTE_REF_TABLES[ref_type];
  const columns = REF_OBJECT_COLUMNS[ref_type];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT ${columns} FROM ${table} WHERE id IN (${placeholders})`,
  ).bind(...ids).all<RefObjectRow>();
  for (const row of rows.results ?? []) map.set(row.id, row);
  return map;
}

/** Per-ref_type "did it move" rule. See file-header comment for the exact spec. */
function stateChangedAfterNote(
  ref_type: NoteRefType,
  row: RefObjectRow | undefined,
  noteCreatedAt: string,
): boolean {
  if (!row) return false;
  switch (ref_type) {
    case "question":
      return row.status !== "open" && !!row.answered_at && row.answered_at > noteCreatedAt;
    case "tension":
      return row.status !== "simmering" || (!!row.last_surfaced_at && row.last_surfaced_at > noteCreatedAt);
    case "council":
      return row.status === "closed" && !!row.closed_at && row.closed_at > noteCreatedAt;
  }
}

export async function getInterCompanionNoteMoves(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get("days") ?? "", 10);
  const days = Math.min(
    Math.max(Number.isFinite(rawDays) && rawDays > 0 ? rawDays : MOVES_DAYS_DEFAULT, 1),
    MOVES_DAYS_MAX,
  );
  const since = `-${days} days`;

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inter_companion_notes WHERE created_at > datetime('now', ?1)`,
  ).bind(since).first<{ n: number }>();

  const movesRows = await env.DB.prepare(
    `SELECT id, from_id, to_id, ref_type, ref_id, reason, created_at
     FROM inter_companion_notes
     WHERE ref_type IS NOT NULL AND created_at > datetime('now', ?1)
     ORDER BY created_at DESC
     LIMIT ${MOVES_FETCH_LIMIT}`,
  ).bind(since).all<RefNoteRow>();
  const moves = movesRows.results ?? [];

  const idsByType: Record<NoteRefType, string[]> = { question: [], tension: [], council: [] };
  for (const m of moves) idsByType[m.ref_type].push(m.ref_id);

  const [questionMap, tensionMap, councilMap] = await Promise.all([
    lookupRefObjects(env, "question", idsByType.question),
    lookupRefObjects(env, "tension", idsByType.tension),
    lookupRefObjects(env, "council", idsByType.council),
  ]);
  const mapByType: Record<NoteRefType, Map<string, RefObjectRow>> = {
    question: questionMap,
    tension: tensionMap,
    council: councilMap,
  };

  let moved = 0;
  const items = moves.map((m) => {
    const row = mapByType[m.ref_type].get(m.ref_id);
    const changed = stateChangedAfterNote(m.ref_type, row, m.created_at);
    if (changed) moved++;
    return {
      note_id: m.id,
      from_id: m.from_id,
      to_id: m.to_id,
      ref_type: m.ref_type,
      ref_id: m.ref_id,
      reason: m.reason,
      created_at: m.created_at,
      object_state: row?.status ?? null,
      state_changed_after_note: changed,
    };
  });

  const movesCount = moves.length;
  const movedPct = movesCount > 0 ? Math.round((moved / movesCount) * 100) : 0;

  const landedRows = await env.DB.prepare(
    `SELECT id, channel_id, seed_author, ref_type, ref_id, ref_label, resolution, landed_by, landed_at
     FROM conversation_threads
     WHERE state = 'landed' AND ref_type IS NOT NULL
       AND datetime(landed_at) >= datetime('now', ?1)`,
  ).bind(since).all<LandedConversationRow>();
  const landedItems = landedRows.results ?? [];

  return new Response(JSON.stringify({
    window_days: days,
    total_notes: totalRow?.n ?? 0,
    moves: movesCount,
    moved,
    moved_pct: movedPct,
    items,
    landed_conversations: {
      count: landedItems.length,
      items: landedItems,
    },
  }), { headers: { "Content-Type": "application/json" } });
}
