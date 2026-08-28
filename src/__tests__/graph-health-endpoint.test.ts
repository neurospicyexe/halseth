// src/__tests__/graph-health-endpoint.test.ts
//
// GET /admin/graph/health (src/handlers/graph.ts::getGraphHealth) -- the outside-half readout the
// VPS standing health check (nullsafe-discord/ops/health-check.py) polls, since it cannot query D1
// directly. Three numbers, one query each: the nightly rebuild tick's own gate stamp, the count of
// the write-time-only 'live' provenance lane (never touched by rebuildGraph's mechanical DELETE),
// and the whole-table count. No thresholds/severity here -- that judgment lives in the script.

import { describe, it, expect } from "vitest";
import { getGraphHealth } from "../handlers/graph.js";
import { GRAPH_REBUILD_GATE_COMPANION_ID, GRAPH_REBUILD_GATE_KEY } from "../graph/tick.js";
import type { Env } from "../types.js";

function req(headers: Record<string, string> = { Authorization: "Bearer admin-tok" }): Request {
  return new Request("https://h.example/admin/graph/health", { method: "GET", headers });
}

function makeEnv(opts: {
  gateValue?: string | null;
  liveCount?: number;
  totalCount?: number;
} = {}): Env {
  const gateValue = "gateValue" in opts ? opts.gateValue ?? null : "2026-08-27T03:00:00.000Z";
  const liveCount = opts.liveCount ?? 4;
  const totalCount = opts.totalCount ?? 120;

  async function resolve<T>(sql: string): Promise<T> {
    if (sql.includes("FROM companion_settings")) {
      return (gateValue === null ? null : { value: gateValue }) as unknown as T;
    }
    if (sql.includes("WHERE provenance = 'live'")) {
      return { n: liveCount } as unknown as T;
    }
    if (sql.includes("FROM graph_edges")) {
      return { n: totalCount } as unknown as T;
    }
    throw new Error("unexpected query in test: " + sql);
  }

  const DB = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return { first: <T>() => resolve<T>(sql) };
        },
        first: <T>() => resolve<T>(sql),
      };
    },
  };

  return { ADMIN_SECRET: "admin-tok", DB } as unknown as Env;
}

describe("getGraphHealth", () => {
  it("denies without a valid admin token", async () => {
    const res = await getGraphHealth(req({ Authorization: "Bearer wrong" }), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns last_rebuild_at, live_count, total_count from three plain queries", async () => {
    const res = await getGraphHealth(req(), makeEnv({
      gateValue: "2026-08-27T03:00:00.000Z", liveCount: 7, totalCount: 250,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { last_rebuild_at: string | null; live_count: number; total_count: number };
    expect(body.last_rebuild_at).toBe("2026-08-27T03:00:00.000Z");
    expect(body.live_count).toBe(7);
    expect(body.total_count).toBe(250);
  });

  it("reports last_rebuild_at as null when the tick has never stamped its gate", async () => {
    const res = await getGraphHealth(req(), makeEnv({ gateValue: null }));
    const body = await res.json() as { last_rebuild_at: string | null };
    expect(body.last_rebuild_at).toBeNull();
  });

  it("uses the same gate key the nightly tick writes, so this endpoint can never watch a different stamp", () => {
    expect(GRAPH_REBUILD_GATE_COMPANION_ID).toBe("_system");
    expect(GRAPH_REBUILD_GATE_KEY).toBe("graph_rebuild_last_run_at");
  });
});
