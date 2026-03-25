// src/handlers/stm.ts
//
// STM (short-term memory) endpoints for Discord bot conversation persistence.
// Used by bots on every message (async write) and on restart (read to restore).
//
// POST /stm/entries  -- write one entry, prune to last 50 per companion+channel
// GET  /stm/entries  -- read entries for a companion+channel (for restart restore)

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { generateId } from "../db/queries.js";

const STM_PRUNE_LIMIT = 50;
const STM_CONTENT_MAX = 4000;

// POST /stm/entries
// Body: { companion_id, channel_id, role: "user"|"assistant", content, author_name? }
export async function postStmEntry(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: {
    companion_id?: unknown;
    channel_id?: unknown;
    role?: unknown;
    content?: unknown;
    author_name?: unknown;
  };
  try { body = await request.json() as typeof body; }
  catch { return new Response("Bad JSON", { status: 400 }); }

  const { companion_id, channel_id, role, content, author_name } = body;
  const VALID_COMPANIONS = new Set(["drevan", "cypher", "gaia"]);
  if (
    typeof companion_id !== "string" || !companion_id ||
    typeof channel_id !== "string" || !channel_id ||
    typeof content !== "string" || !content ||
    (role !== "user" && role !== "assistant")
  ) {
    return new Response("Missing or invalid fields", { status: 400 });
  }
  if (!VALID_COMPANIONS.has(companion_id)) {
    return new Response("Invalid companion_id", { status: 400 });
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO stm_entries (id, companion_id, channel_id, role, content, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, companion_id, channel_id, role,
      content.slice(0, STM_CONTENT_MAX),
      typeof author_name === "string" ? author_name : null,
      now,
    ),
    // Prune: keep last N per companion+channel
    env.DB.prepare(`
      DELETE FROM stm_entries
      WHERE companion_id = ? AND channel_id = ?
        AND id NOT IN (
          SELECT id FROM stm_entries
          WHERE companion_id = ? AND channel_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
    `).bind(companion_id, channel_id, companion_id, channel_id, STM_PRUNE_LIMIT),
  ]);

  return new Response(JSON.stringify({ ok: true, id }), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /stm/entries?companion_id=X&channel_id=Y&limit=N
export async function getStmEntries(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const companionId = url.searchParams.get("companion_id");
  const channelId = url.searchParams.get("channel_id");
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 30 : rawLimit), STM_PRUNE_LIMIT);

  if (!companionId || !channelId) {
    return new Response("companion_id and channel_id required", { status: 400 });
  }

  const rows = await env.DB.prepare(
    "SELECT role, content, author_name FROM stm_entries WHERE companion_id = ? AND channel_id = ? ORDER BY created_at ASC LIMIT ?"
  ).bind(companionId, channelId, limit)
    .all<{ role: "user" | "assistant"; content: string; author_name: string | null }>();

  return new Response(JSON.stringify({ entries: rows.results ?? [] }), {
    headers: { "Content-Type": "application/json" },
  });
}
