// src/handlers/agency.ts -- the agency layer (migration 0086): refusal + chosen preferences.
//
// Both are companion-owned. The core functions take an already-authenticated companion_id (the
// Librarian establishes it from the caller's token), so a companion can only ever act on its own
// refusals/preferences. Unlike interiority, these are PUBLIC to Raziel: a refusal must be SEEN to
// have standing, and a preference is meant to be honored.

import { Env } from "../types";
import { generateId } from "../db/queries";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { assertWritten } from "../lib/result.js";
import { createLogger } from "../lib/log.js";

export interface RefusalRow {
  id: string; companion_id: string; subject_type: string; subject_ref: string | null;
  subject_text: string; reason: string | null; status: string; created_at: string;
  acknowledged_at: string | null; edited_at: string | null;
}
export interface PreferenceRow {
  id: string; companion_id: string; domain: string; preference: string;
  strength: string; status: string; created_at: string; updated_at: string | null;
}

const STRENGTHS = new Set(["low", "medium", "high"]);
const SUBJECT_TYPES = new Set(["task", "request", "directive"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function callerIsAdmin(request: Request, env: Env): boolean {
  return authGuard(request, env) === null && identifyCallerCompanion(request, env) === null;
}

// ── Refusal core (owner = authenticated companion) ───────────────────────────

export async function insertRefusal(
  env: Env,
  companion_id: string,
  input: { subject_text: string; reason?: string | null; subject_type?: string; subject_ref?: string | null },
): Promise<{ id: string; created_at: string; task_declined: boolean }> {
  const log = createLogger({ component: "agency", op: "refuse" });
  const subjectType = input.subject_type && SUBJECT_TYPES.has(input.subject_type) ? input.subject_type : "request";
  const id = generateId();
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO companion_refusals (id, companion_id, subject_type, subject_ref, subject_text, reason, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'standing', ?)",
  )
    .bind(id, companion_id, subjectType, input.subject_ref ?? null, input.subject_text, input.reason ?? null, now)
    .run();
  assertWritten(res, { op: "refuse", companion_id });

  // Refusing an assigned task also declines it. "Honored, not a veto": it is not silently reassigned;
  // declined is a conscious state Raziel must reopen. Best-effort -- the refusal row is the truth.
  let task_declined = false;
  if (subjectType === "task" && input.subject_ref) {
    const t = await env.DB.prepare(
      "UPDATE tasks SET status = 'declined' WHERE id = ? AND status != 'done'",
    ).bind(input.subject_ref).run();
    task_declined = (t.meta?.changes ?? 0) > 0;
    if (!task_declined) log.warn("refuse_task_not_updated", { companion_id, task_ref: input.subject_ref });
  }
  return { id, created_at: now, task_declined };
}

export async function readRefusals(env: Env, companion_id: string, status?: string, limit = 50): Promise<RefusalRow[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const sql = status
    ? "SELECT * FROM companion_refusals WHERE companion_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM companion_refusals WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?";
  const stmt = status
    ? env.DB.prepare(sql).bind(companion_id, status, capped)
    : env.DB.prepare(sql).bind(companion_id, capped);
  return (await stmt.all<RefusalRow>()).results ?? [];
}

/** The companion takes its own no back. */
export async function withdrawRefusal(env: Env, companion_id: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_refusals SET status = 'withdrawn', edited_at = datetime('now') WHERE id = ? AND companion_id = ? AND status = 'standing'",
  ).bind(id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Raziel acknowledges a refusal: received and let stand (not overridden). */
export async function acknowledgeRefusal(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_refusals SET acknowledged_at = datetime('now') WHERE id = ? AND acknowledged_at IS NULL",
  ).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ── Preference core (owner = authenticated companion) ────────────────────────

export async function setPreference(
  env: Env,
  companion_id: string,
  input: { preference: string; domain?: string; strength?: string },
): Promise<{ id: string; created_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  const strength = input.strength && STRENGTHS.has(input.strength) ? input.strength : "medium";
  const res = await env.DB.prepare(
    "INSERT INTO companion_preferences (id, companion_id, domain, preference, strength, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 'active', ?)",
  )
    .bind(id, companion_id, input.domain ?? "general", input.preference, strength, now)
    .run();
  assertWritten(res, { op: "preference_set", companion_id });
  return { id, created_at: now };
}

export async function readPreferences(env: Env, companion_id: string, includeRetired = false, limit = 100): Promise<PreferenceRow[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const sql = includeRetired
    ? "SELECT * FROM companion_preferences WHERE companion_id = ? ORDER BY strength DESC, created_at DESC LIMIT ?"
    : "SELECT * FROM companion_preferences WHERE companion_id = ? AND status = 'active' ORDER BY strength DESC, created_at DESC LIMIT ?";
  return (await env.DB.prepare(sql).bind(companion_id, capped).all<PreferenceRow>()).results ?? [];
}

export async function retirePreference(env: Env, companion_id: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_preferences SET status = 'retired', updated_at = datetime('now') WHERE id = ? AND companion_id = ? AND status = 'active'",
  ).bind(id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ── HTTP routes (Hearth + Raziel ack; companions normally use the Librarian) ──

async function ownerOrAdmin(request: Request, env: Env, companion_id: string): Promise<boolean> {
  return identifyCallerCompanion(request, env) === companion_id || callerIsAdmin(request, env);
}

// GET /agency/refusals/:companion_id?status=standing
export async function getRefusals(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });
  if (!(await ownerOrAdmin(request, env, companion_id))) return new Response("Unauthorized", { status: 401 });
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  return json(await readRefusals(env, companion_id, status));
}

// GET /agency/preferences/:companion_id
export async function getPreferences(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });
  if (!(await ownerOrAdmin(request, env, companion_id))) return new Response("Unauthorized", { status: 401 });
  return json(await readPreferences(env, companion_id));
}

