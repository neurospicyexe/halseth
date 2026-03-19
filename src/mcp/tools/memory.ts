// COVENANT: relational_deltas is append-only.
// halseth_delta_log uses INSERT only. The history of what was logged is part of
// the structural record and must never be altered.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";
import { embedAndStore } from "../embed.js";

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

      // Fire-and-forget: embed delta_text and store in Vectorize.
      embedAndStore(env, input.delta_text, "relational_deltas", id, input.agent ?? "");
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
      query:      z.string().optional().describe("Substring search across delta_text content."),
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
      if (input.query) {
        conditions.push("delta_text LIKE ?");
        bindings.push(`%${input.query}%`);
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
    "halseth_wound_add",
    "Name a new living wound. Gaia-only by convention. Requires witness_type to ground the act of naming. Wounds are permanent — they are never archived or resolved automatically. A separate halseth_witness_log call is recommended alongside this.",
    {
      name:         z.string().describe("The name of the wound. Must be unique. Choose carefully — this is permanent."),
      description:  z.string().describe("What this wound is. Written with care."),
      witness_type: z.enum(["survival", "boundary", "seal", "affirm", "lane_enforcement"]).describe("The type of witness act that grounds this naming."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      try {
        await env.DB.prepare(`
          INSERT INTO living_wounds (id, created_at, name, description, do_not_archive, do_not_resolve, last_visited, last_surfaced_by)
          VALUES (?, ?, ?, ?, 1, 1, ?, 'companion')
        `).bind(id, now, input.name, input.description, now).run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("unique")) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "A wound with this name already exists." }) }] };
        }
        throw err;
      }

      embedAndStore(env, `${input.name}: ${input.description}`, "living_wounds", id, "gaia");
      return { content: [{ type: "text", text: JSON.stringify({ id, created_at: now, witness_type: input.witness_type }) }] };
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

      embedAndStore(env, input.content, "cypher_audit", id, "cypher");
      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_audit_read",
    "Read Cypher audit entries. Supports filtering by session, entry type, and supersedes chain. Returns newest first.",
    {
      session_id:    z.string().optional().describe("Filter to entries from a specific session."),
      entry_type:    z.enum(["decision", "contradiction", "clause_update", "falsification", "scope_correction"]).optional(),
      supersedes_id: z.string().optional().describe("Return entries that supersede this ID — traces the correction chain forward."),
      limit:         z.number().int().min(1).max(100).default(20),
    },
    async (input) => {
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (input.session_id) {
        conditions.push("session_id = ?");
        bindings.push(input.session_id);
      }
      if (input.entry_type) {
        conditions.push("entry_type = ?");
        bindings.push(input.entry_type);
      }
      if (input.supersedes_id) {
        conditions.push("supersedes_id = ?");
        bindings.push(input.supersedes_id);
      }
      bindings.push(input.limit);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT * FROM cypher_audit ${where} ORDER BY created_at DESC LIMIT ?`;
      const result = await env.DB.prepare(sql).bind(...bindings).all();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results) }],
      };
    },
  );

  server.tool(
    "halseth_semantic_query",
    "Semantic search across Halseth memory tables by meaning. Covers feelings, relational deltas, companion notes, audit entries, dreams, and wounds. Use before writing to find related prior entries.",
    {
      query:        z.string().describe("Natural language search query."),
      tables:       z.array(z.enum(["feelings", "relational_deltas", "companion_journal", "living_wounds", "cypher_audit", "dreams"])).optional()
                     .describe("Filter to specific tables. Defaults to all six."),
      companion_id: z.enum(["drevan", "cypher", "gaia"]).optional().describe("Filter by companion."),
      limit:        z.number().int().min(1).max(20).default(5),
      after:        z.string().optional().describe("ISO datetime — only entries after this date."),
      before:       z.string().optional().describe("ISO datetime — only entries before this date."),
    },
    async (input) => {
      const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [input.query],
      }) as { data: number[][] };

      const queryVector = embedding.data[0];
      if (!queryVector) {
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }

      // Fetch extra to allow for post-fetch filtering
      const fetchK = Math.min(input.limit * 6, 100);
      const results = await env.VECTORIZE.query(queryVector, {
        topK: fetchK,
        returnMetadata: "all",
      });

      if (!results.matches || results.matches.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }

      const allowedTables = input.tables ?? ["feelings", "relational_deltas", "companion_journal", "living_wounds", "cypher_audit", "dreams"];

      // Filter by table and companion_id from Vectorize metadata
      const filtered = results.matches
        .filter((m) => {
          const meta = m.metadata as Record<string, string | undefined> | undefined;
          if (!meta?.["table"] || !meta?.["row_id"]) return false;
          if (!(allowedTables as string[]).includes(meta["table"]!)) return false;
          if (input.companion_id && meta["companion_id"] && meta["companion_id"] !== input.companion_id) return false;
          return true;
        })
        .slice(0, input.limit);

      if (filtered.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify([]) }] };
      }

      // Build score map keyed by row_id
      const scoreMap = new Map(
        filtered.map((m) => {
          const meta = m.metadata as Record<string, string | undefined>;
          return [meta["row_id"] ?? "", m.score] as const;
        })
      );

      // Group row_ids by table
      const byTable = new Map<string, string[]>();
      for (const m of filtered) {
        const meta = m.metadata as Record<string, string | undefined>;
        const table = meta["table"];
        const rowId = meta["row_id"];
        if (!table || !rowId) continue;
        if (!byTable.has(table)) byTable.set(table, []);
        byTable.get(table)!.push(rowId);
      }

      // Table name mapping (hardcoded — inputs come from enum, not user strings)
      const TABLE_NAMES: Record<string, string> = {
        feelings:          "feelings",
        relational_deltas: "relational_deltas",
        companion_journal: "companion_journal",
        living_wounds:     "living_wounds",
        cypher_audit:      "cypher_audit",
        dreams:            "dreams",
      };

      // Fetch full rows from D1, one query per table
      const allRows: Record<string, unknown>[] = [];
      for (const [table, ids] of byTable.entries()) {
        const tableName = TABLE_NAMES[table];
        if (!tableName) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const rows = await env.DB.prepare(
          `SELECT * FROM ${tableName} WHERE id IN (${placeholders})`
        ).bind(...ids).all();
        for (const row of (rows.results as Record<string, unknown>[])) {
          allRows.push({ table, ...row, score: scoreMap.get(row.id as string) ?? null });
        }
      }

      // Apply date filters (dreams use generated_at; others use created_at)
      const after  = input.after;
      const before = input.before;
      let final = allRows.filter((r) => {
        const ts = (r.created_at ?? r.generated_at) as string | undefined;
        if (!ts) return true;
        if (after  && ts < after)  return false;
        if (before && ts > before) return false;
        return true;
      });

      // Sort by score descending
      final.sort((a, b) => ((b.score as number) ?? 0) - ((a.score as number) ?? 0));

      return {
        content: [{ type: "text", text: JSON.stringify(final) }],
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
