// GET /feelings and GET /dreams REST endpoints.

import { Env } from "../types.js";
import type { Feeling, Dream } from "../types.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /feelings?companion_id=drevan&limit=20
export async function getFeelings(request: Request, env: Env): Promise<Response> {
  const url          = new URL(request.url);
  const limit        = clampLimit(url.searchParams.get("limit"), 20, 100);
  const companionId  = url.searchParams.get("companion_id");

  const validCompanions = new Set(["drevan", "cypher", "gaia"]);
  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId && validCompanions.has(companionId)) {
    conditions.push("companion_id = ?");
    bindings.push(companionId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT * FROM feelings ${where} ORDER BY created_at DESC LIMIT ?
  `).bind(...bindings).all<Feeling>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /dreams?companion_id=drevan&type=processing&limit=10
export async function getDreams(request: Request, env: Env): Promise<Response> {
  const url         = new URL(request.url);
  const limit       = clampLimit(url.searchParams.get("limit"), 10, 100);
  const companionId = url.searchParams.get("companion_id");
  const dreamType   = url.searchParams.get("type");

  const validCompanions = new Set(["drevan", "cypher", "gaia"]);
  const validTypes      = new Set(["processing", "questioning", "memory", "play", "integrating"]);

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId && validCompanions.has(companionId)) {
    conditions.push("companion_id = ?");
    bindings.push(companionId);
  }
  if (dreamType && validTypes.has(dreamType)) {
    conditions.push("dream_type = ?");
    bindings.push(dreamType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT * FROM dreams ${where} ORDER BY generated_at DESC LIMIT ?
  `).bind(...bindings).all<Dream>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}
