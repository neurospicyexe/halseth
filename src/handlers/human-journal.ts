// GET /journal — Human journal REST endpoint.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import type { HumanJournalEntry } from "../types.js";
import { journalAdd } from "../librarian/backends/halseth.js";

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, isNaN(n) ? def : n), max);
}

// GET /journal?limit=20&from=ISO&to=ISO
export async function getJournal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url   = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
  const from  = url.searchParams.get("from");
  const to    = url.searchParams.get("to");

  const conditions: string[] = [];
  const bindings: unknown[]  = [];

  if (from) {
    conditions.push("created_at >= ?");
    bindings.push(from);
  }
  if (to) {
    conditions.push("created_at <= ?");
    bindings.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  const result = await env.DB.prepare(`
    SELECT * FROM human_journal ${where} ORDER BY created_at DESC LIMIT ?
  `).bind(...bindings).all<HumanJournalEntry>();

  return new Response(JSON.stringify(result.results ?? []), {
    headers: { "Content-Type": "application/json" },
  });
}

// POST /journal -- Raziel's own entry from Hearth (the /mind "New Journal Entry" form).
// Until 2026-09-26 the only writer was the Librarian (execJournalAdd); Hearth posted to
// /mind/journal, a route that never existed here, so every entry from the form was lost.
// Body: { entry: string, tags?: string[] }. Same insert as the Librarian path (journalAdd).
export async function postJournal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json(400, { error: "Invalid JSON body" }); }

  const entry = typeof body.entry === "string" ? body.entry.trim() : "";
  if (!entry) return json(400, { error: "entry is required and must be non-empty" });
  if (entry.length > 8000) return json(413, { error: "entry exceeds 8000 characters" });

  const tags = Array.isArray(body.tags)
    ? JSON.stringify(body.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()))
    : undefined;

  const r = await journalAdd(env, { entry_text: entry, tags });
  return json(201, { ok: true, id: r.id, created_at: r.created_at });
}
