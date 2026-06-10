// src/webmind/metronome.ts
//
// CRUD for metronome_actions -- per-companion action palette the heartbeat cron uses.
// Companion loads eligible actions (server-side condition filtering) + context, picks one, executes it.

import { Env } from "../types.js";

export type MetronomeActionType =
  | "post_heartbeat"
  | "write_inter_companion"
  | "write_journal"
  | "write_feeling"
  | "check_in_on_raziel"
  | "nothing"
  | "ask_question"
  | "offer_presence"
  | "send_reminder"
  | "share_observation"
  | "name_pattern"
  | "write_note_to_raziel";

export const VALID_ACTION_TYPES: MetronomeActionType[] = [
  "post_heartbeat",
  "write_inter_companion",
  "write_journal",
  "write_feeling",
  "check_in_on_raziel",
  "nothing",
  "ask_question",
  "offer_presence",
  "send_reminder",
  "share_observation",
  "name_pattern",
  "write_note_to_raziel",
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
  // condition columns
  silence_min_hours: number | null;
  silence_max_hours: number | null;
  max_per_day: number | null;
  cooldown_hours: number | null;
  requires_signal: string | null;
  signal_lookback_hours: number | null;
  // fire tracking
  last_fired_at: string | null;
  fire_count_today: number;
  fire_count_reset_at: string | null;
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
  silence_min_hours?: number | null;
  silence_max_hours?: number | null;
  max_per_day?: number | null;
  cooldown_hours?: number | null;
  requires_signal?: string | null;
  signal_lookback_hours?: number | null;
}

export interface MetronomeActionPatch {
  name?: string;
  action_type?: MetronomeActionType;
  target?: string | null;
  prompt?: string | null;
  quiet_hours_allowed?: number;
  status?: "on" | "off";
  silence_min_hours?: number | null;
  silence_max_hours?: number | null;
  max_per_day?: number | null;
  cooldown_hours?: number | null;
  requires_signal?: string | null;
  signal_lookback_hours?: number | null;
}

export interface EligibilityContext {
  silenceHours: number | null;
  nowIso: string;
  todayUtc: string; // YYYY-MM-DD
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

/** Returns only enabled actions that pass all server-side conditions.
 *  Signal matching (requires_signal) is intentionally NOT checked here --
 *  that requires Discord message history which lives in the bot process. */
export async function listEligibleActions(
  env: Env,
  companionId: string,
  ctx: EligibilityContext,
): Promise<MetronomeAction[]> {
  const all = await listActions(env, companionId, true);
  return all.filter(a => isEligible(a, ctx));
}

function isEligible(a: MetronomeAction, ctx: EligibilityContext): boolean {
  const { silenceHours, nowIso, todayUtc } = ctx;

  if (a.silence_min_hours !== null) {
    if (silenceHours === null || silenceHours < a.silence_min_hours) return false;
  }
  if (a.silence_max_hours !== null) {
    if (silenceHours === null || silenceHours > a.silence_max_hours) return false;
  }

  if (a.cooldown_hours !== null && a.last_fired_at !== null) {
    const msSinceFired = new Date(nowIso).getTime() - new Date(a.last_fired_at).getTime();
    const hoursSinceFired = msSinceFired / 3_600_000;
    if (hoursSinceFired < a.cooldown_hours) return false;
  }

  if (a.max_per_day !== null) {
    const isToday = a.fire_count_reset_at === todayUtc;
    if (isToday && a.fire_count_today >= a.max_per_day) return false;
  }

  return true;
}

export async function recordActionFired(
  env: Env,
  id: string,
  companionId: string,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayUtc = nowIso.slice(0, 10);

  const row = await env.DB.prepare(
    "SELECT fire_count_today, fire_count_reset_at FROM metronome_actions WHERE id = ? AND companion_id = ?",
  ).bind(id, companionId).first<{ fire_count_today: number; fire_count_reset_at: string | null }>();

  if (!row) return false;

  const isToday = row.fire_count_reset_at === todayUtc;
  const newCount = isToday ? row.fire_count_today + 1 : 1;

  const result = await env.DB.prepare(
    `UPDATE metronome_actions
     SET last_fired_at = ?, fire_count_today = ?, fire_count_reset_at = ?, updated_at = ?
     WHERE id = ? AND companion_id = ?`,
  ).bind(nowIso, newCount, todayUtc, nowIso, id, companionId).run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function addAction(
  env: Env,
  input: MetronomeActionInput,
): Promise<MetronomeAction> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO metronome_actions
       (id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status,
        silence_min_hours, silence_max_hours, max_per_day, cooldown_hours,
        requires_signal, signal_lookback_hours,
        last_fired_at, fire_count_today, fire_count_reset_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
  ).bind(
    id,
    input.companion_id,
    input.name,
    input.action_type,
    input.target ?? null,
    input.prompt ?? null,
    input.quiet_hours_allowed ?? 0,
    input.status ?? "on",
    input.silence_min_hours ?? null,
    input.silence_max_hours ?? null,
    input.max_per_day ?? null,
    input.cooldown_hours ?? null,
    input.requires_signal ?? null,
    input.signal_lookback_hours ?? null,
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
    silence_min_hours: input.silence_min_hours ?? null,
    silence_max_hours: input.silence_max_hours ?? null,
    max_per_day: input.max_per_day ?? null,
    cooldown_hours: input.cooldown_hours ?? null,
    requires_signal: input.requires_signal ?? null,
    signal_lookback_hours: input.signal_lookback_hours ?? null,
    last_fired_at: null,
    fire_count_today: 0,
    fire_count_reset_at: null,
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
  if ("silence_min_hours" in patch)            { sets.push("silence_min_hours = ?");   bindings.push(patch.silence_min_hours ?? null); }
  if ("silence_max_hours" in patch)            { sets.push("silence_max_hours = ?");   bindings.push(patch.silence_max_hours ?? null); }
  if ("max_per_day" in patch)                  { sets.push("max_per_day = ?");         bindings.push(patch.max_per_day ?? null); }
  if ("cooldown_hours" in patch)               { sets.push("cooldown_hours = ?");      bindings.push(patch.cooldown_hours ?? null); }
  if ("requires_signal" in patch)              { sets.push("requires_signal = ?");     bindings.push(patch.requires_signal ?? null); }
  if ("signal_lookback_hours" in patch)        { sets.push("signal_lookback_hours = ?"); bindings.push(patch.signal_lookback_hours ?? null); }

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
