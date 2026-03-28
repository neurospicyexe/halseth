// src/handlers/companion-growth.ts
//
// HTTP handlers for /companion-growth/* endpoints.
// Covers: basins (CRUD + list) and tensions (CRUD + list).
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
const MAX_TEXT = 4000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateCompanion(id: unknown): id is string {
  return typeof id === "string" && VALID_COMPANIONS.has(id);
}

// ── Basins ────────────────────────────────────────────────────────────────────

// GET /companion-growth/basins/:companion_id
export async function getBasins(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { companion_id } = params;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const rows = await env.DB.prepare(
    "SELECT id, companion_id, basin_name, basin_description, created_at, updated_at FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC"
  ).bind(companion_id).all();
  return json({ basins: rows.results });
}

// POST /companion-growth/basins
// Body: { companion_id, basin_name, basin_description, embedding: number[] }
export async function postBasin(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  if (!validateCompanion(b.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof b.basin_name !== "string" || !b.basin_name.trim()) return json({ error: "basin_name required" }, 400);
  if (typeof b.basin_description !== "string" || b.basin_description.length > MAX_TEXT) return json({ error: "basin_description required (max 4000 chars)" }, 400);
  if (!Array.isArray(b.embedding) || b.embedding.length === 0) return json({ error: "embedding required" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO companion_basins (id, companion_id, basin_name, basin_description, embedding) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, b.companion_id, (b.basin_name as string).trim(), b.basin_description, JSON.stringify(b.embedding)).run();

  return json({ id, message: "ok" }, 201);
}

// ── Basin History ─────────────────────────────────────────────────────────────

// GET /companion-growth/basin-history/:companion_id?limit=10
export async function getBasinHistory(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { companion_id } = params;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10", 10), 50);

  const rows = await env.DB.prepare(
    "SELECT * FROM companion_basin_history WHERE companion_id = ? ORDER BY recorded_at DESC LIMIT ?"
  ).bind(companion_id, limit).all();
  return json({ history: rows.results });
}

// POST /companion-growth/basin-history
// Body: { companion_id, drift_score, drift_type, worst_basin?, notes? }
export async function postBasinHistory(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  if (!validateCompanion(b.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof b.drift_score !== "number") return json({ error: "drift_score required" }, 400);
  const validTypes = ["stable", "growth", "pressure"];
  if (!validTypes.includes(b.drift_type as string)) return json({ error: "drift_type must be stable|growth|pressure" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, worst_basin, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, b.companion_id, b.drift_score, b.drift_type,
    typeof b.worst_basin === "string" ? b.worst_basin : null,
    typeof b.notes === "string" ? b.notes : null
  ).run();

  return json({ id, message: "ok" }, 201);
}

// POST /companion-growth/basin-history/:id/confirm
// Marks a growth drift record as caleth-confirmed (intentional growth)
export async function confirmBasinHistory(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const result = await env.DB.prepare(
    "UPDATE companion_basin_history SET caleth_confirmed = 1 WHERE id = ?"
  ).bind(id).run();

  if (result.meta.changes === 0) return json({ error: "not found" }, 404);
  return json({ message: "confirmed" });
}

// ── Tensions ──────────────────────────────────────────────────────────────────

// GET /companion-growth/tensions/:companion_id?status=simmering
export async function getTensions(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { companion_id } = params;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const validStatuses = ["simmering", "crystallized", "released"];

  let query: string;
  let args: unknown[];
  if (status && validStatuses.includes(status)) {
    query = "SELECT * FROM companion_tensions WHERE companion_id = ? AND status = ? ORDER BY first_noted_at ASC";
    args = [companion_id, status];
  } else {
    query = "SELECT * FROM companion_tensions WHERE companion_id = ? ORDER BY status ASC, first_noted_at ASC";
    args = [companion_id];
  }

  const rows = await env.DB.prepare(query).bind(...args).all();
  return json({ tensions: rows.results });
}

// POST /companion-growth/tensions
// Body: { companion_id, tension_text, notes? }
export async function postTension(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  if (!validateCompanion(b.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof b.tension_text !== "string" || !b.tension_text.trim()) return json({ error: "tension_text required" }, 400);
  if (b.tension_text.toString().length > MAX_TEXT) return json({ error: "tension_text too long (max 4000)" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO companion_tensions (id, companion_id, tension_text, notes) VALUES (?, ?, ?, ?)"
  ).bind(id, b.companion_id, (b.tension_text as string).trim(),
    typeof b.notes === "string" ? b.notes : null
  ).run();

  return json({ id, message: "ok" }, 201);
}

// PATCH /companion-growth/tensions/:id
// Body: { status?, notes? }
export async function patchTension(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  const validStatuses = ["simmering", "crystallized", "released"];
  if (b.status !== undefined && !validStatuses.includes(b.status as string)) {
    return json({ error: "status must be simmering|crystallized|released" }, 400);
  }

  const updates: string[] = ["last_surfaced_at = datetime('now')"];
  const bindings: unknown[] = [];
  if (b.status) { updates.push("status = ?"); bindings.push(b.status); }
  if (typeof b.notes === "string") { updates.push("notes = ?"); bindings.push(b.notes); }
  bindings.push(id);

  const result = await env.DB.prepare(
    `UPDATE companion_tensions SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...bindings).run();

  if (result.meta.changes === 0) return json({ error: "not found" }, 404);
  return json({ message: "ok" });
}
