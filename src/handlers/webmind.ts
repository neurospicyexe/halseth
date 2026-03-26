// src/handlers/webmind.ts
//
// HTTP route handlers for /mind/* endpoints.
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { mindOrient } from "../webmind/orient.js";
import { mindGround } from "../webmind/ground.js";
import { writeHandoff } from "../webmind/handoffs.js";
import { upsertThread } from "../webmind/threads.js";
import { addNote } from "../webmind/notes.js";
import type { WmAgentId, WmHandoffInput, WmThreadUpsertInput, WmNoteInput } from "../webmind/types.js";

const VALID_AGENT_IDS: WmAgentId[] = ["cypher", "drevan", "gaia"];

function isValidAgentId(id: string): id is WmAgentId {
  return (VALID_AGENT_IDS as string[]).includes(id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /mind/orient/:agent_id
export async function getMindOrient(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const result = await mindOrient(env, agent_id);
    return json(result);
  } catch (err) {
    console.error("[mind/orient] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/ground/:agent_id
export async function getMindGround(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const result = await mindGround(env, agent_id);
    return json(result);
  } catch (err) {
    console.error("[mind/ground] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/handoff
export async function postMindHandoff(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmHandoffInput;
  try {
    body = await request.json() as WmHandoffInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await writeHandoff(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/handoff] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/thread
export async function postMindThread(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmThreadUpsertInput;
  try {
    body = await request.json() as WmThreadUpsertInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await upsertThread(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/thread] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/note
export async function postMindNote(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmNoteInput;
  try {
    body = await request.json() as WmNoteInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const result = await addNote(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/note] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
