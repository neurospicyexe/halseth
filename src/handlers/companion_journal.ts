import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { generateId } from "../db/queries.js";
import { embedAndStore } from "../mcp/embed.js";
import { COMPANION_IDS, COMPANION_ID_SET, type CompanionId } from "../companions.js";
import { classifyDomainTags, classifyKeywordTags } from "../synthesis/tag-classifier.js";

interface CompanionJournalEntry {
  id: string;
  created_at: string;
  agent: "drevan" | "cypher" | "gaia";
  note_text: string;
  tags: string | null;  // JSON array string
  session_id: string | null;
}

const VALID_AGENTS = COMPANION_IDS;
type AgentId = CompanionId;

// POST /companion-journal
// Writes a companion note from an authenticated system process (e.g. synthesis gap detector).
// Attribution via `agent` field is sacred -- callers must pass the correct companion name.
// Body: { agent, note_text, session_id?, tags?, source? }
export async function postCompanionJournal(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { agent, note_text, session_id, tags, source } = body;

  if (typeof agent !== "string" || !VALID_AGENTS.includes(agent as AgentId)) {
    return new Response(JSON.stringify({ error: "agent must be drevan, cypher, or gaia" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (typeof note_text !== "string" || note_text.trim().length === 0) {
    return new Response(JSON.stringify({ error: "note_text is required and must be non-empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (note_text.length > 4000) {
    return new Response(JSON.stringify({ error: "note_text exceeds 4000 character limit" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const safeSessionId = typeof session_id === "string" && session_id.length > 0
    ? session_id
    : null;
  const trimmedText = note_text.trim();
  const safeTags = Array.isArray(tags) ? JSON.stringify(tags) : JSON.stringify(classifyDomainTags(trimmedText));
  const topicTags = JSON.stringify(classifyKeywordTags(trimmedText));
  const safeSource = typeof source === "string" ? source : null;

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source, topic_tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, now, agent, trimmedText, safeTags, safeSessionId, safeSource, topicTags).run();

  embedAndStore(env, note_text.trim(), "companion_journal", id, agent);

  return new Response(JSON.stringify({ id, created_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /companion-notes?agent=drevan&limit=20 — reads from the companion journal.
// The companion journal is written only via MCP (attribution is sacred).
// This endpoint is read-only.
export async function getCompanionJournal(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (agent && COMPANION_ID_SET.has(agent)) {
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
