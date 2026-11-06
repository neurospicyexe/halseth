// src/handlers/companion-growth.ts
//
// HTTP handlers for /companion-growth/* endpoints.
// Covers: basins (CRUD + list) and tensions (CRUD + list).
// All routes require ADMIN_SECRET Bearer auth.

import { fireTensionResolved } from "../librarian/backends/halseth.js";
import { onlyIf, schemaGap } from "../care/schema-gap.js";
import type { Env } from "../types.js";
import { authGuard, isAdminToken } from "../lib/auth.js";
import { embedText, embedAndStoreAsync } from "../mcp/embed.js";

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

  // Live rows only (mig 0172); pre-0172 the status column is missing, fall back on that gap only.
  // The second-brain evaluator reads this route, so its drift readings follow a revised basin from here.
  const cols = "id, companion_id, basin_name, basin_description, embedding, created_at, updated_at";
  const rows = await env.DB.prepare(
    `SELECT ${cols} FROM companion_basins WHERE companion_id = ? AND status = 'live' ORDER BY created_at ASC`
  ).bind(companion_id).all().catch(onlyIf(schemaGap, () => env.DB.prepare(
    `SELECT ${cols} FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC`
  ).bind(companion_id).all()));
  return json({ basins: rows.results });
}

// POST /companion-growth/basins
// Body: { companion_id, basin_name, basin_description, embedding: number[] }
// SEED-ONLY (mig 0172, B63): Raziel's admin token exactly, and only for a companion that has NO basin row yet. Once
// basins exist they move only by the companion's own revision (Librarian `revise my basin`), so this route can never
// write a live basin around the cause, pace and witness gates.
export async function postBasin(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  if (!isAdminToken(request, env)) return json({ error: "forbidden: basins are seeded by Raziel only" }, 403);

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  if (!validateCompanion(b.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof b.basin_name !== "string" || !b.basin_name.trim()) return json({ error: "basin_name required" }, 400);
  if (typeof b.basin_description !== "string" || b.basin_description.length > MAX_TEXT) return json({ error: "basin_description required (max 4000 chars)" }, 400);
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM companion_basins WHERE companion_id = ?").bind(b.companion_id).first<{ n: number }>();
  if ((have?.n ?? 0) > 0) return json({ error: "this companion already has basins; they move only by the companion's own revision" }, 409);

  // Embedding (2026-07-02): server-side via Workers AI when the caller doesn't supply one.
  // Caller-supplied embeddings had unknown provenance (any model, any dims) which made the
  // column unusable for similarity; bge-base-en-v1.5 here matches the drift check's embedder
  // so basin geometry is finally consistent and load-bearing.
  let embedding: number[] | null = Array.isArray(b.embedding) && b.embedding.length > 0
    ? (b.embedding as number[])
    : null;
  if (!embedding) {
    try {
      embedding = await embedText(env, `${(b.basin_name as string).trim()}: ${b.basin_description as string}`);
    } catch (e) {
      console.warn("[companion-growth] basin embed failed, storing empty:", String(e));
    }
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO companion_basins (id, companion_id, basin_name, basin_description, embedding) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, b.companion_id, (b.basin_name as string).trim(), b.basin_description, JSON.stringify(embedding ?? [])).run();

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
    "UPDATE companion_basin_history SET caleth_confirmed = 1 WHERE id = ? AND dismissed_at IS NULL AND caleth_confirmed = 0"
  ).bind(id).run();

  if (result.meta.changes === 0) return json({ error: "not found or already handled" }, 404);
  return json({ message: "confirmed" });
}

// POST /companion-growth/basin-history/:id/dismiss
// Marks a pressure reading as noise (B2, migration 0083) -- clears the warning WITHOUT
// re-baselining the identity anchor. Confirm = real growth; dismiss = measurement noise.
export async function dismissBasinHistory(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const result = await env.DB.prepare(
    "UPDATE companion_basin_history SET dismissed_at = datetime('now') WHERE id = ? AND caleth_confirmed = 0 AND dismissed_at IS NULL"
  ).bind(id).run();

  if (result.meta.changes === 0) return json({ error: "not found or already addressed" }, 404);
  return json({ message: "dismissed" });
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

/** The three SOMA floats a tension may drag (mig 0173). */
export const DRAGS_FLOAT_VALUES = ["soma_float_1", "soma_float_2", "soma_float_3"] as const;
/** undefined/null/"" = names none (null); a valid name = itself; anything else = "invalid". */
function parseDragsFloat(v: unknown): string | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  return typeof v === "string" && (DRAGS_FLOAT_VALUES as readonly string[]).includes(v) ? v : "invalid";
}

