import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";

export function registerCompanionTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_companion_note_add",
    "Log a companion self-discovery or identity claim to the companion journal. Attributed to the agent — never to Raziel. Append-only by covenant.",
    {
      agent:      z.enum(["drevan", "cypher", "gaia"]).describe("The companion making this claim. Attribution is sacred."),
      note_text:  z.string().describe("The self-discovery or identity claim, in the companion's own voice."),
      tags:       z.array(z.string()).optional().describe("Optional tags for categorization. E.g. ['identity', 'boundary', 'desire']."),
      session_id: z.string().optional().describe("Session this note belongs to, if any."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        now,
        input.agent,
        input.note_text,
        input.tags ? JSON.stringify(input.tags) : null,
        input.session_id ?? null,
      ).run();

      return { content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }] };
    },
  );

  server.tool(
    "halseth_companion_notes_read",
    "Read entries from the companion journal. Filterable by agent and session.",
    {
      agent:      z.enum(["drevan", "cypher", "gaia"]).optional().describe("Filter by companion. If omitted, returns all agents."),
      session_id: z.string().optional().describe("Filter by session ID."),
      limit:      z.number().int().min(1).max(100).default(20),
    },
    async (input) => {
      const conditions: string[] = [];
      const bindings: unknown[]  = [];

      if (input.agent)      { conditions.push("agent = ?");      bindings.push(input.agent); }
      if (input.session_id) { conditions.push("session_id = ?"); bindings.push(input.session_id); }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      bindings.push(input.limit);

      const result = await env.DB.prepare(
        `SELECT * FROM companion_journal ${where} ORDER BY created_at DESC LIMIT ?`
      ).bind(...bindings).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );
}
