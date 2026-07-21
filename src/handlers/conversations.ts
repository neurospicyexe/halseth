// src/handlers/conversations.ts
//
// HTTP route handlers for /mind/conversations* (migration 0106 thread spine, Task 3).
// Wires src/webmind/conversations.ts (Task 2) onto HTTP routes consumed by Discord bots
// (Task 8) and other live surfaces. Every handler starts with the same authGuard check
// used throughout src/handlers/webmind.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  openConversation,
  appendTurn,
  landConversation,
  getActiveConversation,
  listConversations,
} from "../webmind/conversations.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface OpenConversationBody {
  channel_id?: string;
  seed_text?: string;
  seed_author?: string;
  seed_message_id?: string;
  surface?: string;
  ref_type?: string;
  ref_id?: string;
  ref_label?: string;
}

// POST /mind/conversations
export async function postConversation(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: OpenConversationBody;
  try {
    body = await request.json() as OpenConversationBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.channel_id || typeof body.channel_id !== "string") {
    return json({ error: "channel_id is required" }, 400);
  }
  if (!body.seed_text || typeof body.seed_text !== "string") {
    return json({ error: "seed_text is required" }, 400);
  }
  if (!body.seed_author || typeof body.seed_author !== "string") {
    return json({ error: "seed_author is required" }, 400);
  }

  try {
    const result = await openConversation(env, {
      channel_id: body.channel_id,
      seed_text: body.seed_text,
      seed_author: body.seed_author,
      seed_message_id: body.seed_message_id,
      surface: body.surface,
      ref_type: body.ref_type,
      ref_id: body.ref_id,
      ref_label: body.ref_label,
    });

    if ("error" in result) {
      return json({ error: result.error }, 400);
    }

    return json(result, result.created ? 201 : 200);
  } catch (err) {
    console.error("[mind/conversations] POST error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/conversations/:id/turns   body: { author, gist, message_id? }
export async function postConversationTurn(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { author?: string; gist?: string; message_id?: string };
  try {
    body = await request.json() as { author?: string; gist?: string; message_id?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.author || typeof body.author !== "string") {
    return json({ error: "author is required" }, 400);
  }
  if (!body.gist || typeof body.gist !== "string") {
    return json({ error: "gist is required" }, 400);
  }

  try {
    const result = await appendTurn(env, id, {
      author: body.author,
      gist: body.gist,
      message_id: body.message_id,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return json({ error: "Conversation not found" }, 404);
      if (result.reason === "terminal") return json({ ok: false, reason: "terminal" }, 409);
      return json({ ok: false, reason: result.reason }, 400);
    }

    return json(result, 200);
  } catch (err) {
    console.error("[mind/conversations/turns] POST error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/conversations/:id/land   body: { resolution, landed_by }
export async function postConversationLand(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { resolution?: string; landed_by?: string };
  try {
    body = await request.json() as { resolution?: string; landed_by?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.resolution || typeof body.resolution !== "string") {
    return json({ error: "resolution is required" }, 400);
  }
  if (!body.landed_by || typeof body.landed_by !== "string") {
    return json({ error: "landed_by is required" }, 400);
  }

  try {
    const result = await landConversation(env, id, {
      resolution: body.resolution,
      landed_by: body.landed_by,
    });

    if (!result.ok) {
      if (result.reason === "not_found") return json({ error: "Conversation not found" }, 404);
      if (result.reason === "terminal") return json({ ok: false, reason: "terminal" }, 409);
      return json({ ok: false, reason: result.reason }, 400);
    }

    return json(result, 200);
  } catch (err) {
    console.error("[mind/conversations/land] POST error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/conversations/active?channel_id=
export async function getConversationActive(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const channelId = url.searchParams.get("channel_id");
  if (!channelId) return json({ error: "channel_id is required" }, 400);

  try {
    const result = await getActiveConversation(env, channelId);
    if (!result) return json({ thread: null }, 200);
    return json(result, 200);
  } catch (err) {
    console.error("[mind/conversations/active] GET error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/conversations?state=&days=&limit=
export async function listConversationsHandler(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? undefined;

  const daysParam = url.searchParams.get("days");
  const parsedDays = daysParam !== null ? parseInt(daysParam, 10) : undefined;
  const days = parsedDays !== undefined && !isNaN(parsedDays) ? parsedDays : undefined;

  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam !== null ? parseInt(limitParam, 10) : undefined;
  const limit = parsedLimit !== undefined && !isNaN(parsedLimit) ? parsedLimit : undefined;

  try {
    const conversations = await listConversations(env, { state, days, limit });
    return json({ conversations }, 200);
  } catch (err) {
    console.error("[mind/conversations] GET error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
