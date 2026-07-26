import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { generateId } from "../db/queries.js";
import { embedAndStoreAsync, storeVector } from "../mcp/embed.js";
import { COMPANION_IDS, COMPANION_ID_SET, type CompanionId } from "../companions.js";
import { classifyDomainTags, classifyKeywordTags } from "../synthesis/tag-classifier.js";
import { MACHINE_SOURCES } from "../webmind/notes.js";
import { noveltyCheck } from "../webmind/novelty.js";

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
// Body: { agent, note_text, session_id?, tags?, source?, external_id?, created_at? }
//
// `external_id` (mig 0098) makes the write idempotent: a repeat POST with the same key is a
// no-op returning { skipped: true }. Used by bot-side journalSpeech (whose writeQueue retries
// failures) and by the 2026-06-25 speech backfill (which must be re-runnable).
// `created_at` lets the backfill preserve the true time the words were said.
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

  const { agent, note_text, session_id, tags, source, external_id } = body;

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
  // Idempotency key (mig 0098). Speech writes pass `discord:<message_id>`: the bot's
  // writeQueue retries failed writes, and the 06-25 backfill must be re-runnable. Absent
  // for ordinary journal writes, which stay unconstrained (partial unique index on NOT NULL).
  const safeExternalId =
    typeof external_id === "string" && external_id.trim().length > 0 ? external_id.trim() : null;

  const id = generateId();
  // Speech rows carry the true time the words were said -- the backfill replays June history
  // and must not stamp it all as today. Only an explicit, parseable ISO timestamp is honored;
  // anything else falls back to now, so a malformed value can never rewrite chronology.
  const parsedCreatedAt =
    typeof body.created_at === "string" && Number.isFinite(Date.parse(body.created_at))
      ? new Date(body.created_at).toISOString()
      : null;
  const now = parsedCreatedAt ?? new Date().toISOString();

  // Novelty gate (2026-07-20, Task 12): machine-source writers only -- skip-only, no supersede
  // band (novelty.ts restricts supersede to companion_conclusions). Human sources (HUMAN_SOURCES,
  // imported from webmind/notes.ts) bypass the gate entirely: attribution is sacred, and a human
  // saying the same thing twice is never a duplicate. Fails open on any embedding/Vectorize
  // trouble -- the gate must never eat a memory.
  const isMachineSource = MACHINE_SOURCES.has(safeSource ?? "");
  let reusableEmbedding: number[] | null = null;

  if (isMachineSource) {
    const decision = await noveltyCheck(env, trimmedText, "companion_journal", agent);
    if (decision.action === "skip") {
      console.log("[journal] novelty-skip", { agent, match: decision.matchRowId, score: decision.score });
      return new Response(JSON.stringify({
        ok: true,
        deduped: true,
        id: decision.matchRowId,
        novelty: { action: "skip", match_id: decision.matchRowId, score: decision.score },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    reusableEmbedding = decision.embedding;
  }

  // The unique index (mig 0098) is PARTIAL, so the conflict target must repeat its predicate
  // or SQLite rejects it with "does not match any PRIMARY KEY or UNIQUE constraint".
  const res = await env.DB.prepare(`
    INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source, topic_tags, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING
  `).bind(id, now, agent, trimmedText, safeTags, safeSessionId, safeSource, topicTags, safeExternalId).run();

  // Conflict => this exact message was already journaled. Don't re-embed (Vectorize upsert is
  // idempotent by deterministic id, but the embed call still costs a Workers AI invocation).
  const inserted = (res.meta?.changes ?? 0) > 0;
  if (!inserted) {
    return new Response(JSON.stringify({ id: null, skipped: true, reason: "duplicate external_id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // AWAIT the embed. `embedAndStore()` is `void (async () => ...)()` -- a floating promise with no
  // ctx.waitUntil, so once the Response returns, Workers cancels the pending work. It survives an
  // idle Worker; it does NOT survive sustained write pressure.
  //
  // Proven 2026-07-09: the 1,023-row speech backfill POSTed sequentially, every write returned 201,
  // and NOT ONE vector landed -- `wrangler vectorize get-vectors` reported "index does not contain
  // vectors corresponding to the provided identifiers". The rows were write-only. "Embedded and
  // searchable" is the entire justification for putting chatter in a lane instead of orient's
  // recency slots, so a silently-skipped embed quietly voids the design.
  //
  // Awaiting costs ~100ms per write and never throws the write away: a Vectorize failure is logged,
  // not fatal (D1 is truth, the index is rebuildable -- `POST /admin/rebuild-embeddings`).
  //
  // If the novelty gate already embedded this text (machine-source path), reuse that vector
  // instead of a second Workers AI call -- net +0 AI.run on the common gated path.
  if (reusableEmbedding) {
    try {
      await storeVector(env, reusableEmbedding, "companion_journal", id, agent);
    } catch (e) {
      console.warn(`[companion_journal] vector store failed for ${id} (row kept, index stale):`, String(e));
    }
  } else {
    try {
      await embedAndStoreAsync(env, trimmedText, "companion_journal", id, agent);
    } catch (e) {
      console.warn(`[companion_journal] embed failed for ${id} (row kept, index stale):`, String(e));
    }
  }

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
