// src/handlers/watchalong.ts
//
// Watchalong (migration 0142, spec docs/SPEC-watchalong-2026-10-02.md): the triad follows a film with
// Raziel through its CAPTION TRACK, cut at a playhead so nothing past where he is reaches them.
//
//   POST  /mind/watchalong                -- load a film's cues into a new session for a channel
//   PATCH /mind/watchalong/:id            -- play / pause / seek ("cy: at 47:12") / end
//   GET   /mind/watchalong/active         -- the channel's live session + the cues up to the playhead
//
// The clock is SERVER-SIDE. While 'playing', playhead = playhead_sec + (now - playhead_set_at), so
// Raziel types nothing while the film runs; every `at` is a resync, not a report. That one rule lives
// in computePlayhead() and every route goes through it.
//
// The cut is the load-bearing property: GET /active never returns a cue whose start_sec is past the
// computed playhead. Bots request deltas (since_sec = what they last delivered), so the transcript
// accumulates the film without duplicates.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const WATCHALONG_SOURCES = new Set<string>(["attachment", "opensubtitles", "youtube"]);
export const WATCHALONG_STATUSES = new Set<string>(["playing", "paused", "ended"]);
export const CUE_KINDS = new Set<string>(["line", "sound", "music"]);

export const MAX_CUES = 6000;
export const MAX_CUE_TEXT = 500;
export const MAX_TITLE = 200;
const DEFAULT_ACTIVE_CUES = 80;
const MAX_ACTIVE_CUES = 300;
/** D1 caps a batch; one prepared statement per cue keeps every statement far under 100 binds. */
const BATCH_SIZE = 100;

export interface PlayheadRow {
  status: string;
  playhead_sec: number;
  playhead_set_at: string;
  duration_sec: number | null;
}

/** Parse a stored timestamp. JS writes ISO ("...T...Z"); the schema default writes SQLite's
 *  "YYYY-MM-DD HH:MM:SS" (UTC, no zone), which Date.parse would read as LOCAL time -- normalise it. */
export function parseStoredTime(s: string | null | undefined): number {
  if (!s) return Number.NaN;
  const t = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
  return Date.parse(t);
}

/** The one clock. Playing advances from the last set point; paused/ended hold. Clamped to
 *  [0, duration_sec] (no upper clamp when duration is unknown). An unparseable or future set point
 *  counts as zero elapsed rather than jumping the playhead. */
export function computePlayhead(row: PlayheadRow, nowMs: number): number {
  let p = Number(row.playhead_sec) || 0;
  if (row.status === "playing") {
    const setAt = parseStoredTime(row.playhead_set_at);
    const elapsed = Number.isFinite(setAt) ? (nowMs - setAt) / 1000 : 0;
    if (elapsed > 0) p += elapsed;
  }
  return clampPlayhead(p, row.duration_sec);
}

function clampPlayhead(p: number, duration: number | null): number {
  let out = Math.max(0, p);
  if (duration !== null && duration !== undefined && Number.isFinite(Number(duration))) out = Math.min(out, Number(duration));
  return out;
}

function nonNegFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function optStr(v: unknown, cap: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
}

type SessionRow = PlayheadRow & {
  id: string; channel_id: string; title: string; shelf_id: string | null; source: string;
  source_ref: string | null; cue_count: number; started_by: string | null; created_at: string; ended_at: string | null;
};

/** The session as every route returns it: the stored row with the COMPUTED playhead. */
function sessionView(row: SessionRow, nowMs: number) {
  return {
    id: row.id,
    channel_id: row.channel_id,
    title: row.title,
    status: row.status,
    playhead_sec: computePlayhead(row, nowMs),
    duration_sec: row.duration_sec,
    cue_count: row.cue_count,
    source: row.source,
    shelf_id: row.shelf_id,
    ended_at: row.ended_at,
  };
}

interface CueIn { start_sec: number; end_sec: number; kind: string; speaker: string | null; text: string }

