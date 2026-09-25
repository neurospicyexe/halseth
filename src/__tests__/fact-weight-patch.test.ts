// Fact weight became patchable 2026-09-25.
//
// Until then the only way to re-rank a fact was to supersede it with a new row -- and the novelty
// gate correctly refuses a verbatim repost, so re-ranking a fact WITHOUT changing its words was
// impossible. Weight is the only ranking signal facts have, `weight < 100` is what makes one
// always render, and the default is 100. So every fact a companion ever wrote landed unranked in
// the cuttable tail, permanently.
//
// The day this shipped, all four facts recording Raziel's same-day MRI result sat at weight 100,
// queued behind months-old preferences, while he re-told the result across four threads. Recall
// was not the broken part.

import { describe, it, expect } from "vitest";
import { patchArchitectFactStatus } from "../handlers/architect-facts.js";

function envWith(row: { id: string; status: string; weight: number } | null) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    writes,
    env: {
      ADMIN_SECRET: "s",
      DB: {
        prepare(sql: string) {
          return {
            bind: (...binds: unknown[]) => ({
              first: async () => row,
              run: async () => { writes.push({ sql, binds }); return { meta: { changes: 1 } }; },
            }),
          };
        },
      },
    } as never,
  };
}
const req = (body: unknown) => new Request("https://x/identity/architect-facts/abc", {
  method: "PATCH", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("PATCH architect fact", () => {
  it("sets weight alone, without touching status", async () => {
    const { env, writes } = envWith({ id: "abc", status: "active", weight: 100 });
    const res = await patchArchitectFactStatus(req({ weight: 15 }), env, { id: "abc" });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, from_weight: 100, weight: 15 });
    expect(writes[0]!.sql).toContain("weight = ?");
    expect(writes[0]!.sql).not.toContain("status = ?");
  });

  it("still sets status alone -- every existing caller is unchanged", async () => {
    const { env, writes } = envWith({ id: "abc", status: "active", weight: 100 });
    const res = await patchArchitectFactStatus(req({ status: "retired" }), env, { id: "abc" });
    expect((await res.json() as Record<string, unknown>).status).toBe("retired");
    expect(writes[0]!.sql).toContain("status = ?");
    expect(writes[0]!.sql).not.toContain("weight = ?");
  });

  it("rejects a weight outside 0-100 rather than writing an unrankable value", async () => {
    const { env } = envWith({ id: "abc", status: "active", weight: 100 });
    for (const w of [-1, 101, "high"]) {
      expect((await patchArchitectFactStatus(req({ weight: w }), env, { id: "abc" })).status).toBe(400);
    }
  });

  it("rejects an empty patch instead of silently doing nothing", async () => {
    const { env } = envWith({ id: "abc", status: "active", weight: 100 });
    expect((await patchArchitectFactStatus(req({}), env, { id: "abc" })).status).toBe(400);
  });

  it("refuses to re-rank a RETIRED fact -- it renders nowhere", async () => {
    const { env } = envWith({ id: "abc", status: "retired", weight: 100 });
    expect((await patchArchitectFactStatus(req({ weight: 10 }), env, { id: "abc" })).status).toBe(409);
  });
});
