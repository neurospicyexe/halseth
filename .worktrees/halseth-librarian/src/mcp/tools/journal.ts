import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";
import type { HumanJournalEntry } from "../../types.js";

export function registerJournalTools(server: McpServer, env: Env): void {

  // ── halseth_journal_add ──────────────────────────────────────────────────────
  server.tool(
    "halseth_journal_add",
    "Add a human journal entry. Separate from companion_notes — this is the human's own voice.",
    {
      entry_text:  z.string().describe("The journal entry text."),
      emotion_tag: z.string().optional().describe("Primary emotion for this entry. E.g. 'grief', 'hope', 'relief'."),
      sub_emotion: z.string().optional().describe("Optional sub-type of the primary emotion."),
      mood_score:  z.number().int().min(0).max(100).optional().describe("Overall mood 0-100."),
      tags:        z.string().optional().describe("JSON array of string tags. E.g. '[\"work\", \"health\"]'."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO human_journal (id, created_at, entry_text, emotion_tag, sub_emotion, mood_score, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        now,
        input.entry_text,
        input.emotion_tag ?? null,
        input.sub_emotion ?? null,
        input.mood_score ?? null,
        input.tags ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  // ── halseth_journal_read ─────────────────────────────────────────────────────
  server.tool(
    "halseth_journal_read",
    "Read human journal entries. Returns newest first. Optionally filter by date range.",
    {
      limit: z.number().int().min(1).max(50).default(20).describe("Number of entries to return (1-50). Defaults to 20."),
      from:  z.string().optional().describe("ISO 8601 datetime. Return entries at or after this time."),
      to:    z.string().optional().describe("ISO 8601 datetime. Return entries at or before this time."),
    },
    async (input) => {
      const conditions: string[] = [];
      const bindings: unknown[]  = [];

      if (input.from) {
        conditions.push("created_at >= ?");
        bindings.push(input.from);
      }
      if (input.to) {
        conditions.push("created_at <= ?");
        bindings.push(input.to);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      bindings.push(input.limit);

      const result = await env.DB.prepare(`
        SELECT * FROM human_journal ${where} ORDER BY created_at DESC LIMIT ?
      `).bind(...bindings).all<HumanJournalEntry>();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results ?? []) }],
      };
    },
  );
}
