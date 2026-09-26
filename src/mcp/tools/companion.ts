import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { COMPANION_IDS } from "../../companions.js";
import { generateId } from "../../db/queries.js";
import { embedAndStoreAsync } from "../embed.js";
import { journalInsert, journalBirthState } from "../../webmind/tray-insert.js";
import { KEPT_SQL } from "../../webmind/review-state.js";
import { classifyDomainTags, classifyKeywordTags } from "../../synthesis/tag-classifier.js";

export function registerCompanionTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_companion_note_add",
    "Log a companion self-discovery or identity claim to the companion journal. Attributed to the agent — never to Raziel. Append-only by covenant. If this note involves encountering, observing, or interacting with a system member (fronter from the plural system), also call log_front_change in the Nullsafe-Plural MCP to record the fronter encounter.",
    {
      agent:      z.enum(COMPANION_IDS).describe("The companion making this claim. Attribution is sacred."),
      note_text:  z.string().describe("The self-discovery or identity claim, in the companion's own voice."),
      tags:       z.array(z.string()).optional().describe("Optional tags for categorization. E.g. ['identity', 'boundary', 'desire']."),
      session_id: z.string().optional().describe("Session this note belongs to, if any."),
      source:     z.enum(["session", "autonomous"]).optional().describe("Origin context. Pass 'autonomous' during autonomous time to tag the write for corpus analysis."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      const resolvedTags = input.tags ? JSON.stringify(input.tags) : JSON.stringify(classifyDomainTags(input.note_text));
      const topicTags = JSON.stringify(classifyKeywordTags(input.note_text));

      // The birth rule (tray pass 2, 2026-09-26): this tool used to INSERT with no review_state, so a
      // source:'autonomous' write here was born kept while the same words through the Librarian were
      // drafted. journalInsert() is the one INSERT; it stamps review_state from reviewStateFor().
      await journalInsert(env.DB, {
        id, created_at: now, agent: input.agent, note_text: input.note_text, tags: resolvedTags,
        session_id: input.session_id ?? null, source: input.source ?? null, topic_tags: topicTags,
      }).run();

      // Awaited: the bare embedAndStore() was a floating promise Workers cancels after the response.
      await embedAndStoreAsync(env, input.note_text, "companion_journal", id, input.agent)
        .catch((err) => console.warn("[mcp companion_note_add] embed failed (row kept, index stale):", String(err)));
      const review_state = journalBirthState({ source: input.source ?? null });
      return { content: [{ type: "text", text: JSON.stringify({ id, created_at: now, review_state }) }] };
    },
  );

  server.tool(
    "halseth_companion_notes_read",
    "Read entries from the companion journal. Filterable by agent and session.",
    {
      agent:      z.enum(COMPANION_IDS).optional().describe("Filter by companion. If omitted, returns all agents."),
      session_id: z.string().optional().describe("Filter by session ID."),
      limit:      z.number().int().min(1).max(100).default(20),
      include_drafts: z.boolean().optional().describe("Default false: only kept entries (memory). true also returns drafts and dropped rows, each with its review_state -- for reviewing, never for recall."),
    },
    async (input) => {
      // Kept by default (tray pass 2): an agent reads this as the companion's own journal, so a draft
      // here is recall by another door. include_drafts is the explicit, per-call opt-out.
      const conditions: string[] = input.include_drafts ? ["archived = 0"] : ["archived = 0", KEPT_SQL];
      const bindings: unknown[]  = [];

      if (input.agent)      { conditions.push("agent = ?");      bindings.push(input.agent); }
      if (input.session_id) { conditions.push("session_id = ?"); bindings.push(input.session_id); }

      const where = `WHERE ${conditions.join(" AND ")}`;
      bindings.push(input.limit);

      const result = await env.DB.prepare(
        `SELECT * FROM companion_journal ${where} ORDER BY created_at DESC LIMIT ?`
      ).bind(...bindings).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );
}
