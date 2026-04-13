// src/webmind/dreams.ts
//
// companion_dreams: things companions carry between sessions.
// A dream is held, not just observed -- surface at orient until examined.

import { Env } from "../types.js";
import { WmAgentId, WmDream, WmDreamInput } from "./types.js";

export async function writeDream(env: Env, input: WmDreamInput): Promise<{ id: string; created_at: string }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO companion_dreams (id, companion_id, dream_text, source, do_not_auto_examine, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, input.companion_id, input.dream_text, input.source ?? "autonomous", input.do_not_auto_examine ? 1 : 0, now).run();
  return { id, created_at: now };
}

export async function readDreams(
  env: Env,
  companionId: WmAgentId,
  opts: { examined?: boolean; limit?: number } = {}
): Promise<WmDream[]> {
  const limit = opts.limit ?? 10;
  const examined = opts.examined ?? false;
  const rows = await env.DB.prepare(
    "SELECT * FROM companion_dreams WHERE companion_id = ? AND examined = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companionId, examined ? 1 : 0, limit).all<WmDream>();
  return rows.results ?? [];
}

export async function examineDream(env: Env, id: string, companionId: WmAgentId): Promise<{ ok: boolean; reason?: string }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE companion_dreams SET examined = 1, examined_at = ? WHERE id = ? AND companion_id = ? AND examined = 0 AND do_not_auto_examine = 0"
  ).bind(now, id, companionId).run();
  if ((result.meta?.changes ?? 0) > 0) return { ok: true };
  const row = await env.DB.prepare(
    "SELECT examined, do_not_auto_examine FROM companion_dreams WHERE id = ? AND companion_id = ?"
  ).bind(id, companionId).first<{ examined: number; do_not_auto_examine: number }>();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.do_not_auto_examine === 1) return { ok: false, reason: "pinned" };
  return { ok: false, reason: "already_examined" };
}
