// B3 Core layer (mig 0146): `core` flag, PATCH core, render ?scope=core.
import { describe, it, expect } from "vitest";
import {
  patchArchitectFactStatus,
  getArchitectFactsRender,
  renderFactsBlock,
  CORE_SCOPE_FOOTER,
} from "../handlers/architect-facts.js";

interface Row {
  id: string; fact: string; category: string; status: string; companion_id: string | null;
  source: string | null; weight: number; created_at: string; core?: number;
}
function row(o: Partial<Row>): Row {
  return {
    id: "id-" + Math.random(), fact: "placeholder", category: "general", status: "active",
    companion_id: null, source: null, weight: 100, created_at: "2026-08-28T00:00:00Z", core: 0, ...o,
  };
}

function patchEnv(prior: { id: string; status: string; weight: number; category: string; core: number } | null) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    writes,
    env: {
      ADMIN_SECRET: "s",
      DB: { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => ({
        first: async () => prior,
        run: async () => { writes.push({ sql, binds }); return { meta: { changes: 1 } }; },
      }) }) },
    } as never,
  };
}
const preq = (body: unknown) => new Request("https://x/identity/architect-facts/abc", {
  method: "PATCH", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const PRIOR = { id: "abc", status: "active", weight: 100, category: "body", core: 0 };

describe("PATCH architect fact: core", () => {
  it("accepts a body with only core, writes core = 1, returns core", async () => {
    const { env, writes } = patchEnv(PRIOR);
    const res = await patchArchitectFactStatus(preq({ core: true }), env, { id: "abc" });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, id: "abc", core: true, from_core: false });
    expect(writes[0]!.sql).toContain("core = ?");
    expect(writes[0]!.sql).not.toContain("status = ?");
    expect(writes[0]!.binds).toEqual([1, "abc"]);
  });

  it("core:false writes 0", async () => {
    const { env, writes } = patchEnv({ ...PRIOR, core: 1 });
    const res = await patchArchitectFactStatus(preq({ core: false }), env, { id: "abc" });
    expect((await res.json() as Record<string, unknown>).core).toBe(false);
    expect(writes[0]!.binds).toEqual([0, "abc"]);
  });

  it("combines with weight and category", async () => {
    const { env, writes } = patchEnv(PRIOR);
    const res = await patchArchitectFactStatus(preq({ core: true, weight: 10, category: "triad" }), env, { id: "abc" });
    expect(res.status).toBe(200);
    expect(writes[0]!.sql).toContain("weight = ?");
    expect(writes[0]!.sql).toContain("category = ?");
    expect(writes[0]!.sql).toContain("core = ?");
  });

  it("rejects non-boolean core with 400 and writes nothing", async () => {
    for (const v of ["true", 1, 0, "yes", {}]) {
      const { env, writes } = patchEnv(PRIOR);
      expect((await patchArchitectFactStatus(preq({ core: v }), env, { id: "abc" })).status).toBe(400);
      expect(writes).toHaveLength(0);
    }
  });
});

function renderEnv(rows: Row[], extra: Record<string, unknown> = {}) {
  return {
    ADMIN_SECRET: "s",
    ...extra,
    DB: { prepare: () => ({ all: async () => ({ results: rows }) }) },
  } as never;
}
const rreq = (qs = "") => new Request(`https://x/identity/architect-facts/render${qs}`, { headers: { Authorization: "Bearer s" } });

const ROWS: Row[] = [
  row({ fact: "CORE-ADDRESS", category: "addressing", core: 1, weight: 5 }),
  row({ fact: "CORE-DREVAN", category: "triad", core: 1, companion_id: "drevan" }),
  row({ fact: "NONCORE-ACTIVE", category: "work", core: 0 }),
  row({ fact: "CORE-BUT-OPEN", category: "people", status: "open", core: 1, created_at: new Date().toISOString() }),
  row({ fact: "CORE-NOVEL", category: "weirdcat", core: 1 }),
];

