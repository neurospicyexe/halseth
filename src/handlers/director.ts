// src/handlers/director.ts
//
// Conversation Director endpoints (spec 2026-09-03). Invitations are the observability surface;
// supply / neighborhood / health land in this same file (Tasks 4-6 of the plan).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { SUPPLY_SOURCES, RECEIPT_SQL, mapRow, type SupplyRow, type DirectorSupplyItem } from "../director/supply-query.js";
import { neighborhood, type GraphSeed } from "../graph/traverse.js";
import { readerDegrees, nodeKey } from "../graph/salience.js";
import { renderEdgeLines, scoreNode } from "../graph/render.js";

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
  const used = b.used_offer_ids === undefined ? null : strArray(b.used_offer_ids);
  if (b.used_offer_ids !== undefined && !used) return json({ error: "used_offer_ids must be string[]" }, 400);
  try {
    const r = await env.DB.prepare(
      `UPDATE director_invitations
          SET outcome = ?,
              message_id = COALESCE(?, message_id),
              used_offer_ids = COALESCE(?, used_offer_ids),
              resolved_at = ?
        WHERE id = ?`,
    ).bind(b.outcome, b.message_id ?? null, used === null ? null : JSON.stringify(used), new Date().toISOString(), id).run();
    if (r.meta.changes === 0) return json({ error: "Invitation not found" }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error("[mind/director/invitations] PATCH error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/director/supply?since=&limit=
// Returns items oldest-first, cursor is the last returned row's created_at (the worker re-sorts newest-first itself).
export async function getDirectorSupply(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const since = url.searchParams.get("since") ?? "1970-01-01T00:00:00.000Z";
  const parsed = parseInt(url.searchParams.get("limit") ?? "40", 10);
  const perSource = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 80) : 40;
  try {
    const stmts = SUPPLY_SOURCES.map((s) => env.DB.prepare(s.sql).bind(since, perSource));
    const results = await env.DB.batch<SupplyRow>(stmts);
    const items: DirectorSupplyItem[] = [];
    results.forEach((res, i) => { for (const row of res.results ?? []) items.push(mapRow(SUPPLY_SOURCES[i]!, row)); });
    for (const [kind, sqlFor] of Object.entries(RECEIPT_SQL)) {
      const ids = items.filter((it) => it.kind === kind).map((it) => it.id);
      if (ids.length === 0 || !sqlFor) continue;
      const { results: rs } = await env.DB.prepare(sqlFor(ids.length)).bind(...ids).all<{ id: string; reader: string }>();
      for (const r of rs ?? []) { const it = items.find((x) => x.kind === kind && x.id === r.id); if (it) it.consumed_by.push(r.reader); }
    }
    items.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const page = items.slice(0, perSource);
    const cursor = page.length > 0 ? page[page.length - 1]!.created_at : since;
    return json({ items: page, cursor });
  } catch (err) {
    console.error("[mind/director/supply] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/director/neighborhood?reader=<id>&seeds=<table:id,...>&hops=1|2
export async function getDirectorNeighborhood(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const reader = url.searchParams.get("reader") ?? "";
  if (!COMPANIONS.has(reader)) return json({ error: "reader must be cypher, drevan, or gaia" }, 400);
  const seeds: GraphSeed[] = (url.searchParams.get("seeds") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(":"); return i > 0 ? { table: s.slice(0, i), id: s.slice(i + 1) } : null;
  }).filter((s) => s && s.table && s.id) as GraphSeed[];
  if (seeds.length === 0) return json({ lines: [], nodes: [] });
  if (seeds.some((s) => s.table === "companions")) return json({ error: "companions/<id> is not a valid seed (hairball)" }, 400);
  const hops = url.searchParams.get("hops") === "2" ? 2 : 1;
  try {
    const edges = await neighborhood(env, seeds, { hops, limit: 30, withHeat: true });
    const degrees = readerDegrees(edges, reader, seeds);
    const seen = new Set<string>();
    const nodes: Array<{ table: string; id: string; heat: number | null; score: number }> = [];
    for (const e of edges) {
      for (const [t, id] of [[e.src_table, e.src_id], [e.dst_table, e.dst_id]] as const) {
        const k = nodeKey(t, id);
        if (seen.has(k) || t === "companions") continue;
        seen.add(k);
        nodes.push({ table: t, id, heat: e.node_heat, score: scoreNode(e.node_heat, degrees.get(k) ?? 0) });
      }
    }
    nodes.sort((a, b) => b.score - a.score);
    return json({ lines: renderEdgeLines(edges, degrees), nodes: nodes.slice(0, 12) });
  } catch (err) {
    console.error("[mind/director/neighborhood] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /admin/director/health?hours=24 -- raw counts with their denominator; no thresholds here.
export async function getDirectorHealth(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const h = parseInt(new URL(request.url).searchParams.get("hours") ?? "24", 10);
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : 24;
  const sinceExpr = `datetime('now', '-${hours} hours')`;
  const count = async (sql: string): Promise<Record<string, number>> => {
    const { results } = await env.DB.prepare(sql).all<{ k: string; n: number }>();
    const out: Record<string, number> = {};
    for (const r of results ?? []) out[r.k] = Number(r.n);
    return out;
  };
  try {
    const issued = await count(`SELECT companion_id AS k, COUNT(*) AS n FROM director_invitations WHERE issued_at > ${sinceExpr} GROUP BY companion_id`);
    const outcomes = await count(`SELECT outcome AS k, COUNT(*) AS n FROM director_invitations WHERE issued_at > ${sinceExpr} GROUP BY outcome`);
    const floor = await count(`SELECT reason AS k, COUNT(*) AS n FROM director_invitations WHERE issued_at > ${sinceExpr} AND reason = 'open'`);
    const forage = await count(`SELECT 'forage' AS k, COUNT(*) AS n FROM forage_finds WHERE consumed_at IS NULL`);
    const questions = await count(`SELECT 'question' AS k, COUNT(*) AS n FROM companion_questions WHERE status='open' AND delivered_at IS NULL`);
    const projects = await count(`SELECT 'project' AS k, COUNT(*) AS n FROM companion_projects WHERE status='open'`);
    const tensions = await count(`SELECT 'tension' AS k, COUNT(*) AS n FROM companion_tensions WHERE status IN ('simmering','crystallized')`);
    return json({
      window_hours: hours,
      issued: { cypher: issued["cypher"] ?? 0, drevan: issued["drevan"] ?? 0, gaia: issued["gaia"] ?? 0 },
      outcomes: { shadow: outcomes["shadow"] ?? 0, issued: outcomes["issued"] ?? 0, spoke: outcomes["spoke"] ?? 0, passed: outcomes["passed"] ?? 0, empty: outcomes["empty"] ?? 0, expired: outcomes["expired"] ?? 0 },
      floor_fires: floor["open"] ?? 0,
      supply_pool: { forage: forage["forage"] ?? 0, question: questions["question"] ?? 0, project: projects["project"] ?? 0, tension: tensions["tension"] ?? 0 },
    });
  } catch (err) {
    console.error("[admin/director/health] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
