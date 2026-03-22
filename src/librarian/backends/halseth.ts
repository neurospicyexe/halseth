// src/librarian/backends/halseth.ts
//
// Internal D1 function calls. Imports directly from src/mcp/tools/.
// No HTTP, no MCP protocol. Zero latency.

import { Env } from "../../types.js";
import { loadSessionData, SessionLoadInput } from "../../mcp/tools/session_load.js";
import { generateId } from "../../db/queries.js";

export async function sessionLoad(env: Env, input: SessionLoadInput) {
  return loadSessionData(env, input);
}

export async function taskList(env: Env, companionId: string) {
  const tasks = await env.DB.prepare(
    "SELECT * FROM tasks WHERE (assigned_to = ? OR assigned_to IS NULL) AND status != 'done' ORDER BY priority DESC, created_at ASC LIMIT 20"
  ).bind(companionId).all();
  return tasks.results ?? [];
}

export async function handoverRead(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
  ).first();
}

export async function addCompanionNote(
  env: Env,
  from_id: string,
  to_id: string | null,
  content: string,
): Promise<{ id: string }> {
  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  )
    .bind(id, from_id, to_id, content)
    .run();
  return { id };
}
