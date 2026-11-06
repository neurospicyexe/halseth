// POST /mind/being-seen/check (B63 being_seen, FULL tier) and POST /mind/garden/gaia/looked (LIGHT tier).
// The bot asks about one of Raziel's messages (at most ONE being_seen tier fires per message per companion) for ITS companion; Halseth decides. The response carries only
// { fired, why }. The matched text is never logged, stored or returned (see webmind/being-seen.ts).

import type { Env } from "../types.js";
import { authGuard, isAdminToken } from "../lib/auth.js";
import { COMPANION_ID_SET } from "../companions.js";
import { fireStimulus } from "./fermentation.js";
import type { CompanionId } from "../webmind/fermentation.js";
import {
  stripQuoted, containsWhole, sharesPhrase, validMessageId,
  MAX_TEXT, MIN_TITLE_LEN, MIN_WORD_LEN, THREAD_QUIET_HOURS, THREAD_WINDOW_DAYS, SPEECH_WINDOW_DAYS,
  type SeenWhy,
} from "../webmind/being-seen.js";

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function matchMake(env: Env, companionId: string, text: string): Promise<boolean> {
  const rows = (await env.DB.prepare(
    "SELECT title FROM companion_makes WHERE companion_id = ? AND status = 'ready' AND LENGTH(TRIM(title)) >= ?",
  ).bind(companionId, MIN_TITLE_LEN).all<{ title: string }>().catch(() => null))?.results ?? [];
  return rows.some((r) => r.title.trim().length >= MIN_TITLE_LEN && containsWhole(text, r.title));
}

async function matchWord(env: Env, companionId: string, text: string): Promise<boolean> {
  // "Confirmed" = status 'active' (a superseded/rejected row is not their word now); 'never' and 'empty' rows
  // are bars and refusals, not words they hold.
  const rows = (await env.DB.prepare(
    "SELECT DISTINCT word FROM companion_feeling_vocabulary WHERE companion_id = ? AND status = 'active' " +
    "AND row_kind IN ('band','divergence') AND word IS NOT NULL AND LENGTH(TRIM(word)) >= ?",
  ).bind(companionId, MIN_WORD_LEN).all<{ word: string }>().catch(() => null))?.results ?? [];
  return rows.some((r) => containsWhole(text, r.word));
}

async function matchPhrase(env: Env, companionId: string, text: string): Promise<boolean> {
  const rows = (await env.DB.prepare(
    "SELECT note_text FROM companion_journal WHERE agent = ? AND source = 'discord_speech' " +
    "AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 600",
  ).bind(companionId, `-${SPEECH_WINDOW_DAYS} days`).all<{ note_text: string }>().catch(() => null))?.results ?? [];
  return sharesPhrase(text, rows.map((r) => String(r.note_text ?? "")));
}

