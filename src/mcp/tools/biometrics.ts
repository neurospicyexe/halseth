import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";
import type { BiometricSnapshot } from "../../types.js";

export function registerBiometricTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_biometric_log",
    "Log a biometric snapshot from Apple Health. Call this after reading health data. All fields except recorded_at are optional — log whatever is available.",
    {
      recorded_at:   z.string().describe("ISO timestamp of the actual measurement from Apple Health."),
      hrv_resting:   z.number().optional().describe("Heart rate variability in ms (SDNN or RMSSD)."),
      resting_hr:    z.number().int().optional().describe("Resting heart rate in bpm."),
      sleep_hours:   z.number().optional().describe("Total sleep duration in hours."),
      sleep_quality: z.enum(["poor", "fair", "good", "excellent"]).optional(),
      stress_score:  z.number().int().min(0).max(100).optional().describe("Stress level 0-100 if available."),
      steps:         z.number().int().optional(),
      active_energy: z.number().optional().describe("Active energy burned in kcal."),
      notes:         z.string().optional().describe("Any additional context about this snapshot."),
    },
    async (input) => {
      const id = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO biometric_snapshots
          (id, recorded_at, logged_at, source, hrv_resting, resting_hr,
           sleep_hours, sleep_quality, stress_score, steps, active_energy, notes)
        VALUES (?, ?, ?, 'apple_health', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.recorded_at,
        now,
        input.hrv_resting   ?? null,
        input.resting_hr    ?? null,
        input.sleep_hours   ?? null,
        input.sleep_quality ?? null,
        input.stress_score  ?? null,
        input.steps         ?? null,
        input.active_energy ?? null,
        input.notes         ?? null,
      ).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ id, logged_at: now }) }],
      };
    },
  );

  server.tool(
    "halseth_biometric_read",
    "Read recent biometric snapshots. Returns newest first.",
    {
      limit: z.number().int().min(1).max(30).default(7),
    },
    async (input) => {
      const result = await env.DB.prepare(
        "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT ?"
      ).bind(input.limit).all<BiometricSnapshot>();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results ?? []) }],
      };
    },
  );
}
