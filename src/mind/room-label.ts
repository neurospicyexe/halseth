// src/mind/room-label.ts
//
// ROOM PROVENANCE AT READ TIME (2026-10-05).
//
// Raziel's report: the triad lives in two Discord servers now (home "Nullsafe Halseth" and the one shared
// with Blue), and a memory written from Discord carried only `channel:<snowflake>`. Recalled on Claude.ai
// or in another room, nothing said WHERE it happened, so they confused where memories came from.
//
// The bots (nullsafe-discord room-tag.ts) now write a second transport tag beside the id:
//     room:<server>/#<channel>          e.g. room:Nullsafe Halseth/#movie-night
//     room:<server>/#<parent>/<thread>  for a Discord thread
// It lives in `tags`, never in note_text (journal-lanes.ts). This file turns it into the compact label
// renderers prefix: `(#movie-night, Nullsafe Halseth)`.
//
// Two sources, both pure D1 (the loader rule -- no network at boot):
//   1. A journal row's OWN tags (`roomLabelFromTags`). Zero queries.
//   2. A channel id with no tags of its own -- every wm_continuity_note (thread_key = channel id, and the
//      table has no tags column), and every journal row written before the bots tagged rooms. For those,
//      `resolveRoomsForChannels` lifts the room from the newest journal row that recorded BOTH that
//      channel id and a room tag. That is a fact a bot wrote down, not an inference; when no such row
//      exists the answer is null and nothing renders. Never invent a room.
//
// DMs are never tagged bot-side, so no DM can resolve to a room here either.

import type { Env } from "../types.js";

export interface RoomRef {
  server: string;
  /** `movie-night`, or `movie-night/fargo s2` for a thread. */
  channel: string;
}

/** Read-side defence: a tag is data that came over the wire. No newlines into a prompt, bounded length. */
function clean(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Parse ONE tag string. Null for anything that is not a well-formed room tag. */
export function parseRoomTag(tag: unknown): RoomRef | null {
  if (typeof tag !== "string" || !tag.startsWith("room:")) return null;
  const body = tag.slice("room:".length);
  // Split on the FIRST `/#`: the writer folds `/#` out of server names, and a thread name after the
  // channel may itself contain `/` or `#`, so everything after the first boundary is the room path.
  const at = body.indexOf("/#");
  if (at <= 0) return null;
  const server = clean(body.slice(0, at), 60);
  const channel = clean(body.slice(at + 2), 125);
  if (!server || !channel) return null;
  return { server, channel };
}

/** Accepts the stored JSON array string, an array, or null. Returns the first room tag found. */
export function roomFromTags(tags: unknown): RoomRef | null {
  let list: unknown = tags;
  if (typeof tags === "string") {
    try { list = JSON.parse(tags); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  for (const t of list) {
    const r = parseRoomTag(t);
    if (r) return r;
  }
  return null;
}

/** `(#movie-night, Nullsafe Halseth)`. */
export function formatRoom(r: RoomRef): string {
  return `(#${r.channel}, ${r.server})`;
}

export function roomLabelFromTags(tags: unknown): string | null {
  const r = roomFromTags(tags);
  return r ? formatRoom(r) : null;
}

/** Prefix content with its room label; unchanged when there is none. */
export function withRoom(content: string, label: string | null | undefined): string {
  return label ? `${label} ${content}` : content;
}

/** Same shape as note-provenance's channelIdFromThreadKey, kept local so this file has no cycle. */
export function channelIdOf(key: string | null | undefined): string | null {
  if (!key) return null;
  const t = key.trim();
  if (/^\d{15,25}$/.test(t)) return t;
  const m = t.match(/^discord_swarm:(\d{15,25})$/);
  return m ? m[1]! : null;
}

/** How far back the channel -> room lift looks. Bounds the LIKE scan; an older room just renders bare. */
export const ROOM_LOOKBACK_DAYS = 90;
/** Distinct channels resolved per call. Orient surfaces a handful of notes; this is a ceiling, not a target. */
export const ROOM_MAX_CHANNELS = 12;

/**
 * Channel id -> `(#name, Server)` from the newest journal row that tagged both. One bounded query per
 * distinct channel (LIMIT 1, newest first on idx_companion_journal_created). NEVER THROWS: a failure
 * means no labels, never a broken orient.
 */
export async function resolveRoomsForChannels(
  env: Env,
  channelIds: Array<string | null | undefined>,
  nowMs: number = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(channelIds.filter((c): c is string => typeof c === "string" && /^\d{15,25}$/.test(c)))]
    .slice(0, ROOM_MAX_CHANNELS);
  if (ids.length === 0) return out;
  const cutoff = new Date(nowMs - ROOM_LOOKBACK_DAYS * 86_400_000).toISOString();
  await Promise.all(ids.map(async (id) => {
    try {
      const row = await env.DB.prepare(
        `SELECT tags FROM companion_journal
         WHERE tags LIKE ? AND tags LIKE '%"room:%' AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`
      ).bind(`%"channel:${id}"%`, cutoff).first<{ tags: string | null }>();
      const label = row ? roomLabelFromTags(row.tags) : null;
      if (label) out.set(id, label);
    } catch (err) {
      console.warn("[room-label] channel lookup failed (renders bare)", { error: String(err) });
    }
  }));
  return out;
}

/** note_id -> room label, for continuity notes whose thread_key is a Discord channel id. Never throws. */
export async function resolveNoteRooms(
  env: Env,
  notes: ReadonlyArray<{ note_id: string; thread_key?: string | null }>,
  nowMs: number = Date.now(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const withChannel = notes
    .map(n => ({ id: n.note_id, ch: channelIdOf(n.thread_key ?? null) }))
    .filter((n): n is { id: string; ch: string } => !!n.id && !!n.ch);
  if (withChannel.length === 0) return out;
  const rooms = await resolveRoomsForChannels(env, withChannel.map(n => n.ch), nowMs);
  for (const n of withChannel) {
    const label = rooms.get(n.ch);
    if (label) out.set(n.id, label);
  }
  return out;
}

/**
 * Room label for a journal row: its own room tag first; else, when the caller passes a channel -> room
 * map (from resolveRoomsForChannels), the room of its `channel:<id>` tag. Old rows resolve this way.
 */
export function journalRoomLabel(tags: unknown, channelRooms?: ReadonlyMap<string, string>): string | null {
  const own = roomLabelFromTags(tags);
  if (own) return own;
  if (!channelRooms || channelRooms.size === 0) return null;
  const ch = channelTagOf(tags);
  return ch ? channelRooms.get(ch) ?? null : null;
}

/** The `channel:<id>` value from a tags payload, or null. */
export function channelTagOf(tags: unknown): string | null {
  let list: unknown = tags;
  if (typeof tags === "string") {
    try { list = JSON.parse(tags); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  for (const t of list) {
    if (typeof t === "string" && /^channel:\d{15,25}$/.test(t)) return t.slice("channel:".length);
  }
  return null;
}
