// src/handlers/forage.ts
//
// HTTP route handlers for the foraging pool (migration 0068, foraging spec Part 2).
//   POST  /mind/forage                      -- write a find (forager: worker or any substrate)
//   GET   /mind/forage/:companion_id        -- unconsumed finds, own + shared pool
//   PATCH /mind/forage/:id/consume          -- mark a find consumed by an instance
//
// The forager gathers fuel; it does not author identity. Summaries are neutral
// scout's reports -- the real companion explores a find AS themselves and authors
// its own growth.
//
// Auth: authGuard (ADMIN_SECRET / per-companion tokens), enforced at the handler
// level, matching the pattern used by handlers/home.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { bumpSparkle } from "./collection.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);

interface ForagePostBody {
  companion_id?: string | null;
  domain?: string;
  title?: string;
  source_url?: string | null;
  summary?: string;
}

// POST /mind/forage
export async function postForageFind(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: ForagePostBody;
  try {
    body = await request.json() as ForagePostBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const domain = body.domain?.trim();
  const title = body.title?.trim();
  const summary = body.summary?.trim();
  if (!domain || !title || !summary) {
    return json({ error: "domain, title, and summary are required" }, 400);
  }
  const companionId = body.companion_id ?? null;
  if (companionId !== null && !VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia, or null for the shared pool" }, 400);
  }
  const sourceUrl = body.source_url?.trim() || null;

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO forage_finds (id, companion_id, domain, title, source_url, summary) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, companionId, domain, title.slice(0, 300), sourceUrl, summary.slice(0, 2000)).run();
  } catch (err) {
    // idx_forage_dedup: one find per (source_url, domain). A repeat gather is
    // normal forager behavior, not an error.
    if (String(err).includes("UNIQUE constraint failed")) {
      return json({ deduped: true }, 200);
    }
    console.error("[mind/forage] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }

  return json({ find: { id, companion_id: companionId, domain, title, source_url: sourceUrl } }, 201);
}

// GET /mind/forage/:companion_id?limit=5
export async function getForageFinds(
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
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "5", 10) || 5, 1), 25);

  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NULL ORDER BY gathered_at DESC LIMIT ?"
    ).bind(companionId, limit).all();
    return json({ finds: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/forage] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/forage/:id/consume
export async function consumeForageFind(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let consumedBy = "unknown";
  try {
    const body = await request.json() as { consumed_by?: string };
    if (body.consumed_by?.trim()) consumedBy = body.consumed_by.trim().slice(0, 100);
  } catch {
    // body optional -- consumed_by defaults to "unknown"
  }

  try {
    const result = await env.DB.prepare(
      "UPDATE forage_finds SET consumed_at = datetime('now'), consumed_by = ? WHERE id = ? AND consumed_at IS NULL"
    ).bind(consumedBy, id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return json({ error: "find not found or already consumed" }, 404);
    }
    // Take 13: a consumed find earns sparkle in the collection. Best-effort -- a
    // sparkle write must never fail the consume.
    await bumpSparkle(env, "forage_finds", id, "consume").catch(() => {});
    return json({ consumed: true });
  } catch (err) {
    console.error("[mind/forage] consume error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
