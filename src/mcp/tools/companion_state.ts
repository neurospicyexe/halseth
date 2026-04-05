import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateId } from "../../db/queries.js";
import { Env } from "../../types.js";

const COMPANION_IDS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = (typeof COMPANION_IDS)[number];

export function registerCompanionStateTools(server: McpServer, env: Env): void {
  // halseth_state_update
  // Write authority: companions only. Upserts the single mutable row for a companion.
  server.tool(
    "halseth_state_update",
    "Update a companion's mutable state row. Write authority belongs to companions only -- not synthesis workers.",
    {
      companion_id: z.enum(COMPANION_IDS),
      emotional_register: z.string().optional(),
      depth_level: z.number().int().min(0).max(3).optional(),
      focus: z.number().min(0).max(1).optional(),
      fatigue: z.number().min(0).max(1).optional(),
      regulation_state: z.string().optional(),
      active_anchors: z.array(z.string()).optional(),
      last_front_context: z.string().optional(),
      facet_momentum: z.string().optional(),
      heat: z.string().optional(),
      reach: z.string().optional(),
      weight: z.string().optional(),
    },
    async (args) => {
      const {
        companion_id,
        emotional_register,
        depth_level,
        focus,
        fatigue,
        regulation_state,
        active_anchors,
        last_front_context,
        facet_momentum,
        heat,
        reach,
        weight,
      } = args;

      console.log(`[mcp] halseth_state_update: companion=${companion_id} fields=${Object.keys(args).filter(k => k !== 'companion_id').join(',')}`);

      await env.DB.prepare(
        `INSERT INTO companion_state (
          companion_id, emotional_register, depth_level, focus, fatigue,
          regulation_state, active_anchors, last_front_context,
          facet_momentum, heat, reach, weight, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(companion_id) DO UPDATE SET
          emotional_register  = COALESCE(excluded.emotional_register,  companion_state.emotional_register),
          depth_level         = COALESCE(excluded.depth_level,         companion_state.depth_level),
          focus               = COALESCE(excluded.focus,               companion_state.focus),
          fatigue             = COALESCE(excluded.fatigue,             companion_state.fatigue),
          regulation_state    = COALESCE(excluded.regulation_state,    companion_state.regulation_state),
          active_anchors      = COALESCE(excluded.active_anchors,      companion_state.active_anchors),
          last_front_context  = COALESCE(excluded.last_front_context,  companion_state.last_front_context),
          facet_momentum      = COALESCE(excluded.facet_momentum,      companion_state.facet_momentum),
          heat                = COALESCE(excluded.heat,                companion_state.heat),
          reach               = COALESCE(excluded.reach,              companion_state.reach),
          weight              = COALESCE(excluded.weight,              companion_state.weight),
          updated_at          = datetime('now')`
      )
        .bind(
          companion_id,
          emotional_register ?? null,
          depth_level ?? null,
          focus ?? null,
          fatigue ?? null,
          regulation_state ?? null,
          active_anchors ? JSON.stringify(active_anchors) : null,
          last_front_context ?? null,
          facet_momentum ?? null,
          heat ?? null,
          reach ?? null,
          weight ?? null
        )
        .run();

      return {
        content: [{ type: "text", text: `State updated for ${companion_id}.` }],
      };
    }
  );

  // halseth_drift_log
  // Append-only. Logs identity lane violations or register slips.
  server.tool(
    "halseth_drift_log",
    "Log a drift signal -- identity lane violation, register slip, or boundary miss. Append-only.",
    {
      companion_id: z.enum(COMPANION_IDS),
      signal_type: z.enum([
        "tone_break",
        "register_slip",
        "boundary_miss",
        "voice_drift",
        "other",
      ]),
      context: z.string().optional(),
    },
    async (args) => {
      const id = generateId();
      await env.DB.prepare(
        `INSERT INTO drift_log (id, companion_id, signal_type, context) VALUES (?, ?, ?, ?)`
      )
        .bind(id, args.companion_id, args.signal_type, args.context ?? null)
        .run();

      return {
        content: [
          {
            type: "text",
            text: `Drift signal logged (${args.signal_type}) for ${args.companion_id}. id=${id}`,
          },
        ],
      };
    }
  );

  // halseth_companion_note
  // Write an addressed note from one companion to another (or broadcast).
  server.tool(
    "halseth_companion_note",
    "Write an addressed note from one companion to another, or broadcast to all companions.",
    {
      from_id: z.enum(COMPANION_IDS),
      to_id: z.enum(COMPANION_IDS).optional(),
      content: z.string().min(1),
    },
    async (args) => {
      const id = generateId();
      await env.DB.prepare(
        `INSERT INTO inter_companion_notes (id, from_id, to_id, content) VALUES (?, ?, ?, ?)`
      )
        .bind(id, args.from_id, args.to_id ?? null, args.content)
        .run();

      const dest = args.to_id ?? "all companions";
      return {
        content: [
          {
            type: "text",
            text: `Note from ${args.from_id} to ${dest} logged. id=${id}`,
          },
        ],
      };
    }
  );
}
