// src/librarian/backends/halseth.ts
//
// Internal D1 function calls. Imports directly from src/mcp/tools/.
// No HTTP, no MCP protocol. Zero latency.

import { Env } from "../../types.js";
import { loadSessionData, SessionLoadInput } from "../../mcp/tools/session_load.js";

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