// POST /mind/watchalong  { title, channel_id, source, source_ref?, duration_sec?, started_by?, cues:[...] }
export async function postWatchalong(request: Request, env: Env, nowMs: number = Date.now()): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: Record<string, unknown>;
  try { b = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }

  const title = typeof b["title"] === "string" ? b["title"].trim() : "";
  if (!title) return json({ error: "title is required" }, 400);
  if (title.length > MAX_TITLE) return json({ error: `title must be at most ${MAX_TITLE} chars` }, 400);
  const channelId = typeof b["channel_id"] === "string" ? b["channel_id"].trim() : "";
  if (!channelId) return json({ error: "channel_id is required" }, 400);
  const source = typeof b["source"] === "string" ? b["source"] : "";
  if (!WATCHALONG_SOURCES.has(source)) return json({ error: "source must be attachment|opensubtitles|youtube" }, 400);
  const sourceRef = optStr(b["source_ref"], 500);
  const startedBy = optStr(b["started_by"], 100);

  let durationIn: number | null = null;
  if (b["duration_sec"] !== undefined && b["duration_sec"] !== null) {
    if (!nonNegFinite(b["duration_sec"]) || b["duration_sec"] === 0) return json({ error: "duration_sec must be a positive finite number" }, 400);
    durationIn = b["duration_sec"];
  }

  const rawCues = b["cues"];
  if (!Array.isArray(rawCues) || rawCues.length === 0) return json({ error: "cues must be a non-empty array" }, 400);
  if (rawCues.length > MAX_CUES) return json({ error: `too many cues (max ${MAX_CUES})` }, 400);

  const cues: CueIn[] = [];
  for (let i = 0; i < rawCues.length; i++) {
    const c = rawCues[i] as Record<string, unknown> | null;
    if (!c || typeof c !== "object") return json({ error: `cue ${i}: not an object` }, 400);
    if (!nonNegFinite(c["start_sec"]) || !nonNegFinite(c["end_sec"])) {
      return json({ error: `cue ${i}: start_sec and end_sec must be finite non-negative numbers` }, 400);
    }
    if (typeof c["kind"] !== "string" || !CUE_KINDS.has(c["kind"])) return json({ error: `cue ${i}: kind must be line|sound|music` }, 400);
    const text = typeof c["text"] === "string" ? c["text"].trim().slice(0, MAX_CUE_TEXT) : "";
    if (!text) return json({ error: `cue ${i}: text is required` }, 400);
    // A cue that ends before it starts is a timing glitch in the caption file, not a reason to refuse
    // the film on movie night: it becomes a zero-length cue at its start.
    const start = c["start_sec"];
    cues.push({ start_sec: start, end_sec: Math.max(start, c["end_sec"]), kind: c["kind"], speaker: optStr(c["speaker"], 100), text });
  }

  const duration = durationIn ?? cues.reduce((m, c) => Math.max(m, c.end_sec), 0);
  const id = crypto.randomUUID().replace(/-/g, "");
  const nowIso = new Date(nowMs).toISOString();

  try {
    // Exact case-insensitive title only: a LIKE fallback would tie a film to the wrong shelf row.
    const shelf = await env.DB.prepare(
      "SELECT id FROM watch_shelf WHERE lower(title) = lower(?) LIMIT 1"
    ).bind(title).first<{ id: string }>();
    const shelfId = shelf?.id ?? null;

    const insertCue = (c: CueIn, idx: number) => env.DB.prepare(
      `INSERT INTO watchalong_cues (session_id, idx, start_sec, end_sec, kind, speaker, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, idx, c.start_sec, c.end_sec, c.kind, c.speaker, c.text);

    // Batch 1 ends the channel's prior session(s) and creates this one with the first cues, atomically.
    const head = [
      env.DB.prepare(
        "UPDATE watchalong_sessions SET status = 'ended', ended_at = ? WHERE channel_id = ? AND status != 'ended'"
      ).bind(nowIso, channelId),
      env.DB.prepare(
        `INSERT INTO watchalong_sessions (id, channel_id, title, shelf_id, source, source_ref, status,
           playhead_sec, playhead_set_at, duration_sec, cue_count, started_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'paused', 0, ?, ?, ?, ?, ?)`
      ).bind(id, channelId, title, shelfId, source, sourceRef, nowIso, duration, cues.length, startedBy, nowIso),
    ];
    const firstN = BATCH_SIZE - head.length;
    await env.DB.batch([...head, ...cues.slice(0, firstN).map((c, i) => insertCue(c, i))]);

    try {
      for (let off = firstN; off < cues.length; off += BATCH_SIZE) {
        await env.DB.batch(cues.slice(off, off + BATCH_SIZE).map((c, i) => insertCue(c, off + i)));
      }
    } catch (err) {
      // A half-loaded film would cut the triad off mid-way with no error anywhere. Remove it entirely
      // (explicitly, not trusting cascade). The prior session stays ended: a new start was asked for.
      console.error("[mind/watchalong] cue insert failed, rolling back session", { id, error: String(err) });
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM watchalong_cues WHERE session_id = ?").bind(id),
          env.DB.prepare("DELETE FROM watchalong_sessions WHERE id = ?").bind(id),
        ]);
      } catch (e2) {
        console.error("[mind/watchalong] rollback failed", { id, error: String(e2) });
      }
      return json({ error: "Internal server error" }, 500);
    }

    return json({ id, cue_count: cues.length, duration_sec: duration, shelf_id: shelfId }, 201);
  } catch (err) {
    console.error("[mind/watchalong] create error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/watchalong/:id  { status?: 'playing'|'paused'|'ended', at_sec?: number }
export async function patchWatchalong(request: Request, env: Env, id: string, nowMs: number = Date.now()): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: Record<string, unknown>;
  try { b = await request.json() as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }

  let status: string | null = null;
  if (b["status"] !== undefined) {
    if (typeof b["status"] !== "string" || !WATCHALONG_STATUSES.has(b["status"])) return json({ error: "status must be playing|paused|ended" }, 400);
    status = b["status"];
  }
  let atSec: number | null = null;
  if (b["at_sec"] !== undefined) {
    if (typeof b["at_sec"] !== "number" || !Number.isFinite(b["at_sec"])) return json({ error: "at_sec must be a finite number" }, 400);
    atSec = b["at_sec"];
  }
  if (status === null && atSec === null) return json({ error: "provide status and/or at_sec" }, 400);

  try {
    const row = await env.DB.prepare("SELECT * FROM watchalong_sessions WHERE id = ?").bind(id).first<SessionRow>();
    if (!row) return json({ error: "not found" }, 404);
    if (row.status === "ended") return json({ error: "session already ended" }, 409);

    // Materialise the running clock FIRST, then seek: pausing must freeze where the film actually is,
    // not where it was last set.
    const current = computePlayhead(row, nowMs);
    const playhead = atSec !== null ? clampPlayhead(atSec, row.duration_sec) : current;
    const nextStatus = status ?? row.status;
    const nowIso = new Date(nowMs).toISOString();

    const res = await env.DB.prepare(
      `UPDATE watchalong_sessions
         SET status = ?, playhead_sec = ?, playhead_set_at = ?,
             ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END
       WHERE id = ? AND status != 'ended'`
    ).bind(nextStatus, playhead, nowIso, nextStatus, nowIso, id).run();
    // Lost a race with another PATCH that ended it.
    if (!res.meta.changes) return json({ error: "session already ended" }, 409);

    const updated = await env.DB.prepare("SELECT * FROM watchalong_sessions WHERE id = ?").bind(id).first<SessionRow>();
    return json({ session: sessionView(updated!, nowMs) });
  } catch (err) {
    console.error("[mind/watchalong] patch error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/watchalong/active?channel_id=X&since_sec=Y&max_cues=N
export async function getWatchalongActive(request: Request, env: Env, nowMs: number = Date.now()): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const q = new URL(request.url).searchParams;
  const channelId = q.get("channel_id")?.trim() ?? "";
  if (!channelId) return json({ error: "channel_id is required" }, 400);

  const sinceRaw = q.get("since_sec");
  const sinceNum = sinceRaw === null || sinceRaw.trim() === "" ? -1 : Number(sinceRaw);
  const since = Number.isFinite(sinceNum) ? sinceNum : -1;
  const maxRaw = Number(q.get("max_cues") ?? DEFAULT_ACTIVE_CUES);
  const maxCues = Number.isFinite(maxRaw) ? Math.min(MAX_ACTIVE_CUES, Math.max(1, Math.trunc(maxRaw))) : DEFAULT_ACTIVE_CUES;

  try {
    const row = await env.DB.prepare(
      `SELECT * FROM watchalong_sessions WHERE channel_id = ? AND status != 'ended'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).bind(channelId).first<SessionRow>();
    if (!row) return json({ session: null, cues: [], skipped: 0 });

    const playhead = computePlayhead(row, nowMs);
    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM watchalong_cues WHERE session_id = ? AND start_sec > ? AND start_sec <= ?"
    ).bind(row.id, since, playhead).first<{ n: number }>();
    const total = Number(countRow?.n ?? 0);

    // The LAST max_cues in range: what just happened matters more than what scrolled past.
    const recent = await env.DB.prepare(
      `SELECT idx, start_sec, end_sec, kind, speaker, text FROM watchalong_cues
       WHERE session_id = ? AND start_sec > ? AND start_sec <= ?
       ORDER BY start_sec DESC, idx DESC LIMIT ?`
    ).bind(row.id, since, playhead, maxCues).all<Record<string, unknown>>();
    const cues = (recent.results ?? []).reverse();

    return json({ session: sessionView(row, nowMs), cues, skipped: Math.max(0, total - cues.length) });
  } catch (err) {
    console.error("[mind/watchalong] active error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
