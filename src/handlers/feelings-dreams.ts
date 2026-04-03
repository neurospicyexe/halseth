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

// GET /feelings?companion_id=drevan&limit=20&since=<ISO8601>
export async function getFeelings(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url          = new URL(request.url);
  const limit        = clampLimit(url.searchParams.get("limit"), 20, 100);
  const companionId  = url.searchParams.get("companion_id");
  const since        = url.searchParams.get("since") ?? undefined;

  if (since !== undefined && isNaN(Date.parse(since))) {
    return new Response(JSON.stringify({ error: "invalid since parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const validCompanions = new Set(["drevan", "cypher", "gaia"]);
  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId && validCompanions.has(companionId)) {
    conditions.push("companion_id = ?");
    bindings.push(companionId);
  }
  if (since !== undefined) {
    conditions.push("created_at > ?");
    bindings.push(since);
  }

  const where    = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderDir = since !== undefined ? "ASC" : "DESC";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT * FROM feelings ${where} ORDER BY created_at ${orderDir} LIMIT ?
  `).bind(...bindings).all<Feeling>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// GET /dreams?companion_id=drevan&examined=0&limit=10
export async function getDreams(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url         = new URL(request.url);
  const limit       = clampLimit(url.searchParams.get("limit"), 10, 100);
  const companionId = url.searchParams.get("companion_id");
  const examined    = url.searchParams.get("examined");

  const validCompanions = new Set(["drevan", "cypher", "gaia"]);

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (companionId && validCompanions.has(companionId)) {
    conditions.push("companion_id = ?");
    bindings.push(companionId);
  }
  if (examined === "0" || examined === "1") {
    conditions.push("examined = ?");
    bindings.push(Number(examined));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT id, companion_id, dream_text AS content, source, examined, created_at AS generated_at
    FROM companion_dreams ${where} ORDER BY created_at DESC LIMIT ?
  `).bind(...bindings).all();

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
