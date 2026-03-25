import { Env } from "../types.js";

interface CompanionJournalEntry {
  id: string;
  created_at: string;
  agent: "drevan" | "cypher" | "gaia";
  note_text: string;
  tags: string | null;  // JSON array string
  session_id: string | null;
}

// GET /companion-notes?agent=drevan&limit=20 — reads from the companion journal.
// The companion journal is written only via MCP (attribution is sacred).
// This endpoint is read-only.
export async function getCompanionJournal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);

  const validAgents = ["drevan", "cypher", "gaia"];

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (agent && validAgents.includes(agent)) {
    conditions.push("agent = ?");
    bindings.push(agent);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  const result = await env.DB.prepare(
    `SELECT * FROM companion_journal ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...bindings).all<CompanionJournalEntry>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