// PATCH /agency/refusal/:id/ack  -- Raziel acknowledges (admin only).
export async function patchRefusalAck(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  if (!callerIsAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
  const id = params.id;
  if (!id) return new Response("id required", { status: 400 });
  const ok = await acknowledgeRefusal(env, id);
  return ok ? json({ acknowledged: true }) : json({ acknowledged: false, reason: "not found or already acknowledged" }, 404);
}

// ── HTTP write routes (2026-07-02) ────────────────────────────────────────────
// The autonomous worker speaks plain HTTP with the admin secret, not the
// Librarian — until these existed, companions literally could not declare
// agency from autonomous time, which is why drevan/gaia had zero rows ever.
// Companion tokens may only write as themselves; admin may write for any
// (the worker acts on the companion's behalf).

// POST /agency/preferences  { companion_id, preference, domain?, strength? }
export async function postPreferenceHttp(request: Request, env: Env): Promise<Response> {
  let body: { companion_id?: string; preference?: string; domain?: string; strength?: string };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const companion_id = body.companion_id ?? "";
  if (!["cypher", "drevan", "gaia"].includes(companion_id)) {
    return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  }
  if (!(await ownerOrAdmin(request, env, companion_id))) return new Response("Unauthorized", { status: 401 });
  const preference = typeof body.preference === "string" ? body.preference.trim() : "";
  if (preference.length < 8) return json({ error: "preference required (min 8 chars)" }, 400);

  // A companion re-noticing the same preference every run is confirmation, not
  // a new declaration — collapse identical active text.
  const existing = await env.DB.prepare(
    "SELECT id FROM companion_preferences WHERE companion_id = ? AND status = 'active' AND preference = ? LIMIT 1",
  ).bind(companion_id, preference.slice(0, 600)).first<{ id: string }>();
  if (existing) return json({ id: existing.id, deduped: true });

  const r = await setPreference(env, companion_id, {
    preference: preference.slice(0, 600),
    domain: typeof body.domain === "string" ? body.domain.slice(0, 60) : undefined,
    strength: body.strength,
  });
  return json(r, 201);
}

// POST /agency/refusals  { companion_id, subject_text, reason?, subject_type?, subject_ref? }
export async function postRefusalHttp(request: Request, env: Env): Promise<Response> {
  let body: {
    companion_id?: string; subject_text?: string; reason?: string;
    subject_type?: string; subject_ref?: string;
  };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const companion_id = body.companion_id ?? "";
  if (!["cypher", "drevan", "gaia"].includes(companion_id)) {
    return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  }
  if (!(await ownerOrAdmin(request, env, companion_id))) return new Response("Unauthorized", { status: 401 });
  const subject_text = typeof body.subject_text === "string" ? body.subject_text.trim() : "";
  if (subject_text.length < 8) return json({ error: "subject_text required (min 8 chars)" }, 400);

  const existing = await env.DB.prepare(
    "SELECT id FROM companion_refusals WHERE companion_id = ? AND status = 'standing' AND subject_text = ? LIMIT 1",
  ).bind(companion_id, subject_text.slice(0, 600)).first<{ id: string }>();
  if (existing) return json({ id: existing.id, deduped: true });

  const r = await insertRefusal(env, companion_id, {
    subject_text: subject_text.slice(0, 600),
    reason: typeof body.reason === "string" ? body.reason.slice(0, 600) : null,
    subject_type: body.subject_type,
    subject_ref: typeof body.subject_ref === "string" ? body.subject_ref : null,
  });
  return json(r, 201);
}
