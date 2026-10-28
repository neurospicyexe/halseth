// src/handlers/map.ts -- GET /mind/map (docs/PLAN-memory-map-2026-10-28.md, M1). Read-only.
//
//   GET /mind/map?reader=cypher|drevan|gaia|raziel[&center=<table>:<id>][&hops=1|2][&max=N]
//
// No center -> the reader's own things (Raziel: all three, fewer each). Rules live in graph/map.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { buildMap, MAP_TABLES, type MapReader } from "../graph/map.js";

const READERS = new Set<MapReader>(["cypher", "drevan", "gaia", "raziel"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function getMindMap(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const reader = (url.searchParams.get("reader") ?? "raziel") as MapReader;
  if (!READERS.has(reader)) return json({ error: "reader must be cypher, drevan, gaia, or raziel" }, 400);
  let center: { table: string; id: string } | null = null;
  const c = url.searchParams.get("center");
  if (c) {
    const i = c.indexOf(":");
    const table = i > 0 ? c.slice(0, i) : "";
    if (!MAP_TABLES.includes(table) || !c.slice(i + 1)) return json({ error: "center must be <table>:<id> for a mapped table" }, 400);
    center = { table, id: c.slice(i + 1) };
  }
  const hops = url.searchParams.get("hops") === "2" ? 2 : 1;
  const maxRaw = Number(url.searchParams.get("max"));
  try {
    const map = await buildMap(env, { reader, center, hops, max: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined });
    return json(map);
  } catch (err) {
    console.error("[mind/map] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