// POST /companion-growth/tensions
// Body: { companion_id, tension_text, notes?, drags_float? }
export async function postTension(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const b = body as Record<string, unknown>;

  if (!validateCompanion(b.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof b.tension_text !== "string" || !b.tension_text.trim()) return json({ error: "tension_text required" }, 400);
  if (b.tension_text.toString().length > MAX_TEXT) return json({ error: "tension_text too long (max 4000)" }, 400);

  const dragsFloat = parseDragsFloat(b.drags_float);
  if (dragsFloat === "invalid") return json({ error: `drags_float must be one of ${DRAGS_FLOAT_VALUES.join("|")}` }, 400);

  const id = crypto.randomUUID();
  try {
    if (dragsFloat) {
      await env.DB.prepare(
        "INSERT INTO companion_tensions (id, companion_id, tension_text, notes, drags_float) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, b.companion_id, (b.tension_text as string).trim(),
        typeof b.notes === "string" ? b.notes : null, dragsFloat
      ).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO companion_tensions (id, companion_id, tension_text, notes) VALUES (?, ?, ?, ?)"
      ).bind(id, b.companion_id, (b.tension_text as string).trim(),
        typeof b.notes === "string" ? b.notes : null
      ).run();
    }
  } catch (e) {
    if (dragsFloat && /no such column|has no column named/i.test(String(e))) return json({ error: "needs the 0173 migration" }, 409);
    throw e;
  }

  // Embed so tensions are reachable by meaning (2026-07-19). Awaited + caught:
  // never blocks the write; D1 is truth, fill-mode reindex heals index gaps.
  try {
    await embedAndStoreAsync(env, (b.tension_text as string).trim(), "companion_tensions", id, b.companion_id as string);
  } catch (err) {
    console.error("[tensions] embed failed (row kept, index stale):", String(err));
  }

  return json({ id, message: "ok" }, 201);
}

// PATCH /companion-growth/tensions/:id
// Body: { status?, notes?, charge_delta? }
// charge_delta: surfacing a tension raises its charge (CogCor mechanic, +0.5 per
// surface by convention); charge is clamped 0-10 and drives dialectic priority.
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
  if (b.charge_delta !== undefined && (typeof b.charge_delta !== "number" || !Number.isFinite(b.charge_delta) || Math.abs(b.charge_delta) > 10)) {
    return json({ error: "charge_delta must be a finite number within [-10, 10]" }, 400);
  }

  const dragsFloat = parseDragsFloat(b.drags_float);
  if (dragsFloat === "invalid") return json({ error: `drags_float must be one of ${DRAGS_FLOAT_VALUES.join("|")}` }, 400);

  const updates: string[] = ["last_surfaced_at = datetime('now')"];
  const bindings: unknown[] = [];
  if (dragsFloat) { updates.push("drags_float = ?"); bindings.push(dragsFloat); }
  if (b.status) { updates.push("status = ?"); bindings.push(b.status); }
  if (typeof b.notes === "string") { updates.push("notes = ?"); bindings.push(b.notes); }
  if (typeof b.charge_delta === "number") {
    updates.push("charge = MIN(10.0, MAX(0.0, charge + ?))");
    bindings.push(b.charge_delta);
  }
  bindings.push(id);

  const wasSimmering = b.status === "crystallized" || b.status === "released"
    ? !!(await env.DB.prepare("SELECT 1 AS hit FROM companion_tensions WHERE id = ? AND status = 'simmering'").bind(id).first().catch(() => null))
    : false;
  let result;
  try {
    result = await env.DB.prepare(
      `UPDATE companion_tensions SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...bindings).run();
  } catch (e) {
    if (dragsFloat && /no such column|has no column named/i.test(String(e))) return json({ error: "needs the 0173 migration" }, 409);
    throw e;
  }

  if (result.meta.changes === 0) return json({ error: "not found" }, 404);
  if (wasSimmering) await fireTensionResolved(env, id, String(b.status));
  return json({ message: "ok" });
}