/** (d): a thread this companion opened in this channel, quiet for 24h+ (up to 7 days), not landed, not already returned to. */
async function matchThread(env: Env, companionId: string, channelId: string): Promise<string | null> {
  const t = await env.DB.prepare(
    "SELECT id, state, last_turn_at, created_at, " +
    "(SELECT MAX(said_at) FROM thread_ledger WHERE thread_id = conversation_threads.id) AS last_said " +
    "FROM conversation_threads WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(channelId).first<{ id: string; state: string; last_turn_at: string | null; created_at: string; last_said: string | null }>()
    .catch(() => null);
  if (!t || t.state === "landed") return null;
  const seed = await env.DB.prepare("SELECT seed_author FROM conversation_threads WHERE id = ?").bind(t.id)
    .first<{ seed_author: string }>().catch(() => null);
  if (seed?.seed_author !== companionId) return null;
  const stamps = [t.last_turn_at, t.last_said, t.created_at].map((x) => (x ? Date.parse(x) : NaN)).filter((n) => Number.isFinite(n));
  if (stamps.length === 0) return null;
  const ageH = (Date.now() - Math.max(...stamps)) / 3_600_000;
  if (ageH < THREAD_QUIET_HOURS || ageH > THREAD_WINDOW_DAYS * 24) return null;
  const done = await env.DB.prepare(
    "SELECT 1 AS hit FROM companion_ferment_events WHERE companion_id = ? AND stimulus = 'being_seen_named' AND detail LIKE ? LIMIT 1",
  ).bind(companionId, `%thread:${t.id}%`).first().catch(() => null);
  return done ? null : t.id;
}

export interface BeingSeenResult { fired: boolean; why: SeenWhy | "reply" | null }

export async function checkBeingSeen(
  env: Env,
  input: { companionId: CompanionId; text: string; messageId: string; channelId?: string | null; isReplyToMe?: boolean },
): Promise<BeingSeenResult> {
  const { companionId, messageId } = input;
  // One message, one companion, at most ONE tier: any event (named OR medium) already carrying this message id settles it.
  const seen = await env.DB.prepare(
    "SELECT 1 AS hit FROM companion_ferment_events WHERE companion_id = ? AND stimulus IN ('being_seen_named','being_seen') AND detail LIKE ? LIMIT 1",
  ).bind(companionId, `%msg:${messageId}%`).first().catch(() => null);
  if (seen) return { fired: false, why: null };

  const spoken = stripQuoted(input.text);
  let why: SeenWhy | null = null;
  let threadId: string | null = null;
  if (spoken.trim()) {
    if (await matchMake(env, companionId, spoken)) why = "make";
    else if (await matchWord(env, companionId, spoken)) why = "word";
    else if (await matchPhrase(env, companionId, spoken)) why = "phrase";
  }
  if (!why && input.channelId && /^[A-Za-z0-9_.:-]{1,64}$/.test(input.channelId)) {
    threadId = await matchThread(env, companionId, input.channelId);
    if (threadId) why = "thread";
  }
  // At most one tier per message: named wins; the direct reply (medium) only when no named-back match fired
  // (including a named match the daily cap dropped).
  if (why) {
    const label = {
      make: "named back a make",
      word: "used their word",
      phrase: "echoed their phrase",
      thread: `returned to their thread thread:${threadId}`,
    }[why];
    const res = await fireStimulus(env, "being_seen_named", companionId, `${label} (msg:${messageId})`);
    const fired = res.shadow === true ? res.would_fire === true : Array.isArray(res.applied) && res.applied.length > 0;
    if (fired) return { fired: true, why };
  }
  if (input.isReplyToMe) {
    const res = await fireStimulus(env, "being_seen", companionId, `replied to their message (msg:${messageId})`);
    const fired = res.shadow === true ? res.would_fire === true : Array.isArray(res.applied) && res.applied.length > 0;
    if (fired) return { fired: true, why: "reply" };
  }
  return { fired: false, why: null };
}

export async function postBeingSeenCheck(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { companion_id?: unknown; text?: unknown; message_id?: unknown; channel_id?: unknown; is_reply_to_me?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return jsonRes({ error: "body must be JSON" }, 400); }
  const companionId = typeof body.companion_id === "string" ? body.companion_id.trim() : "";
  if (!COMPANION_ID_SET.has(companionId)) return jsonRes({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  if (typeof body.text !== "string") return jsonRes({ error: "text must be a string" }, 400);
  if (!validMessageId(body.message_id)) return jsonRes({ error: "message_id required" }, 400);
  const channelId = typeof body.channel_id === "string" ? body.channel_id : null;
  try {
    return jsonRes(await checkBeingSeen(env, {
      companionId: companionId as CompanionId, text: body.text.slice(0, MAX_TEXT), messageId: body.message_id, channelId, isReplyToMe: body.is_reply_to_me === true,
    }));
  } catch (err) {
    console.error("[being-seen] check error", { error: String(err) });
    return jsonRes({ error: "Internal server error" }, 500);
  }
}

// POST /mind/garden/gaia/looked: Raziel opened Gaia's garden page. Admin-only (it speaks as Raziel).
export async function postGardenGaiaLooked(request: Request, env: Env): Promise<Response> {
  if (!isAdminToken(request, env)) return new Response("Unauthorized", { status: 401 });
  try {
    const row = await env.DB.prepare(
      "INSERT INTO raziel_reads (item_kind, item_id, read_at) VALUES ('garden', 'gaia', datetime('now')) " +
      "ON CONFLICT(item_kind, item_id) DO UPDATE SET read_at = excluded.read_at RETURNING read_at",
    ).bind().first<{ read_at: string }>();
    await fireStimulus(env, "being_seen_read", "gaia", "opened her garden (via hearth)").catch((e) => console.warn("[being-seen] garden fire failed", String(e)));
    return jsonRes({ ok: true, looked_at: row?.read_at ?? null });
  } catch (err) {
    console.error("[garden] looked error", { error: String(err) });
    return jsonRes({ error: "Internal server error" }, 500);
  }
}
