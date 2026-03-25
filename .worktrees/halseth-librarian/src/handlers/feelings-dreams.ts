// GET /feelings, GET /dreams, GET/POST /dream-seeds REST endpoints.

import { Env } from "../types.js";
import type { Feeling, Dream } from "../types.js";
import { generateId } from "../db/queries.js";

function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /feelings?companion_id=drevan&limit=20
export async function getFeelings(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
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
  const denied = authGuard(request, env); if (denied) return denied;
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

// GET /dream-seeds — list all seeds, newest first. Includes claimed ones.
export async function getDreamSeeds(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const result = await env.DB.prepare(`
    SELECT * FROM dream_seeds ORDER BY created_at DESC LIMIT 50
  `).all();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// POST /dream-seeds — inject a dream seed from the Architect.
// Body: { content: string, for_companion?: "drevan"|"cypher"|"gaia" }
export async function postDreamSeed(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { content?: string; for_companion?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { content, for_companion } = body;
  if (!content || typeof content !== "string" || content.trim() === "") {
    return new Response("content is required", { status: 400 });
  }

  const validCompanions = new Set(["drevan", "cypher", "gaia"]);
  const companion = for_companion && validCompanions.has(for_companion) ? for_companion : null;

  const id  = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO dream_seeds (id, created_at, content, for_companion, claimed_at, claimed_by)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `).bind(id, now, content.trim(), companion).run();

  return new Response(JSON.stringify({ id, created_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
