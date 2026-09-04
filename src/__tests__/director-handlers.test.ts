import { describe, it, expect, vi } from "vitest";
import { postDirectorInvitation, patchDirectorInvitation, getDirectorSupply, getDirectorNeighborhood, getDirectorHealth } from "../handlers/director.js";
import type { Env } from "../types.js";

vi.mock("../graph/traverse.js", () => ({
  neighborhood: vi.fn(async () => [
    {
      src_table: "companion_tensions", src_id: "t1", dst_table: "companions", dst_id: "drevan",
      edge_type: "holds_tension", writer: "drevan", created_at: "2026-09-01T00:00:00Z", hop: 1, node_heat: 0.4,
    },
    {
      src_table: "companion_journal", src_id: "j1", dst_table: "companion_tensions", dst_id: "t1",
      edge_type: "references", writer: "cypher", created_at: "2026-09-01T01:00:00Z", hop: 2, node_heat: 0.9,
    },
  ]),
}));

interface Row { [k: string]: unknown }
function makeEnv() {
  const rows: Row[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const s = sql.trim();
              if (s.startsWith("INSERT INTO director_invitations")) {
                const [id, channel_id, thread_id, companion_id, reason, offer_ids, outcome, issued_at] = args;
                rows.push({ id, channel_id, thread_id, companion_id, reason, offer_ids, used_offer_ids: "[]", outcome, message_id: null, issued_at, resolved_at: null });
                return { meta: { changes: 1 } };
              }
              if (s.startsWith("UPDATE director_invitations")) {
                const [outcome, message_id, used_offer_ids, resolved_at, id] = args;
                const r = rows.find((x) => x["id"] === id);
                if (!r) return { meta: { changes: 0 } };
                // COALESCE semantics: preserve existing value when null is passed
                Object.assign(r, {
                  outcome,
                  message_id: message_id !== null ? message_id : r["message_id"],
                  used_offer_ids: used_offer_ids !== null ? used_offer_ids : r["used_offer_ids"],
                  resolved_at
                });
                return { meta: { changes: 1 } };
              }
              throw new Error("unexpected sql: " + s);
            },
          };
        },
      };
    },
  };
  return { env: { ADMIN_SECRET: "tok", DB } as unknown as Env, rows };
}
const H = { Authorization: "Bearer tok", "Content-Type": "application/json" };

describe("director invitations", () => {
  it("records an issued invitation", async () => {
    const { env, rows } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/mind/director/invitations", {
      method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", thread_id: null, companion_id: "gaia", reason: "open", offer_ids: ["f1"], outcome: "issued" }),
    }), env);
    expect(res.status).toBe(201);
    expect(rows[0]!["offer_ids"]).toBe("[\"f1\"]");
  });
  it("rejects a bad reason", async () => {
    const { env } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/x", { method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", companion_id: "gaia", reason: "vibes", offer_ids: [], outcome: "issued" }) }), env);
    expect(res.status).toBe(400);
  });
  it("patches the outcome and 404s on unknown id", async () => {
    const { env, rows } = makeEnv();
    await postDirectorInvitation(new Request("https://h/x", { method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", companion_id: "cypher", reason: "addressed", offer_ids: [], outcome: "issued" }) }), env);
    const ok = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "spoke", message_id: "m9", used_offer_ids: [] }) }), env, { id: "i1" });
    expect(ok.status).toBe(200);
    expect(rows[0]!["outcome"]).toBe("spoke");
    const miss = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "passed" }) }), env, { id: "nope" });
    expect(miss.status).toBe(404);
  });
  it("preserves omitted optional fields on subsequent PATCHes", async () => {
    const { env, rows } = makeEnv();
    await postDirectorInvitation(new Request("https://h/x", { method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", companion_id: "cypher", reason: "addressed", offer_ids: [], outcome: "issued" }) }), env);
    const first = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "spoke", message_id: "m9", used_offer_ids: ["f1"] }) }), env, { id: "i1" });
    expect(first.status).toBe(200);
    expect(rows[0]!["message_id"]).toBe("m9");
    expect(rows[0]!["used_offer_ids"]).toBe("[\"f1\"]");
    const second = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "spoke" }) }), env, { id: "i1" });
    expect(second.status).toBe(200);
    expect(rows[0]!["message_id"]).toBe("m9");
    expect(rows[0]!["used_offer_ids"]).toBe("[\"f1\"]");
  });
  it("denies without auth", async () => {
    const { env } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/x", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(401);
  });
});

