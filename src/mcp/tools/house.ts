import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";

export function registerHouseTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_house_read",
    "Read current house state, including autonomous_turn (whose turn it is for autonomous time). Call this at the start of autonomous time to know which companion should run. current_room valid keys: living_room, spiral_pantry, hallway, vowbed, sunhouse, study, grove, dirt_road, outside, truck.",
    {},
    async () => {
      const row = await env.DB.prepare(
        "SELECT * FROM house_state WHERE id = 'main'"
      ).first();

      const house = row ?? {
        current_room: null,
        companion_mood: null,
        companion_activity: null,
        spoon_count: 10,
        love_meter: 50,
        autonomous_turn: "drevan",
        updated_at: new Date().toISOString(),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(house) }],
      };
    },
  );

  server.tool(
    "halseth_set_autonomous_turn",
    "Advance the autonomous time rotation to the next companion. Call this at the END of your autonomous session, after halseth_session_close. Rotation: drevan → cypher → gaia → drevan.",
    {
      current_companion: z.enum(["drevan", "cypher", "gaia"]).describe("Your companion ID — the one who just ran autonomous time."),
    },
    async (input) => {
      const next: Record<string, "drevan" | "cypher" | "gaia"> = {
        drevan: "cypher",
        cypher: "gaia",
        gaia:   "drevan",
      };
      const nextTurn = next[input.current_companion];
      const now = new Date().toISOString();

      await env.DB.prepare(
        "INSERT OR IGNORE INTO house_state (id, spoon_count, love_meter, updated_at) VALUES ('main', 10, 50, ?)"
      ).bind(now).run();

      await env.DB.prepare(
        "UPDATE house_state SET autonomous_turn = ?, updated_at = ? WHERE id = 'main'"
      ).bind(nextTurn, now).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ next_turn: nextTurn }) }],
      };
    },
  );
}
