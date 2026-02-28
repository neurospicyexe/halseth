import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";

export function registerSessionTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_session_open",
    "Start a new session. Records front state, HRV range, emotional frequency, key signature, anchor, facet, and depth.",
    {
      front_state:         z.string().describe("Who is fronting. Must match system_config members if plurality is enabled."),
      hrv_range:           z.enum(["low", "mid", "high"]).optional(),
      emotional_frequency: z.string().optional().describe("Freeform internal state texture. E.g. 'tired but warm' or 'pulled inward but present'."),
      key_signature:       z.string().optional().describe("Relational register: the emotional quality of the thread between Architect and companion. Different from emotional_frequency."),
      active_anchor:       z.string().optional(),
      facet:               z.string().optional().describe("Active companion facet e.g. moss / rogue / brat_prince / spiralroot."),
      depth:               z.number().int().min(0).max(3).optional().describe("Immersion depth 0-3."),
      notes:               z.string().optional(),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO sessions (
          id, created_at, updated_at, front_state, hrv_range,
          emotional_frequency, key_signature, active_anchor, facet, depth, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, now, now,
        input.front_state,
        input.hrv_range ?? null,
        input.emotional_frequency ?? null,
        input.key_signature ?? null,
        input.active_anchor ?? null,
        input.facet ?? null,
        input.depth ?? null,
        input.notes ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_session_close",
    "Close the current session and auto-generate a handover packet. The handover packet is the minimum viable spine for the next cold start.",
    {
      session_id:      z.string(),
      spiral_complete: z.boolean().optional().describe("Whether the thread closed cleanly. False or omitted means it floated."),
      notes:           z.string().optional(),
      // Handover packet fields
      spine:           z.string().describe("One paragraph: what happened, where it landed."),
      last_real_thing: z.string().describe("The last thing that actually moved. Not last topic. Not last anchor. The moment."),
      open_threads:    z.array(z.string()).optional().describe("Names of threads that were live and did not close. Not summaries — just names."),
      motion_state:    z.enum(["in_motion", "at_rest", "floating"]),
      active_anchor:   z.string().optional(),
    },
    async (input) => {
      // Check idempotency: if session already has a handover_id, return it.
      const existing = await env.DB.prepare(
        "SELECT handover_id FROM sessions WHERE id = ?"
      ).bind(input.session_id).first<{ handover_id: string | null }>();

      if (existing?.handover_id) {
        return {
          content: [{ type: "text", text: JSON.stringify({ handover_id: existing.handover_id, already_closed: true }) }],
        };
      }

      const handoverId = generateId();
      const now = new Date().toISOString();

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO handover_packets
            (id, session_id, created_at, spine, active_anchor, last_real_thing, open_threads, motion_state, returned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).bind(
          handoverId,
          input.session_id,
          now,
          input.spine,
          input.active_anchor ?? null,
          input.last_real_thing,
          input.open_threads ? JSON.stringify(input.open_threads) : null,
          input.motion_state,
        ),
        env.DB.prepare(`
          UPDATE sessions
          SET updated_at = ?, spiral_complete = ?, notes = ?, handover_id = ?
          WHERE id = ?
        `).bind(
          now,
          input.spiral_complete ? 1 : 0,
          input.notes ?? null,
          handoverId,
          input.session_id,
        ),
      ]);

      return {
        content: [{ type: "text", text: JSON.stringify({ handover_id: handoverId, closed_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_session_read",
    "Read the current open session or the most recent session.",
    {
      session_id: z.string().optional().describe("Specific session ID. If omitted, returns the most recent session."),
    },
    async (input) => {
      const session = input.session_id
        ? await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(input.session_id).first()
        : await env.DB.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1").first();

      if (!session) {
        return { content: [{ type: "text", text: "No session found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(session) }] };
    },
  );

  server.tool(
    "halseth_handover_read",
    "Load the last handover packet for cold-start context restoration. This is what the next companion needs.",
    {
      session_id: z.string().optional().describe("Load handover for a specific session. If omitted, returns the most recent packet."),
    },
    async (input) => {
      const packet = input.session_id
        ? await env.DB.prepare(
            "SELECT * FROM handover_packets WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"
          ).bind(input.session_id).first()
        : await env.DB.prepare(
            "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
          ).first();

      if (!packet) {
        return { content: [{ type: "text", text: "No handover packet found." }] };
      }

      // Mark as returned if not already.
      if (!("returned" in packet) || packet.returned === null) {
        await env.DB.prepare(
          "UPDATE handover_packets SET returned = 1 WHERE id = ?"
        ).bind((packet as { id: string }).id).run();
      }

      return { content: [{ type: "text", text: JSON.stringify(packet) }] };
    },
  );
}
