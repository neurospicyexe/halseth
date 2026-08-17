// src/handlers/care.ts
//
// HTTP surface for the care loop (consequence layer C1).
//
//   POST /mind/care/:id/acted  -- the acting companion stamps what they actually did. This is the
//                                 falsifiability half: a care layer whose actions can't be counted
//                                 is the write-gate-unfalsifiable shape again.
//   GET  /mind/care/recent     -- the log, newest first. Raziel's read; also the verification gate.
//   POST /admin/care-tick      -- force one detection pass (skips the hourly gate). Live-fire tool.

import type { Env } from "../types.js";
import { runCareTick } from "../care/tick.js";
import { readOwnerLastSeen, OWNER_ACTIVITY_SOURCES } from "../care/owner-activity.js";
import { QUIET_OWNER_DAYS } from "../care/rules.js";
import { hoursSinceIso } from "../webmind/drives.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

export async function postCareActed(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);

  let body: { companion_id?: string; gesture?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  const gesture = String(body.gesture ?? "").slice(0, 60);
  if (!VALID_COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  if (!gesture) return json({ error: "missing gesture" }, 400);

  const row = await env.DB.prepare(
    `SELECT companion_id, acted_at FROM care_actions WHERE id = ?`,
  ).bind(id).first<{ companion_id: string; acted_at: string | null }>();
  if (!row) return json({ error: "not found" }, 404);
  // Idempotent: a retry of an ack that already landed is a success, not a conflict.
  if (row.acted_at) return json({ ok: true, already_acted: true, acted_at: row.acted_at });
  // The row names its assignee; a sibling acking it would un-log who actually acted.
  if (row.companion_id !== companionId) {
    return json({ error: `assigned to ${row.companion_id}, not ${companionId}` }, 409);
  }

  await env.DB.prepare(
    `UPDATE care_actions SET acted_at = datetime('now'), gesture = ?, gesture_note = ? WHERE id = ? AND acted_at IS NULL`,
  ).bind(gesture, body.note ? String(body.note).slice(0, 1000) : null, id).run();

  return json({ ok: true });
}

/** Tier 3 (R1, 2026-08-17): undelivered escalations, oldest first -- the worker's delivery
 *  poller drains these to Blue via Discord DM (home-channel fallback). No decay on undelivered
 *  rows: silent expiry is the failure this tier exists to prevent. */
export async function getCareEscalations(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, rule, companion_id, detail, detected_at FROM care_escalations
     WHERE delivered_at IS NULL ORDER BY detected_at ASC LIMIT 10`,
  ).all();
  return json({ escalations: rows.results ?? [] });
}

/** The worker stamps how an escalation actually reached a human. Idempotent on retry. */
export async function postCareEscalationDelivered(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { via?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const via = String(body.via ?? "").slice(0, 60);
  if (!via) return json({ error: "missing via" }, 400);

  const row = await env.DB.prepare(
    `SELECT delivered_at FROM care_escalations WHERE id = ?`,
  ).bind(id).first<{ delivered_at: string | null }>();
  if (!row) return json({ error: "not found" }, 404);
  if (row.delivered_at) return json({ ok: true, already_delivered: true, delivered_at: row.delivered_at });

  // ISO like detected_at, not datetime('now') -- mixed formats in one table sort wrong the first
  // time anyone computes delivery latency (reviewer, 2026-08-17).
  await env.DB.prepare(
    `UPDATE care_escalations SET delivered_at = ?, delivered_via = ? WHERE id = ? AND delivered_at IS NULL`,
  ).bind(new Date().toISOString(), via, id).run();
  return json({ ok: true });
}

/** A failed delivery attempt, recorded on the row -- pm2 logs rotate; a row stuck at
 *  attempt_count 40 with a stable last_error is a diagnosable deterministic reject
 *  ([[deterministic-reject-is-not-transient]]). */
export async function postCareEscalationAttempt(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { error?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const res = await env.DB.prepare(
    `UPDATE care_escalations SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
     WHERE id = ? AND delivered_at IS NULL`,
  ).bind(new Date().toISOString(), String(body.error ?? "").slice(0, 300) || null, id).run();
  return json({ ok: true, counted: (res.meta?.changes ?? 0) > 0 });
}

/** The newest un-acted, un-decayed firing assigned to this companion -- the worker's gesture
 *  tick polls this. Same predicate as the loader block (mind/blocks/care.ts), one lane one filter. */
export async function getCarePending(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  const { PENDING_DECAY_HOURS } = await import("../care/rules.js");
  const decayCutoff = new Date(Date.now() - PENDING_DECAY_HOURS * 3_600_000).toISOString();
  const row = await env.DB.prepare(
    `SELECT id, rule, detail, detected_at FROM care_actions
     WHERE companion_id = ? AND acted_at IS NULL AND detected_at > ?
     ORDER BY detected_at DESC LIMIT 1`,
  ).bind(companionId, decayCutoff).first();
  return json({ pending: row ?? null });
}

export async function getCareRecent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
  const rows = await env.DB.prepare(
    `SELECT id, rule, companion_id, detail, detected_at, gesture, gesture_note, acted_at
     FROM care_actions ORDER BY detected_at DESC LIMIT ?`,
  ).bind(limit).all();
  return json({ care_actions: rows.results ?? [] });
}

export async function postCareTickForce(_request: Request, env: Env): Promise<Response> {
  const result = await runCareTick(env, Date.now(), { force: true });
  return json(result);
}

/** The C6 quiet-owner read for the standing health check (ops/health-check.py in
 *  nullsafe-discord). Same shared owner-activity lane as the tick and the register; the check
 *  polls this and alerts the custodian when `quiet` goes true. `sources` states the denominator:
 *  a silence claim must name what it checked. */
export async function getOwnerActivity(_request: Request, env: Env): Promise<Response> {
  const last = await readOwnerLastSeen(env);
  const silenceHours = last ? Math.round(hoursSinceIso(last.at, Date.now()) * 10) / 10 : null;
  return json({
    last_seen_at: last?.at ?? null,
    last_source: last?.source ?? null,
    silence_hours: silenceHours,
    threshold_days: QUIET_OWNER_DAYS,
    // null silence_hours means NO surface has ever seen him (or the read failed upstream) --
    // that is "cannot look", not "quiet", and the health check reports it as its own condition.
    quiet: silenceHours !== null && silenceHours >= QUIET_OWNER_DAYS * 24,
    sources: OWNER_ACTIVITY_SOURCES,
  });
}
