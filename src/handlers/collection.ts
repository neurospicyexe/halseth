// src/handlers/collection.ts
//
// HTTP routes for the collection / emotional archaeology layer (migration 0079, take 13).
//   GET  /mind/collection/:companion_id  -- this companion's hoard (forage + listens),
//                                           sparkle-weighted, brightest first
//   POST /mind/collection/sparkle        -- add shine to an item { source_table, source_id, event }
//
// Sparkle is also bumped inline at the natural engagement points (forage consume, media
// react). This POST is the explicit/recall path. Auth: authGuard.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  isValidSparkleSource, sparkleDelta, bumpSparkleSql,
  collectionForageSql, collectionMediaSql, type SparkleEvent,
} from "../webmind/collection.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);
const VALID_EVENTS = new Set<string>(["consume", "react", "recall"]);

// GET /mind/collection/:companion_id?limit=20
export async function getCollection(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);

  try {
    const [forage, media] = await Promise.all([
      env.DB.prepare(collectionForageSql()).bind(companionId, limit).all(),
      env.DB.prepare(collectionMediaSql()).bind(limit).all(),
    ]);
    return json({ forage: forage.results ?? [], listens: media.results ?? [] });
  } catch (err) {
    console.error("[mind/collection] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/collection/sparkle  { source_table, source_id, event }
export async function postSparkle(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { source_table?: string; source_id?: string; event?: string };
  try {
    body = await request.json() as { source_table?: string; source_id?: string; event?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const sourceTable = (body.source_table ?? "").trim();
  const sourceId = (body.source_id ?? "").trim();
  const event = (body.event ?? "recall").trim();
  if (!isValidSparkleSource(sourceTable)) {
    return json({ error: "source_table must be forage_finds or media_experiences" }, 400);
  }
  if (!sourceId) return json({ error: "source_id is required" }, 400);
  if (!VALID_EVENTS.has(event)) {
    return json({ error: "event must be one of consume, react, recall" }, 400);
  }

  try {
    await bumpSparkle(env, sourceTable, sourceId, event as SparkleEvent);
    return json({ sparkled: true, event });
  } catch (err) {
    console.error("[mind/collection] sparkle error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

/**
 * Shared sparkle-accrual helper. Called inline by the forage-consume and media-react
 * handlers and by the explicit POST above. Best-effort by design at the inline call
 * sites: a sparkle write must never fail the primary engagement.
 */
export async function bumpSparkle(
  env: Env,
  sourceTable: string,
  sourceId: string,
  event: SparkleEvent,
): Promise<void> {
  await env.DB.prepare(bumpSparkleSql()).bind(sourceTable, sourceId, sparkleDelta(event)).run();
}
