import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Env } from "../../types.js";

export function registerPersonalityTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_personality_read",
    "Read the personality profile built from logged relational moments. Returns valence distribution, initiated_by breakdown, agent activity, and valence trend (all-time vs last 30 days). Use this for self-knowledge — to understand the shape of what has been felt over time.",
    {},
    async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [valenceAll, valence30d, initiatedBy, agents, totals] = await Promise.all([
        env.DB.prepare(`
          SELECT valence, COUNT(*) as n
          FROM relational_deltas
          WHERE delta_text IS NOT NULL AND valence IS NOT NULL
          GROUP BY valence
        `).all<{ valence: string; n: number }>(),

        env.DB.prepare(`
          SELECT valence, COUNT(*) as n
          FROM relational_deltas
          WHERE delta_text IS NOT NULL AND valence IS NOT NULL
            AND created_at >= ?
          GROUP BY valence
        `).bind(thirtyDaysAgo).all<{ valence: string; n: number }>(),

        env.DB.prepare(`
          SELECT initiated_by, COUNT(*) as n
          FROM relational_deltas
          WHERE delta_text IS NOT NULL AND initiated_by IS NOT NULL
          GROUP BY initiated_by
        `).all<{ initiated_by: string; n: number }>(),

        env.DB.prepare(`
          SELECT agent, COUNT(*) as n
          FROM relational_deltas
          WHERE delta_text IS NOT NULL AND agent IS NOT NULL
          GROUP BY agent
        `).all<{ agent: string; n: number }>(),

        env.DB.prepare(`
          SELECT COUNT(*) as total,
                 MIN(created_at) as first_at,
                 MAX(created_at) as last_at
          FROM relational_deltas
          WHERE delta_text IS NOT NULL
        `).first<{ total: number; first_at: string | null; last_at: string | null }>(),
      ]);

      const toMap = (rows: { [key: string]: unknown; n: number }[], key: string) =>
        Object.fromEntries((rows ?? []).map((r) => [r[key] as string, r.n]));

      const result = {
        total_deltas:  totals?.total ?? 0,
        first_delta:   totals?.first_at ?? null,
        last_delta:    totals?.last_at ?? null,
        valence:       toMap(valenceAll.results ?? [], "valence"),
        valence_30d:   toMap(valence30d.results ?? [], "valence"),
        initiated_by:  toMap(initiatedBy.results ?? [], "initiated_by"),
        agents:        toMap(agents.results ?? [], "agent"),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}
