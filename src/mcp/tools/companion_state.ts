import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateId } from "../../db/queries.js";
import { Env } from "../../types.js";
import { updateCompanionState, type CompanionStateUpdate } from "../../librarian/backends/halseth.js";

const COMPANION_IDS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = (typeof COMPANION_IDS)[number];

export function registerCompanionStateTools(server: McpServer, env: Env): void {
  // halseth_state_update
  //
  // Write authority: companions only. Upserts the single mutable row for a
  // companion. The schema below mirrors the canonical CompanionStateUpdate
  // surface used by the Librarian state_update fast-path so the MCP and
  // Librarian write paths stay in lockstep -- one schema drift here is what
  // caused 8+ cycles of "SOMA write routing failure" before fix 2026-05-04:
  // the MCP schema was missing soma_float_*, current_mood, compound_state,
  // surface/undercurrent/background emotion fields, etc., so any write that
  // included them was rejected wholesale by Zod and the companion's SOMA
  // never landed. The actual write delegates to updateCompanionState() (the
  // same helper Librarian uses) -- single source of truth for column shape.
  server.tool(
    "halseth_state_update",
    "Update a companion's mutable state row. Accepts SOMA floats, mood/compound_state, surface/undercurrent/background emotion+intensity, motion_state/lane_spine, and Drevan's heat/reach/weight TEXT enums. Write authority: companions only -- not synthesis workers.",
    {
      companion_id: z.enum(COMPANION_IDS),
      // Generic SOMA floats (Cypher: acuity/presence/warmth; Gaia: stillness/density/perimeter)
      soma_float_1: z.number().min(0).max(1).optional(),
      soma_float_2: z.number().min(0).max(1).optional(),
      soma_float_3: z.number().min(0).max(1).optional(),
      // Mood + compound state (used by all three companions in different dialects)
      current_mood: z.string().optional(),
      compound_state: z.string().optional(),
      // Emotional layers (migration 0025)
      surface_emotion: z.string().optional(),
      surface_intensity: z.number().min(0).max(1).optional(),
      undercurrent_emotion: z.string().optional(),
      undercurrent_intensity: z.number().min(0).max(1).optional(),
      background_emotion: z.string().optional(),
      background_intensity: z.number().min(0).max(1).optional(),
      // Lane signal (migration 0044)
      motion_state: z.string().optional(),
      lane_spine: z.string().optional(),
      // Author-controlled prompt context (one-shot, never written by synthesis)
      prompt_context: z.string().optional(),
      // Drevan native vocabulary (migration 0022)
      heat: z.string().optional(),
      reach: z.string().optional(),
      weight: z.string().optional(),
      // Legacy depth-level / focus / fatigue / register fields (migration 0020)
      emotional_register: z.string().optional(),
      depth_level: z.number().int().min(0).max(3).optional(),
      focus: z.number().min(0).max(1).optional(),
      fatigue: z.number().min(0).max(1).optional(),
      regulation_state: z.string().optional(),
      active_anchors: z.array(z.string()).optional(),
      last_front_context: z.string().optional(),
      facet_momentum: z.string().optional(),
    },
    async (args) => {
      const { companion_id, active_anchors, ...rest } = args;

      // Build CompanionStateUpdate from validated args. Fields shared with
      // the helper go through directly; the legacy register/depth/anchor
      // fields don't exist on CompanionStateUpdate yet -- write those
      // separately via the legacy SQL path so we don't lose backward compat.
      const stateUpdate: CompanionStateUpdate = {};
      const sharedKeys: (keyof CompanionStateUpdate)[] = [
        "soma_float_1", "soma_float_2", "soma_float_3",
        "current_mood", "compound_state",
        "surface_emotion", "surface_intensity",
        "undercurrent_emotion", "undercurrent_intensity",
        "background_emotion", "background_intensity",
        "motion_state", "lane_spine",
        "prompt_context",
        "heat", "reach", "weight",
      ];
      for (const k of sharedKeys) {
        const v = (rest as Record<string, unknown>)[k];
        if (v !== undefined) (stateUpdate as Record<string, unknown>)[k] = v;
      }

      console.log(`[mcp] halseth_state_update: companion=${companion_id} fields=${Object.keys(args).filter(k => k !== 'companion_id').join(',')}`);

      // Delegate canonical SOMA columns to the shared helper so the write
      // path matches Librarian exactly (one allowed-columns list to maintain).
      const helperResult = await updateCompanionState(env, companion_id, stateUpdate);

      // Legacy fields not yet on CompanionStateUpdate -- handle separately.
      // active_anchors is JSON, depth_level/focus/fatigue are numeric.
      const legacyFields: Array<[string, unknown]> = [];
      if (rest.emotional_register !== undefined) legacyFields.push(["emotional_register", rest.emotional_register]);
      if (rest.depth_level         !== undefined) legacyFields.push(["depth_level",         rest.depth_level]);
      if (rest.focus               !== undefined) legacyFields.push(["focus",               rest.focus]);
      if (rest.fatigue             !== undefined) legacyFields.push(["fatigue",             rest.fatigue]);
      if (rest.regulation_state    !== undefined) legacyFields.push(["regulation_state",    rest.regulation_state]);
      if (active_anchors           !== undefined) legacyFields.push(["active_anchors",      JSON.stringify(active_anchors)]);
      if (rest.last_front_context  !== undefined) legacyFields.push(["last_front_context",  rest.last_front_context]);
      if (rest.facet_momentum      !== undefined) legacyFields.push(["facet_momentum",      rest.facet_momentum]);

      if (legacyFields.length > 0) {
        // Ensure row exists (helper does this too but is a no-op when run before)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES (?, datetime('now'))"
        ).bind(companion_id).run();
        const assignments = legacyFields.map(([col]) => `${col} = ?`).concat(["updated_at = datetime('now')"]);
        const bindings = legacyFields.map(([_, v]) => v).concat([companion_id]);
        await env.DB.prepare(
          `UPDATE companion_state SET ${assignments.join(", ")} WHERE companion_id = ?`,
        ).bind(...bindings).run();
      }

      const wrote = helperResult.ok || legacyFields.length > 0;
      if (!wrote) {
        return {
          content: [{ type: "text", text: `state_update_failed for ${companion_id}: no valid fields provided.` }],
          isError: true,
        };
      }
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