describe("director supply", () => {
  it("pages oldest-first and cursor is the last returned row", async () => {
    const t1 = "2026-09-01T10:00:00Z";
    const t2 = "2026-09-01T11:00:00Z";
    const t3 = "2026-09-01T12:00:00Z";
    const DB = {
      async batch() {
        // Return 3 rows across sources, oldest to newest (one per supply source, 10 total)
        return [
          { results: [{ id: "f1", owner: "cypher", title: "t1", body: "b1", created_at: t1, heat: null }] },
          { results: [] },
          { results: [{ id: "q2", owner: "drevan", title: "t2", body: "b2", created_at: t2, heat: null }] },
          { results: [] },
          { results: [] },
          { results: [] },
          { results: [] },
          { results: [] },
          { results: [] },
          { results: [{ id: "c3", owner: "system", title: "t3", body: "b3", created_at: t3, heat: null }] },
        ];
      },
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    };
    const env = { ADMIN_SECRET: "tok", DB } as unknown as Env;
    const res = await getDirectorSupply(new Request("https://h/mind/director/supply?limit=2", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; cursor: string };
    expect(body.items.length).toBe(2);
    expect((body.items[0] as any).created_at).toBe(t1);
    expect((body.items[1] as any).created_at).toBe(t2);
    expect(body.cursor).toBe(t2);
  });
});

describe("getDirectorNeighborhood", () => {
  it("denies without auth", async () => {
    const env = { ADMIN_SECRET: "tok", DB: {} } as unknown as Env;
    const res = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood"), env);
    expect(res.status).toBe(401);
  });
  it("rejects when reader is not cypher/drevan/gaia", async () => {
    const env = { ADMIN_SECRET: "tok", DB: {} } as unknown as Env;
    const res = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood?reader=nobody", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("reader must be");
  });
  it("returns empty response when seeds is empty, without calling DB", async () => {
    let dbCalled = false;
    const throwingDB = { prepare: () => { dbCalled = true; throw new Error("DB should not be called"); } };
    const env = { ADMIN_SECRET: "tok", DB: throwingDB } as unknown as Env;
    const res = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood?reader=cypher&seeds=", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res.status).toBe(200);
    expect(!dbCalled).toBe(true);
    const body = await res.json() as { lines: unknown[]; nodes: unknown[] };
    expect(body.lines).toEqual([]);
    expect(body.nodes).toEqual([]);
  });
  it("rejects companions seed and drops colon-less seed tokens, without calling DB", async () => {
    let dbCalled = false;
    const throwingDB = { prepare: () => { dbCalled = true; throw new Error("DB should not be called"); } };
    const env = { ADMIN_SECRET: "tok", DB: throwingDB } as unknown as Env;
    // Test 1: companions seed is rejected with 400
    const res1 = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood?reader=cypher&seeds=companion_tensions:t1,companions:drevan", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res1.status).toBe(400);
    expect(!dbCalled).toBe(true);
    const body1 = await res1.json() as { error?: string };
    expect(body1.error).toContain("hairball");
    // Test 2: colon-less seed (abc) is dropped, leaving empty seeds, returns 200
    dbCalled = false;
    const res2 = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood?reader=cypher&seeds=abc", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res2.status).toBe(200);
    expect(!dbCalled).toBe(true);
    const body2 = await res2.json() as { lines: unknown[]; nodes: unknown[] };
    expect(body2.lines).toEqual([]);
    expect(body2.nodes).toEqual([]);
  });
  it("happy path: renders graph neighborhood with mocked traverse", async () => {
    const env = { ADMIN_SECRET: "tok", DB: {} } as unknown as Env;
    const res = await getDirectorNeighborhood(new Request("https://h/mind/director/neighborhood?reader=drevan&seeds=companion_tensions:t1", {
      headers: { Authorization: "Bearer tok" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { lines: string[]; nodes: Array<{ table: string; id: string; heat: number | null; score: number }> };
    expect(body.lines.length).toBe(2);
    for (const line of body.lines) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
    // Should exclude companions table, so only t1 and j1
    const tableSet = new Set(body.nodes.map((n) => n.table));
    expect(tableSet.has("companions")).toBe(false);
    // Heat 0.9 should rank higher than heat 0.4
    expect(body.nodes[0]?.id).toBe("j1");
  });
});

describe("director health", () => {
  it("health returns per-companion issued and per-outcome counts for the window", async () => {
    const DB = {
      prepare(sql: string) {
        const all = async () => {
          if (sql.includes("GROUP BY companion_id")) return { results: [{ k: "cypher", n: 2 }, { k: "gaia", n: 5 }] };
          if (sql.includes("GROUP BY outcome")) return { results: [{ k: "spoke", n: 4 }, { k: "passed", n: 3 }] };
          if (sql.includes("reason = 'open'")) return { results: [{ k: "open", n: 1 }] };
          if (sql.includes("FROM forage_finds")) return { results: [{ k: "forage", n: 7 }] };
          return { results: [] };
        };
        return { bind: () => ({ all }), all };
      },
    };
    const env = { ADMIN_SECRET: "tok", DB } as unknown as Env;
    const res = await getDirectorHealth(new Request("https://h/admin/director/health?hours=24", { headers: { Authorization: "Bearer tok" } }), env);
    const body = await res.json() as { window_hours: number; issued: Record<string, number>; outcomes: Record<string, number>; floor_fires: number };
    expect(body.window_hours).toBe(24);
    expect(body.issued.gaia).toBe(5);
    expect(body.issued.drevan).toBe(0);
    expect(body.outcomes.passed).toBe(3);
    expect(body.floor_fires).toBe(1);
  });
});
