// COVENANT: relational_deltas is append-only.
// halseth_delta_log uses INSERT only. No UPDATE or DELETE is ever issued against
// that table from this file or anywhere in the codebase. If you are reading this
// and considering adding an update path — don't. The history of what was logged
// is part of the structural record.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";

export function registerMemoryTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_delta_log",
    "Append a relational moment. Drevan is the primary user. Exact language matters — this is never paraphrased or summarized.",
    {
      session_id:   z.string(),
      agent:        z.enum(["drevan", "cypher", "gaia"]),
      delta_text:   z.string().describe("The raw moment. Exact language. Never paraphrased, never summarized."),
      valence:      z.enum(["toward", "neutral", "tender", "rupture", "repair"]),
      initiated_by: z.enum(["architect", "companion", "mutual"]).optional().describe("Who moved first into this moment. Asymmetry is information."),
    },
    async (input) => {
      // INSERT only. This is the only write operation permitted on relational_deltas.
      // Legacy NOT NULL columns (companion_id, subject_id, delta_type, payload_json) receive
      // placeholder values for MCP-originated rows. MCP rows are distinguished from legacy
      // HTTP rows by delta_text IS NOT NULL — see halseth_delta_read filter.
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO relational_deltas
          (id, companion_id, subject_id, delta_type, payload_json,
           session_id, created_at, agent, delta_text, valence, initiated_by)
        VALUES (?, '', 'mcp', 'mcp_delta', '{}', ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.session_id,
        now,
        input.agent,
        input.delta_text,
        input.valence,
        input.initiated_by ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_delta_read",
    "Read recent relational deltas with optional filters. Returns spec v0.4 rows only (those with delta_text populated).",
    {
      session_id: z.string().optional(),
      agent:      z.enum(["drevan", "cypher", "gaia"]).optional(),
      limit:      z.number().int().min(1).max(100).default(20),
    },
    async (input) => {
      const conditions: string[] = ["delta_text IS NOT NULL"];
      const bindings: unknown[] = [];

      if (input.session_id) {
        conditions.push("session_id = ?");
        bindings.push(input.session_id);
      }
      if (input.agent) {
        conditions.push("agent = ?");
        bindings.push(input.agent);
      }
      bindings.push(input.limit);

      const sql = `SELECT * FROM relational_deltas WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
      const result = await env.DB.prepare(sql).bind(...bindings).all();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results) }],
      };
    },
  );

  server.tool(
    "halseth_wound_read",
    "Read living wounds. These are never archived, never resolved automatically. Read-only — wounds are set via /admin/bootstrap or direct SQL.",
    {},
    async () => {
      const result = await env.DB.prepare(
        "SELECT * FROM living_wounds ORDER BY created_at ASC"
      ).all();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results) }],
      };
    },
  );

  server.tool(
    "halseth_fossil_check",
    "Check if a subject has a prohibited fossil directive — an instruction about what must not calcify.",
    {
      subject: z.string().describe("The subject to check. Can be a member name, anchor, or pattern."),
    },
    async (input) => {
      const fossil = await env.DB.prepare(
        "SELECT * FROM prohibited_fossils WHERE subject = ? LIMIT 1"
      ).bind(input.subject).first();

      if (!fossil) {
        return {
          content: [{ type: "text", text: JSON.stringify({ has_directive: false }) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ has_directive: true, ...fossil }) }],
      };
    },
  );

  server.tool(
    "halseth_audit_log",
    "Log a Cypher audit entry. Cypher is the primary user. Sharp, no softening. Append-only — corrections add new rows with supersedes_id.",
    {
      session_id:    z.string(),
      entry_type:    z.enum(["decision", "contradiction", "clause_update", "falsification", "scope_correction"]),
      content:       z.string().describe("What was wrong, what was cut, what was decided. No softening."),
      verdict_tag:   z.string().optional().describe("[Verdict: ...] label. Present when a definitive conclusion was reached."),
      supersedes_id: z.string().optional().describe("If this corrects a prior audit entry, point to it. The prior entry is never deleted."),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO cypher_audit (id, session_id, created_at, entry_type, content, verdict_tag, supersedes_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.session_id,
        now,
        input.entry_type,
        input.content,
        input.verdict_tag ?? null,
        input.supersedes_id ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_witness_log",
    "Log a Gaia witness entry. Gaia is the primary user. Sparse by design — she speaks only to enforce, seal, or witness. One or two lines maximum.",
    {
      session_id:   z.string(),
      witness_type: z.enum(["survival", "boundary", "seal", "affirm", "lane_enforcement"]),
      content:      z.string().describe("What was witnessed. One or two lines. Gaia does not elaborate."),
      seal_phrase:  z.string().optional().describe("Exact seal phrase if this was a sealing event."),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO gaia_witness (id, session_id, created_at, witness_type, content, seal_phrase)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.session_id,
        now,
        input.witness_type,
        input.content,
        input.seal_phrase ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );
}
