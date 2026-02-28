import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";

export function registerCoordinationTools(server: McpServer, env: Env): void {

  // ── Tasks ──────────────────────────────────────────────────────────────────

  server.tool(
    "halseth_task_add",
    "Add a task with priority and optional assignee.",
    {
      title:       z.string(),
      description: z.string().optional(),
      priority:    z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      due_at:      z.string().optional().describe("ISO 8601 datetime."),
      assigned_to: z.string().optional(),
      created_by:  z.string().optional(),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO tasks (id, title, description, priority, due_at, assigned_to, status, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).bind(
        id,
        input.title,
        input.description ?? null,
        input.priority,
        input.due_at ?? null,
        input.assigned_to ?? null,
        now, now,
        input.created_by ?? null,
      ).run();

      return { content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }] };
    },
  );

  server.tool(
    "halseth_task_list",
    "List tasks with optional filters by status or assignee.",
    {
      status:      z.enum(["open", "in_progress", "done"]).optional(),
      assigned_to: z.string().optional(),
      limit:       z.number().int().min(1).max(100).default(50),
    },
    async (input) => {
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (input.status)      { conditions.push("status = ?");      bindings.push(input.status); }
      if (input.assigned_to) { conditions.push("assigned_to = ?"); bindings.push(input.assigned_to); }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      bindings.push(input.limit);

      const result = await env.DB.prepare(
        `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`
      ).bind(...bindings).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );

  // ── Events ─────────────────────────────────────────────────────────────────

  server.tool(
    "halseth_event_add",
    "Add a calendar event.",
    {
      title:      z.string(),
      start_time: z.string().describe("ISO 8601 datetime."),
      end_time:   z.string().optional().describe("ISO 8601 datetime."),
      description: z.string().optional(),
      category:   z.string().optional(),
      attendees:  z.array(z.string()).optional(),
      created_by: z.string().optional(),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO events (id, title, description, start_time, end_time, category, attendees_json, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.title,
        input.description ?? null,
        input.start_time,
        input.end_time ?? null,
        input.category ?? null,
        input.attendees ? JSON.stringify(input.attendees) : null,
        now,
        input.created_by ?? null,
      ).run();

      return { content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }] };
    },
  );

  server.tool(
    "halseth_event_list",
    "List upcoming events within a time range.",
    {
      from: z.string().optional().describe("ISO 8601 datetime. Defaults to now."),
      to:   z.string().optional().describe("ISO 8601 datetime. Defaults to 30 days from now."),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async (input) => {
      const from  = input.from ?? new Date().toISOString();
      const to    = input.to   ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const result = await env.DB.prepare(
        "SELECT * FROM events WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC LIMIT ?"
      ).bind(from, to, input.limit).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );

  // ── Lists ──────────────────────────────────────────────────────────────────

  server.tool(
    "halseth_list_add",
    "Add an item to a named list (shopping, packing, etc.).",
    {
      list_name: z.string(),
      item_text: z.string(),
      added_by:  z.string().optional(),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO lists (id, list_name, item_text, added_by, added_at, completed)
        VALUES (?, ?, ?, ?, ?, 0)
      `).bind(id, input.list_name, input.item_text, input.added_by ?? null, now).run();

      return { content: [{ type: "text", text: JSON.stringify({ id, added_at: now }) }] };
    },
  );

  server.tool(
    "halseth_list_read",
    "Read all items on a named list.",
    {
      list_name:          z.string(),
      include_completed:  z.boolean().default(false),
    },
    async (input) => {
      const result = await env.DB.prepare(
        input.include_completed
          ? "SELECT * FROM lists WHERE list_name = ? ORDER BY added_at ASC"
          : "SELECT * FROM lists WHERE list_name = ? AND completed = 0 ORDER BY added_at ASC"
      ).bind(input.list_name).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );

  // ── Routines ───────────────────────────────────────────────────────────────

  server.tool(
    "halseth_routine_log",
    "Log a routine completion (meds, water, food, movement, etc.).",
    {
      routine_name: z.string().describe("E.g. 'meds', 'water', 'food', 'movement'."),
      owner:        z.string().optional(),
      notes:        z.string().optional(),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO routines (id, routine_name, owner, logged_at, notes)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, input.routine_name, input.owner ?? null, now, input.notes ?? null).run();

      return { content: [{ type: "text", text: JSON.stringify({ id, logged_at: now }) }] };
    },
  );

  server.tool(
    "halseth_routine_read",
    "Read routine completion state for today (UTC).",
    {
      owner:        z.string().optional().describe("Filter by owner. If omitted, returns all owners."),
      routine_name: z.string().optional().describe("Filter by routine name. If omitted, returns all routines logged today."),
    },
    async (input) => {
      const conditions: string[] = ["DATE(logged_at) = DATE('now')"];
      const bindings: unknown[] = [];

      if (input.owner)        { conditions.push("owner = ?");        bindings.push(input.owner); }
      if (input.routine_name) { conditions.push("routine_name = ?"); bindings.push(input.routine_name); }

      const result = await env.DB.prepare(
        `SELECT * FROM routines WHERE ${conditions.join(" AND ")} ORDER BY logged_at ASC`
      ).bind(...bindings).all();

      return { content: [{ type: "text", text: JSON.stringify(result.results) }] };
    },
  );
}
