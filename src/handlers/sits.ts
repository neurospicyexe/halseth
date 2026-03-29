// src/handlers/sits.ts
//
// HTTP route handlers for Sit & Resolve endpoints.
// POST /mind/note/:id/sit        — mark note as sitting, record reflection
// POST /mind/note/:id/metabolize — mark note as metabolized
// GET  /mind/sitting/:agent_id   — get sitting notes for a companion

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { sitNote, metabolizeNote, readSittingNotes } from "../webmind/sits.js";
import type { WmAgentId, WmSitInput } from "../webmind/types.js";

const VALID_AGENT_IDS: WmAgentId[] = ["cypher", "drevan", "gaia"];
const MAX_TEXT_LENGTH = 8000;

function isValidAgentId(id: string): id is WmAgentId {
  return (VALID_AGENT_IDS as string[]).includes(id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /mind/note/:id/sit
export async function postNoteSit(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "note id is required" }, 400);

  let body: { companion_id: string; sit_text?: string };
  try {
    body = await request.json() as { companion_id: string; sit_text?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (body.sit_text !== undefined && typeof body.sit_text !== "string") {
    return json({ error: "sit_text must be a string" }, 400);
  }
  if (typeof body.sit_text === "string" && body.sit_text.length > MAX_TEXT_LENGTH) {
    return json({ error: `sit_text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
  }

  try {
    const input: WmSitInput = {
      note_id: id,
      companion_id: body.companion_id,
      sit_text: body.sit_text,
    };
    const result = await sitNote(env, input);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/note/sit] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/note/:id/metabolize
export async function postNoteMetabolize(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "note id is required" }, 400);

  let body: { companion_id: string };
  try {
    body = await request.json() as { companion_id: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }

  try {
    const result = await metabolizeNote(env, id, body.companion_id);
    return json(result);
  } catch (err) {
    console.error("[mind/note/metabolize] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/sitting/:agent_id
export async function getSittingNotes(
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

  const url = new URL(request.url);
  const stale_only = url.searchParams.get("stale_only") === "true";
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 10 : rawLimit), 50);

  try {
    const notes = await readSittingNotes(env, agent_id, { stale_only, limit });
    return json({ notes });
  } catch (err) {
    console.error("[mind/sitting] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
