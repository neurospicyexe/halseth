// GET /journal — Human journal REST endpoint.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import type { HumanJournalEntry } from "../types.js";

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
