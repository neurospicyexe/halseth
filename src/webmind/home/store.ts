// src/webmind/home/store.ts
import { Env } from "../../types.js";
import { CompanionId, HomePresence, HomeEvent, HomeEventType } from "../types.js";

const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];
export function allCompanions(): CompanionId[] { return COMPANIONS; }

export async function getPresence(env: Env, id: CompanionId): Promise<HomePresence | null> {
  return env.DB.prepare(
    "SELECT * FROM home_presence WHERE companion_id = ?",
  ).bind(id).first<HomePresence>();
}

export async function upsertPresence(
  env: Env, id: CompanionId, room: string, activity: string, basinDistance: number,
  withCompanion: string | null = null, microMood: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO home_presence (companion_id, current_room, activity, micro_mood, with_companion, basin_distance, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(companion_id) DO UPDATE SET
       current_room = excluded.current_room, activity = excluded.activity,
       micro_mood = excluded.micro_mood, with_companion = excluded.with_companion,
       basin_distance = excluded.basin_distance, updated_at = excluded.updated_at`,
  ).bind(id, room, activity, microMood, withCompanion, basinDistance, now).run();
}

export async function appendEvent(
  env: Env, id: CompanionId, type: HomeEventType, room: string, text: string,
  withCompanion: string | null = null,
): Promise<string> {
  const eventId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO home_events (id, companion_id, event_type, room, with_companion, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(eventId, id, type, room, withCompanion, text).run();
  return eventId;
}

/** Unsurfaced events for orient's "while you were away" block. Marks them surfaced. */
export async function takeUnsurfacedEvents(env: Env, id: CompanionId, limit = 5): Promise<HomeEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM home_events WHERE companion_id = ? AND surfaced_at IS NULL
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(id, limit).all<HomeEvent>();
  const events = rows.results ?? [];
  if (events.length > 0) {
    const now = new Date().toISOString();
    const ids = events.map(e => e.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE home_events SET surfaced_at = ? WHERE id IN (${placeholders})`,
    ).bind(now, ...ids).run();
  }
  return events;
}

export async function recentEvents(env: Env, id: CompanionId, limit = 20): Promise<HomeEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM home_events WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(id, limit).all<HomeEvent>();
  return rows.results ?? [];
}

export interface BasinReading { driftScore: number; driftType: "stable" | "growth" | "pressure"; }

export async function latestBasin(env: Env, id: CompanionId): Promise<BasinReading> {
  const row = await env.DB.prepare(
    `SELECT drift_score, drift_type FROM companion_basin_history
     WHERE companion_id = ? ORDER BY recorded_at DESC LIMIT 1`,
  ).bind(id).first<{ drift_score: number; drift_type: string }>();
  if (!row) return { driftScore: 0, driftType: "stable" };
  const t = row.drift_type === "growth" || row.drift_type === "pressure" ? row.drift_type : "stable";
  return { driftScore: row.drift_score ?? 0, driftType: t as BasinReading["driftType"] };
}

export async function getConfig(env: Env, id: CompanionId, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?",
  ).bind(id, key).first<{ value: string }>();
  return row?.value ?? fallback;
}