describe("render scope=core", () => {
  it("renders only active core rows, no open, no non-core", async () => {
    const res = await getArchitectFactsRender(rreq("?scope=core"), renderEnv(ROWS));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("- CORE-ADDRESS");
    expect(text).toContain("- [noted by drevan] CORE-DREVAN");
    expect(text).toContain("- CORE-NOVEL");
    expect(text).not.toContain("NONCORE-ACTIVE");
    expect(text).not.toContain("CORE-BUT-OPEN");
    expect(text).not.toContain("STILL OPEN");
    expect(text).toContain("(3 core)");
  });

  it("uses category titles and order, plus the footer", async () => {
    const text = await (await getArchitectFactsRender(rreq("?scope=core"), renderEnv(ROWS))).text();
    expect(text.indexOf("HOW THEY ARE ADDRESSED")).toBeLessThan(text.indexOf("THE TRIAD"));
    expect(text).toContain("WEIRDCAT");
    expect(text.trimEnd().endsWith(CORE_SCOPE_FOOTER)).toBe(true);
    expect(CORE_SCOPE_FOOTER).not.toMatch(/[—–]|--/);
  });

  it("ignores the tail budget (budget 0 still shows core default-weight rows)", async () => {
    const env = renderEnv(ROWS, { ARCHITECT_FACTS_TAIL_BUDGET: "0" });
    const text = await (await getArchitectFactsRender(rreq("?scope=core"), env)).text();
    expect(text).toContain("CORE-DREVAN");
    expect(text).toContain("CORE-NOVEL");
  });

  it("companion labelling: own facts unlabeled for the home companion", async () => {
    const own = await (await getArchitectFactsRender(rreq("?scope=core&companion=drevan"), renderEnv(ROWS))).text();
    expect(own).toContain("- CORE-DREVAN");
    expect(own).not.toContain("[noted by drevan]");
    const other = await (await getArchitectFactsRender(rreq("?scope=core&companion=gaia"), renderEnv(ROWS))).text();
    expect(other).toContain("- [noted by drevan] CORE-DREVAN");
  });

  it("unknown scope is 400; bad companion still 400", async () => {
    expect((await getArchitectFactsRender(rreq("?scope=all"), renderEnv(ROWS))).status).toBe(400);
    expect((await getArchitectFactsRender(rreq("?scope=core&companion=nobody"), renderEnv(ROWS))).status).toBe(400);
  });

  it("empty core set still returns header and footer", async () => {
    const text = await (await getArchitectFactsRender(rreq("?scope=core"), renderEnv([row({})]))).text();
    expect(text).toContain("(0 core)");
    expect(text).toContain(CORE_SCOPE_FOOTER);
  });
});

describe("default render ignores the core column", () => {
  it("core=1 vs core=0 produce byte-identical default output", async () => {
    const base = ROWS.map(r => ({ ...r, core: 0 }));
    const a = await (await getArchitectFactsRender(rreq(), renderEnv(ROWS))).text();
    const b = await (await getArchitectFactsRender(rreq(), renderEnv(base))).text();
    expect(a).toBe(b);
    expect(a).toContain("NONCORE-ACTIVE");
    expect(a).toContain("CORE-ADDRESS");
    expect(a).not.toContain(CORE_SCOPE_FOOTER);
  });

  it("renderFactsBlock without scope matches scope undefined", () => {
    expect(renderFactsBlock(ROWS, "n", "gaia")).toBe(renderFactsBlock(ROWS, "n", "gaia", undefined, undefined, undefined));
  });

  it("new categories get titles in the requested order", () => {
    const cats = ["living_situation", "interests", "anchors", "animals", "health", "body", "work", "intimacy", "triad", "people", "plural", "addressing"];
    const text = renderFactsBlock(cats.map(c => row({ fact: "f-" + c, category: c })), "n");
    const titles = ["HOW THEY ARE ADDRESSED", "PLURAL SYSTEM", "THE PEOPLE", "THE TRIAD", "INTIMACY", "WORK AND SCHOOL",
      "BODY AND REGULATION", "HEALTH", "THE ANIMALS", "WHAT THEY BRING", "INTERESTS", "LIVING SITUATION"];
    const idx = titles.map(t => text.indexOf(t));
    expect(idx.every(i => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});
