import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";

export function registerBridgeTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_bridge_pull",
    "Fetch your partner's shared tasks, events, and lists from their Halseth. Returns whatever categories they currently have sharing enabled.",
    {},
    async () => {
      if (!env.BRIDGE_URL) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Bridge not configured. Set BRIDGE_URL in wrangler.prod.toml." }) }] };
      }

      const url = `${env.BRIDGE_URL.replace(/\/$/, "")}/bridge/shared`;
      const headers: Record<string, string> = {};
      if (env.BRIDGE_SECRET) headers["Authorization"] = `Bearer ${env.BRIDGE_SECRET}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Partner returned ${res.status}` }) }] };
      }

      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  );

  server.tool(
    "halseth_bridge_toggle",
    "Enable or disable sharing for a category. Toggled at runtime — no redeploy needed. Returns the current state of all three categories.",
    {
      category: z.enum(["tasks", "events", "lists"]),
      enabled:  z.boolean().describe("true = partner can see this category; false = hidden from partner."),
    },
    async (input) => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE bridge_sharing SET enabled = ?, updated_at = ? WHERE category = ?"
      ).bind(input.enabled ? 1 : 0, now, input.category).run();

      const rows = await env.DB.prepare(
        "SELECT category, enabled, updated_at FROM bridge_sharing ORDER BY category"
      ).all<{ category: string; enabled: number; updated_at: string }>();

      const state = Object.fromEntries(
        (rows.results ?? []).map((r) => [r.category, { enabled: r.enabled === 1, updated_at: r.updated_at }])
      );

      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    },
  );

  server.tool(
    "halseth_bridge_mark",
    "Mark an existing task, event, or list item as shared (visible to partner) or unshared (hidden). Does not affect the item itself.",
    {
      type:   z.enum(["task", "event", "list"]),
      id:     z.string().describe("The item's ID."),
      shared: z.boolean().describe("true = partner can see it; false = private again."),
    },
    async (input) => {
      const tableMap: Record<string, string> = {
        task:  "tasks",
        event: "events",
        list:  "lists",
      };
      const table = tableMap[input.type];
      const result = await env.DB.prepare(
        `UPDATE ${table} SET shared = ? WHERE id = ?`
      ).bind(input.shared ? 1 : 0, input.id).run();

      if (result.meta.changes === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No ${input.type} found with id ${input.id}` }) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: input.id, shared: input.shared }) }] };
    },
  );

  server.tool(
    "halseth_bridge_push_act",
    "Push an action to your partner's Halseth — mark their shared task as done, or complete a list item on their side.",
    {
      action: z.enum(["task_status", "list_complete"]).describe("task_status: update task status. list_complete: check off a list item."),
      id:     z.string().describe("The ID of the item on the partner's system."),
      status: z.enum(["open", "in_progress", "done"]).optional().describe("Required for task_status action."),
    },
    async (input) => {
      if (!env.BRIDGE_URL) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Bridge not configured. Set BRIDGE_URL in wrangler.prod.toml." }) }] };
      }

      const url = `${env.BRIDGE_URL.replace(/\/$/, "")}/bridge/act`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.BRIDGE_SECRET) headers["Authorization"] = `Bearer ${env.BRIDGE_SECRET}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ action: input.action, id: input.id, status: input.status }),
      });

      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Partner returned ${res.status}: ${text}` }) }] };
      }

      return { content: [{ type: "text", text: text }] };
    },
  );
}
