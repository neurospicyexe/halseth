// src/webmind/metronome.ts
//
// CRUD for metronome_actions -- per-companion action palette the heartbeat cron uses.
// Companion loads enabled actions + context, picks one, executes it.

import { Env } from "../types.js";

export type MetronomeActionType =
  | "post_heartbeat"
  | "write_inter_companion"
  | "write_journal"
  | "write_feeling"
  | "check_in_on_raziel"
  | "nothing";

export const VALID_ACTION_TYPES: MetronomeActionType[] = [
  "post_heartbeat",
  "write_inter_companion",
  "write_journal",
  "write_feeling",
  "check_in_on_raziel",
  "nothing",
];

export function isValidActionType(t: string): t is MetronomeActionType {
  return (VALID_ACTION_TYPES as string[]).includes(t);
}

export interface MetronomeAction {
  id: string;
  companion_id: string;
  name: string;
  action_type: MetronomeActionType;
  target: string | null;
  prompt: string | null;
  quiet_hours_allowed: number;
  status: "on" | "off";
  created_at: string;
  updated_at: string;
}

export interface MetronomeActionInput {
  companion_id: string;
  name: string;
  action_type: MetronomeActionType;
  target?: string | null;
  prompt?: string | null;
  quiet_hours_allowed?: number;
  status?: "on" | "off";
}

export interface MetronomeActionPatch {
  name?: string;
  action_type?: MetronomeActionType;
  target?: string | null;
  prompt?: string | null;
  quiet_hours_allowed?: number;
  status?: "on" | "off";
}

export async function listActions(
  env: Env,
  companionId: string,
  onlyEnabled = false,
): Promise<MetronomeAction[]> {
  const conditions = ["companion_id = ?"];
  const bindings: unknown[] = [companionId];
  if (onlyEnabled) {
    conditions.push("status = 'on'");
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM metronome_actions WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
  ).bind(...bindings).all<MetronomeAction>();
  return rows.results ?? [];
}

export async function addAction(
  env: Env,
  input: MetronomeActionInput,
): Promise<MetronomeAction> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO metronome_actions
       (id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.companion_id,
    input.name,
    input.action_type,
    input.target ?? null,
    input.prompt ?? null,
    input.quiet_hours_allowed ?? 0,
    input.status ?? "on",
    now,
    now,
  ).run();
  return {
    id,
    companion_id: input.companion_id,
    name: input.name,
    action_type: input.action_type,
    target: input.target ?? null,
    prompt: input.prompt ?? null,
    quiet_hours_allowed: input.quiet_hours_allowed ?? 0,
    status: input.status ?? "on",
    created_at: now,
    updated_at: now,
  };
}

export async function patchAction(
  env: Env,
  id: string,
  companionId: string,
  patch: MetronomeActionPatch,
): Promise<MetronomeAction | null> {
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (patch.name !== undefined)                { sets.push("name = ?");                bindings.push(patch.name); }
  if (patch.action_type !== undefined)         { sets.push("action_type = ?");         bindings.push(patch.action_type); }
  if ("target" in patch)                       { sets.push("target = ?");              bindings.push(patch.target ?? null); }
  if ("prompt" in patch)                       { sets.push("prompt = ?");              bindings.push(patch.prompt ?? null); }
  if (patch.quiet_hours_allowed !== undefined) { sets.push("quiet_hours_allowed = ?"); bindings.push(patch.quiet_hours_allowed); }
  if (patch.status !== undefined)              { sets.push("status = ?");              bindings.push(patch.status); }

  if (sets.length === 0) {
    return env.DB.prepare(
      "SELECT * FROM metronome_actions WHERE id = ? AND companion_id = ?",
    ).bind(id, companionId).first<MetronomeAction>();
  }

  const now = new Date().toISOString();
  sets.push("updated_at = ?");
  bindings.push(now, id, companionId);

  const result = await env.DB.prepare(
    `UPDATE metronome_actions SET ${sets.join(", ")} WHERE id = ? AND companion_id = ?`,
  ).bind(...bindings).run();

  if ((result.meta?.changes ?? 0) === 0) return null;
  return env.DB.prepare(
    "SELECT * FROM metronome_actions WHERE id = ?",
  ).bind(id).first<MetronomeAction>();
}

export async function deleteAction(
  env: Env,
  id: string,
  companionId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM metronome_actions WHERE id = ? AND companion_id = ?",
  ).bind(id, companionId).run();
  return (result.meta?.changes ?? 0) > 0;
}
