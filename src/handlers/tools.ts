// src/handlers/tools.ts
//
// HTTP routes for the companion tool layer (take 14, migration 0077).
//   POST /mind/tools/search           -- web search (gated, audited)
//   POST /mind/tools/image            -- image gen (gated, audited, R2-stored)
//   GET  /mind/tools/calls/:companion_id  -- audit log / gallery source
//   GET  /mind/tools/image/:id        -- stream a generated image from R2
//
// The first two are thin wrappers over the shared core in tools/service.ts (the same
// core the Librarian executors call). Auth: authGuard, matching handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { createProvider } from "../tools/live-providers.js";
import { runWebSearch, runImageGen } from "../tools/service.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);
const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
]);

// POST /mind/tools/search  { companion_id, query, max_results? }
export async function postToolSearch(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; query?: string; max_results?: number };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const companionId = body.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const query = body.query?.trim();
  if (!query) return json({ error: "query is required" }, 400);
  const maxResults = Math.min(Math.max(Number(body.max_results) || 5, 1), 10);

  const res = await runWebSearch(env, companionId, query, createProvider(env), maxResults);
  if (!res.ok && "denied" in res) return json({ error: "tools are not enabled for this companion", call_id: res.call_id }, 403);
  if (!res.ok) return json({ error: res.error, call_id: res.call_id }, 502);
  return json({ results: res.results, call_id: res.call_id, provider: res.provider });
}

// POST /mind/tools/image  { companion_id, prompt }
export async function postToolImage(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; prompt?: string };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const companionId = body.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const prompt = body.prompt?.trim();
  if (!prompt) return json({ error: "prompt is required" }, 400);

  const res = await runImageGen(env, companionId, prompt, createProvider(env));
  if (!res.ok && "denied" in res) return json({ error: "tools are not enabled for this companion", call_id: res.call_id }, 403);
  if (!res.ok) return json({ error: res.error, call_id: res.call_id }, 502);
  return json({ key: res.key, url: res.url, mime_type: res.mime_type, call_id: res.call_id }, 201);
}

// GET /mind/tools/calls/:companion_id?tool=generate_image&limit=20
export async function getToolCalls(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const url = new URL(request.url);
  const tool = url.searchParams.get("tool");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  try {
    let stmt;
    if (tool === "web_search" || tool === "generate_image") {
      stmt = env.DB.prepare(
        "SELECT id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at FROM companion_tool_calls WHERE companion_id = ? AND tool = ? ORDER BY created_at DESC LIMIT ?",
      ).bind(companionId, tool, limit);
    } else {
      stmt = env.DB.prepare(
        "SELECT id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at FROM companion_tool_calls WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?",
      ).bind(companionId, limit);
    }
    const rows = await stmt.all();
    return json({ calls: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/tools] calls read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/tools/image/:id -- stream the generated image from R2.
// Public read (no secret): images are non-sensitive generated art surfaced in Hearth +
// attached in Discord; the R2 key is unguessable (random call id). Mirrors serveAsset.
export async function serveToolImage(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const id = params["id"] ?? "";
  if (!/^[0-9a-f]+$/i.test(id)) return new Response("Not found", { status: 404 });

  // The row holds the exact R2 key (we don't trust the client to supply it).
  const row = await env.DB.prepare(
    "SELECT result_ref FROM companion_tool_calls WHERE id = ? AND tool = 'generate_image' AND status = 'success'",
  ).bind(id).first<{ result_ref: string | null }>();
  if (!row?.result_ref) return new Response("Not found", { status: 404 });

  const object = await env.BUCKET.get(row.result_ref);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("cache-control", "public, max-age=3600");
  const ct = ((headers.get("Content-Type") ?? "").split(";")[0] ?? "").trim();
  if (!INLINE_IMAGE_TYPES.has(ct)) headers.set("Content-Disposition", "attachment");
  return new Response(object.body, { headers });
}
