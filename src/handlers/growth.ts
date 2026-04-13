// src/handlers/growth.ts
//
// HTTP route handlers for /mind/growth/* endpoints.
// Companion learning artifacts: journal entries, patterns, markers.
// Cap enforcement is per-companion: journal=200, patterns=50, markers=100.
// All routes require ADMIN_SECRET Bearer auth (enforced at index.ts level).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
const MAX_TEXT = 8000;

const JOURNAL_CAP = 200;
const PATTERNS_CAP = 50;
const MARKERS_CAP = 100;

function optStr(val: unknown, max: number): string | null {
  return typeof val === "string" && val.trim() ? val.trim().slice(0, max) : null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateCompanion(id: unknown): id is string {
  return typeof id === "string" && VALID_COMPANIONS.has(id);
}

/** Enforce a per-companion row cap by deleting oldest rows when at limit. */
async function enforceCapOldest(
  env: Env,
  table: string,
  companion_id: string,
  cap: number,
): Promise<void> {
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${table} WHERE companion_id = ?`
  ).bind(companion_id).first<{ n: number }>();
  if (count && count.n >= cap) {
    await env.DB.prepare(
      `DELETE FROM ${table} WHERE id IN (
         SELECT id FROM ${table} WHERE companion_id = ? ORDER BY created_at ASC LIMIT ?
       )`
    ).bind(companion_id, count.n - cap + 1).run();
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

// POST /mind/growth/journal
export async function postGrowthJournal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.content !== "string" || !body.content.trim()) return json({ error: "content required" }, 400);
  if (body.content.toString().length > MAX_TEXT) return json({ error: `content too long (max ${MAX_TEXT})` }, 400);

  const valid_types = new Set(["learning", "insight", "connection", "question"]);
  const entry_type = typeof body.entry_type === "string" && valid_types.has(body.entry_type)
    ? body.entry_type
    : "learning";
  const valid_sources = new Set(["autonomous", "conversation", "reflection"]);
  const source = typeof body.source === "string" && valid_sources.has(body.source)
    ? body.source
    : "autonomous";

  await enforceCapOldest(env, "growth_journal", body.companion_id as string, JOURNAL_CAP);

  const run_id = optStr(body.run_id, 64);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO growth_journal (id, companion_id, entry_type, content, source, tags_json, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    id,
    body.companion_id,
    entry_type,
    body.content,
    source,
    body.tags ? JSON.stringify(body.tags) : "[]",
    run_id,
  ).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/growth/journal/:companion_id
export async function getGrowthJournal(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);

  const rows = await env.DB.prepare(
    "SELECT * FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companion_id, limit).all();

  return json({ journal: rows.results });
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// POST /mind/growth/patterns
export async function postGrowthPattern(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.pattern_text !== "string" || !body.pattern_text.trim()) return json({ error: "pattern_text required" }, 400);
  if (body.pattern_text.toString().length > MAX_TEXT) return json({ error: `pattern_text too long (max ${MAX_TEXT})` }, 400);

  await enforceCapOldest(env, "growth_patterns", body.companion_id as string, PATTERNS_CAP);

  const run_id = optStr(body.run_id, 64);

  const id = crypto.randomUUID();
  const strength = typeof body.strength === "number" ? Math.max(1, Math.min(10, body.strength)) : 1;
  await env.DB.prepare(
    "INSERT INTO growth_patterns (id, companion_id, pattern_text, evidence_json, strength, run_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(
    id,
    body.companion_id,
    body.pattern_text,
    body.evidence ? JSON.stringify(body.evidence) : "[]",
    strength,
    run_id,
  ).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/growth/patterns/:companion_id
export async function getGrowthPatterns(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const rows = await env.DB.prepare(
    "SELECT * FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC"
  ).bind(companion_id).all();

  return json({ patterns: rows.results });
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

// POST /mind/growth/markers
export async function postGrowthMarker(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.description !== "string" || !body.description.trim()) return json({ error: "description required" }, 400);
  if (body.description.toString().length > MAX_TEXT) return json({ error: `description too long (max ${MAX_TEXT})` }, 400);

  const valid_marker_types = new Set(["milestone", "shift", "realization"]);
  const marker_type = typeof body.marker_type === "string" && valid_marker_types.has(body.marker_type)
    ? body.marker_type
    : "milestone";

  await enforceCapOldest(env, "growth_markers", body.companion_id as string, MARKERS_CAP);

  const run_id = optStr(body.run_id, 64);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO growth_markers (id, companion_id, marker_type, description, related_pattern_id, run_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(
    id,
    body.companion_id,
    marker_type,
    body.description,
    body.related_pattern_id ?? null,
    run_id,
  ).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/growth/markers/:companion_id
export async function getGrowthMarkers(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const rows = await env.DB.prepare(
    "SELECT * FROM growth_markers WHERE companion_id = ? ORDER BY created_at DESC"
  ).bind(companion_id).all();

  return json({ markers: rows.results });
}
