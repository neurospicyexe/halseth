// src/handlers/director.ts
//
// Conversation Director endpoints (spec 2026-09-03). Invitations are the observability surface;
// supply / neighborhood / health land in this same file (Tasks 4-6 of the plan).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
const REASONS = new Set(["addressed", "supply_relevant", "open"]);
const OUTCOMES = new Set(["shadow", "issued", "spoke", "passed", "empty", "expired"]);

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

// POST /mind/director/invitations
export async function postDirectorInvitation(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let b: { id?: string; channel_id?: string; thread_id?: string | null; companion_id?: string; reason?: string; offer_ids?: unknown; outcome?: string };
  try { b = await request.json() as typeof b; } catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!b.id || !b.channel_id) return json({ error: "id and channel_id are required" }, 400);
  if (!b.companion_id || !COMPANIONS.has(b.companion_id)) return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  if (!b.reason || !REASONS.has(b.reason)) return json({ error: "reason must be addressed|supply_relevant|open" }, 400);
  if (!b.outcome || !OUTCOMES.has(b.outcome)) return json({ error: "outcome invalid" }, 400);
  const offerIds = strArray(b.offer_ids ?? []);
  if (!offerIds) return json({ error: "offer_ids must be string[]" }, 400);
  try {
    await env.DB.prepare(
      `INSERT INTO director_invitations (id, channel_id, thread_id, companion_id, reason, offer_ids, outcome, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(b.id, b.channel_id, b.thread_id ?? null, b.companion_id, b.reason, JSON.stringify(offerIds), b.outcome, new Date().toISOString()).run();
    return json({ id: b.id }, 201);
  } catch (err) {
    console.error("[mind/director/invitations] POST error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/director/invitations/:id
export async function patchDirectorInvitation(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);
  let b: { outcome?: string; message_id?: string; used_offer_ids?: unknown };
  try { b = await request.json() as typeof b; } catch { return json({ error: "Invalid JSON body" }, 400); }
  if (!b.outcome || !OUTCOMES.has(b.outcome)) return json({ error: "outcome invalid" }, 400);
  const used = strArray(b.used_offer_ids ?? []);
  if (!used) return json({ error: "used_offer_ids must be string[]" }, 400);
  try {
    const r = await env.DB.prepare(
      `UPDATE director_invitations SET outcome = ?, message_id = ?, used_offer_ids = ?, resolved_at = ? WHERE id = ?`,
    ).bind(b.outcome, b.message_id ?? null, JSON.stringify(used), new Date().toISOString(), id).run();
    if (r.meta.changes === 0) return json({ error: "Invitation not found" }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error("[mind/director/invitations] PATCH error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
