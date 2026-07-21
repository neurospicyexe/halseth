// Fix 1 (2026-07-21): GET /handovers already LEFT JOINed sessions for session_type +
// front_state but dropped companion_id, the one field that says WHOSE handover this is.
// Locks in that the SELECT now carries s.companion_id AS companion_id and that it flows
// through to the response for both a matched session and an orphaned handover (no session
// row -- LEFT JOIN legitimately produces companion_id: null there, not an error).

import { describe, it, expect } from "vitest";
import { getHandovers } from "../handlers/history.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

const ADMIN = "test-admin-secret";

function makeEnv(handovers: Row[], sessions: Row[]): { env: Env; preparedSql: string[] } {
  const preparedSql: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          bind(..._args: unknown[]) {
            return {
              async all() {
                if (sql.includes("FROM handover_packets")) {
                  // Emulate the LEFT JOIN: attach session_type/front_state/companion_id
                  // from the matching session row (by session_id), or nulls if none.
                  const joined = handovers.map((hp) => {
                    const s = sessions.find((row) => row["id"] === hp["session_id"]);
                    return {
                      ...hp,
                      session_type: s?.["session_type"] ?? null,
                      session_front_state: s?.["front_state"] ?? null,
                      companion_id: s?.["companion_id"] ?? null,
                    };
                  });
                  return { results: joined };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
    ADMIN_SECRET: ADMIN,
  } as unknown as Env;
  return { env, preparedSql };
}

function req(): Request {
  return new Request("http://local/handovers", {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
}

describe("getHandovers -- companion_id from joined session (fix 1)", () => {
  it("returns companion_id for a handover whose session matched", async () => {
    const { env, preparedSql } = makeEnv(
      [{ id: "hp1", session_id: "s1", created_at: "2026-07-21T00:00:00Z", spine: "x", motion_state: "at_rest" }],
      [{ id: "s1", session_type: "work", front_state: "cypher-front", companion_id: "cypher" }],
    );
    const res = await getHandovers(req(), env);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]!["companion_id"]).toBe("cypher");
    expect(body[0]!["session_type"]).toBe("work");
    const sql = preparedSql.find((s) => s.includes("FROM handover_packets"));
    expect(sql).toContain("s.companion_id AS companion_id");
  });

  it("returns companion_id: null for an orphaned handover (no matching session row)", async () => {
    const { env } = makeEnv(
      [{ id: "hp2", session_id: "gone", created_at: "2026-07-21T00:00:00Z", spine: "x", motion_state: "floating" }],
      [],
    );
    const res = await getHandovers(req(), env);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body[0]!["companion_id"]).toBeNull();
  });

  it("401s without a valid bearer", async () => {
    const { env } = makeEnv([], []);
    const res = await getHandovers(new Request("http://local/handovers"), env);
    expect(res.status).toBe(401);
  });
});
