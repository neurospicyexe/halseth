// src/handlers/inter_companion_notes.ts
//
// GET /inter-companion-notes/unread/:companionId
// Returns unread inter_companion_notes addressed to the given companion
// (or broadcast notes with to_id IS NULL), marks them read, returns items.
// Used by Discord bots to poll for notes left by Claude.ai companions.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["drevan", "cypher", "gaia"]);
const MAX_ITEMS = 20;

interface NoteRow {
  id: string;
  from_id: string;
  to_id: string | null;
  content: string;
  created_at: string;
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
    `SELECT id, from_id, to_id, content, created_at
     FROM inter_companion_notes
     WHERE read_at IS NULL AND (to_id = ? OR to_id IS NULL)
     ORDER BY created_at ASC
     LIMIT ${MAX_ITEMS}`,
  ).bind(companionId).all<NoteRow>();

  const items = rows.results ?? [];

  if (items.length > 0) {
    const ids = items.map(() => "?").join(", ");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${ids})`,
    ).bind(now, ...items.map((r) => r.id)).run();
  }

  return new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json" },
  });
}
