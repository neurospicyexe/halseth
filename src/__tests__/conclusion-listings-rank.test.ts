// Conclusion LISTINGS rank like orient does, and never warm (2026-09-22, Raziel's decision 3).
//
// Before this, orient ranked by effective heat while every listing ranked by created_at, so a
// companion booted seeing one set of its own beliefs and listed another. Three call sites, two
// answers, nothing deciding the split.
//
// The constraint that matters more than the ordering: a listing is a PURE READ. orient warms what
// it surfaces (mig 0105), which is already a ranking signal written by the act of reading; making
// the listings warm too would have tripled it. Measured on prod the day this shipped: 138 eligible
// conclusions across the triad, 22 ever surfaced, effective heat spanning 77x -- the foreground is
// already frozen, and two more writers would set it in concrete.

import { describe, it, expect } from "vitest";
import { getConclusions } from "../handlers/conclusions.js";
import type { Env } from "../types.js";

function fakeEnv() {
  const prepared: string[] = [];
  function stmtFor(_sql: string) {
    const stmt = {
      bind(..._b: unknown[]) { return stmt; },
      async all() { return { results: [{ id: "c1", conclusion_text: "a belief" }] }; },
      async first() { return { n: 138 }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    return stmt;
  }
  const env = {
    ADMIN_SECRET: "test-admin-secret",
    DB: {
      prepare(sql: string) { prepared.push(sql); return stmtFor(sql); },
      async batch(s: unknown[]) { return s.map(() => ({ results: [] })); },
    },
  } as unknown as Env;
  return { env, prepared };
}

const req = (qs = "") =>
  new Request(`https://halseth.example/companion-conclusions/cypher${qs}`, {
    headers: { Authorization: "Bearer test-admin-secret" },
  });

describe("GET /companion-conclusions/:agent_id", () => {
  it("ranks by effective heat, not created_at", async () => {
    const { env, prepared } = fakeEnv();
    await getConclusions(req(), env, { agent_id: "cypher" });
    const select = prepared.find(s => /FROM companion_conclusions/i.test(s) && /SELECT id/i.test(s))!;
    expect(select).toMatch(/ORDER BY[\s\S]*julianday/i);   // the decay expression
    expect(select).not.toMatch(/ORDER BY created_at DESC/i);
  });

  // THE BINDING CONSTRAINT on decision 3. Do not relax this to "match orient exactly".
  it("NEVER warms -- a listing must not write the ranking it reads", async () => {
    const { env, prepared } = fakeEnv();
    await getConclusions(req(), env, { agent_id: "cypher" });
    const warms = prepared.filter(s => /UPDATE companion_conclusions[\s\S]*heat/i.test(s));
    expect(warms, "listing conclusions must not inflate the salience it ranks by").toEqual([]);
  });

  it("performs no mutation at all", async () => {
    const { env, prepared } = fakeEnv();
    await getConclusions(req(), env, { agent_id: "cypher" });
    expect(prepared.filter(s => /^\s*(INSERT|UPDATE|DELETE)/i.test(s))).toEqual([]);
  });

  it("reaches further than the boot block and says how many exist", async () => {
    const { env, prepared } = fakeEnv();
    const res = await getConclusions(req(), env, { agent_id: "cypher" });
    const body = await res.json() as { conclusions: unknown[]; shown: number; total: number };
    expect(prepared.find(s => /FROM companion_conclusions/i.test(s) && /SELECT id/i.test(s))).toMatch(/LIMIT 40/);
    // `total` is what makes the rest countable instead of invisible.
    expect(body.total).toBe(138);
    expect(body.shown).toBe(body.conclusions.length);
  });

  it("still filters superseded and archived by default", async () => {
    const { env, prepared } = fakeEnv();
    await getConclusions(req(), env, { agent_id: "cypher" });
    const select = prepared.find(s => /SELECT id[\s\S]*FROM companion_conclusions/i.test(s))!;
    expect(select).toMatch(/superseded_by IS NULL/i);
    expect(select).toMatch(/archived = 0/i);
  });

  it("include_superseded=true drops those filters but keeps the heat ranking", async () => {
    const { env, prepared } = fakeEnv();
    await getConclusions(req("?include_superseded=true"), env, { agent_id: "cypher" });
    const select = prepared.find(s => /SELECT id[\s\S]*FROM companion_conclusions/i.test(s))!;
    expect(select).not.toMatch(/superseded_by IS NULL/i);
    expect(select).toMatch(/ORDER BY[\s\S]*julianday/i);
  });

  it("rejects an unknown agent", async () => {
    const { env } = fakeEnv();
    const res = await getConclusions(req(), env, { agent_id: "nobody" });
    expect(res.status).toBe(400);
  });
});
