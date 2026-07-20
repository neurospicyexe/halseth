// src/handlers/inter_companion_notes.ts
//
// GET /inter-companion-notes/unread/:companionId
// Returns unread inter_companion_notes addressed to the given companion
// (or broadcast notes with to_id IS NULL). Does NOT mark them read.
// POST /inter-companion-notes/ack
// Marks a list of note IDs as read after the bot has processed them.
// Used by Discord bots to poll for notes left by Claude.ai companions.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { COMPANION_ID_SET } from "../companions.js";

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
