// src/webmind/home/rooms.ts
import { Env } from "../../types.js";
import { HomeRoom, CompanionId } from "../types.js";


export const HOME_ROOM: Record<CompanionId, string> = {
  cypher: "study",
  drevan: "vowbed",
  gaia:   "grove",
};

export const HOME_CONFIG_DEFAULTS: Record<string, string> = {
  home_tick_cadence_min: "30",
  home_texture_model: "none",
  home_texture_min_interval_min: "120",
};

export async function getRooms(env: Env): Promise<HomeRoom[]> {
  const rows = await env.DB.prepare(
    "SELECT key, name, sym, register, primary_lane, gradient FROM home_rooms ORDER BY key",
  ).all<HomeRoom>();
  return rows.results ?? [];
}

/** Rooms a companion may OPERATE in: their own lane or commons (null). */
export function laneLegalRooms(rooms: HomeRoom[], companionId: CompanionId): HomeRoom[] {
  return rooms.filter(r => r.primary_lane === companionId || r.primary_lane === null);
}
