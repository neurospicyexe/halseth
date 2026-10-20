// B3 (facts out of SOUL): GET /identity/architect-facts/shortlist + PATCH category.
import { describe, it, expect } from "vitest";
import { getArchitectFactsShortlist, patchArchitectFactStatus } from "../handlers/architect-facts.js";

interface DbRow { id: string; category: string; status: string; fact: string; created_at?: string; core?: number }

const fresh = () => new Date(Date.now() - 86_400_000).toISOString();
const stale = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

function mkEnv(opts: {
  matches?: Array<{ id: string; score: number }>;
  rows?: DbRow[];
  embedFails?: boolean;
  vectorizeFails?: boolean;
}) {
  const queries: Array<{ topK: number; filter: unknown }> = [];
  const embedded: string[] = [];
  const rows = opts.rows ?? [];
  const env = {
    ADMIN_SECRET: "s",
    AI: {
      run: async (_m: string, input: { text: string[] }) => {
        if (opts.embedFails) throw new Error("ai down");
        embedded.push(input.text[0] ?? "");
        return { data: [[0.1, 0.2, 0.3]] };
      },
    },
    VECTORIZE: {
      query: async (_v: number[], o: { topK: number; filter: unknown }) => {
        if (opts.vectorizeFails) throw new Error("vz down");
        queries.push(o);
        return { matches: opts.matches ?? [] };
      },
    },
    DB: {
      prepare: (_sql: string) => ({
        bind: (...ids: string[]) => ({
          // Mirrors the handler's SQL: the id set OR every open row (the render's cap needs all of them).
          all: async () => ({ results: rows.filter((r) => (ids.includes(r.id) || r.status === "open") && ["active", "open"].includes(r.status)) }),
        }),
      }),
    },
  };
  return { env: env as never, queries, embedded };
}

const get = (qs: string, auth = "Bearer s") =>
  new Request(`https://x/identity/architect-facts/shortlist${qs}`, { headers: auth ? { Authorization: auth } : {} });

const ROWS: DbRow[] = [
  { id: "a", category: "body", status: "active", fact: "fact a" },
  { id: "b", category: "people", status: "open", fact: "fact b", created_at: fresh() },
  { id: "c", category: "work", status: "retired", fact: "fact c" },
  { id: "d", category: "work", status: "active", fact: "fact d" },
];
const MATCHES = [
  { id: "architect_facts:a", score: 0.5 },
  { id: "architect_facts:b", score: 0.9 },
  { id: "architect_facts:c", score: 0.95 },
  { id: "architect_facts:gone", score: 0.8 },
  { id: "architect_facts:d", score: 0.7 },
];

describe("GET architect-facts shortlist", () => {
  it("orders by score desc, drops retired and missing, omits text by default", async () => {
    const { env, queries } = mkEnv({ matches: MATCHES, rows: ROWS });
    const res = await getArchitectFactsShortlist(get("?q=hello"), env);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; model: string };
    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.id)).toEqual(["b", "d", "a"]);
    expect(body.items[0]!).toEqual({ id: "b", category: "people", status: "open", score: 0.9 });
    expect(body.model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(queries[0]!.filter).toEqual({ table: "architect_facts" });
    expect(queries[0]!.topK).toBe(48);
  });

  it("text=1 includes fact text", async () => {
    const { env } = mkEnv({ matches: MATCHES, rows: ROWS });
    const res = await getArchitectFactsShortlist(get("?q=hi&text=1&companion=gaia"), env);
    const body = (await res.json()) as { items: Array<{ fact?: string }> };
    expect(body.items[0]!.fact).toBe("fact b");
  });

  it("caps results at k and clamps k (default 12, max 30, bad -> default)", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `architect_facts:r${i}`, score: 1 - i / 100 }));
    const rows = many.map((m, i) => ({ id: `r${i}`, category: "x_y", status: "active", fact: "f" }));
    const { env, queries } = mkEnv({ matches: many, rows });
    const n = async (qs: string) => ((await (await getArchitectFactsShortlist(get(qs), env)).json()) as { items: unknown[] }).items.length;
    expect(await n("?q=a&k=3")).toBe(3);
    expect(await n("?q=a")).toBe(12);
    expect(await n("?q=a&k=abc")).toBe(12);
    expect(await n("?q=a&k=999")).toBe(30);
    expect(await n("?q=a&k=0")).toBe(1);
    expect(queries.some((q) => q.topK === 50)).toBe(true);
  });

  it("truncates q to 2000 chars", async () => {
    const { env, embedded } = mkEnv({});
    await getArchitectFactsShortlist(get("?q=" + "x".repeat(5000)), env);
    expect(embedded[0]!.length).toBe(2000);
  });

  it("400 on missing/blank q and bad companion", async () => {
    const { env } = mkEnv({});
    expect((await getArchitectFactsShortlist(get(""), env)).status).toBe(400);
    expect((await getArchitectFactsShortlist(get("?q=%20%20"), env)).status).toBe(400);
    expect((await getArchitectFactsShortlist(get("?q=a&companion=bob"), env)).status).toBe(400);
  });

  it("502 with empty items on embed or vectorize failure", async () => {
    for (const o of [{ embedFails: true }, { vectorizeFails: true }]) {
      const { env } = mkEnv(o);
      const res = await getArchitectFactsShortlist(get("?q=a"), env);
      const body = (await res.json()) as { items: unknown[]; error: string };
      expect(res.status).toBe(502);
      expect(body.items).toEqual([]);
      expect(body.error).toBeTruthy();
    }
  });

  it("401 without valid bearer", async () => {
    const { env } = mkEnv({});
    expect((await getArchitectFactsShortlist(get("?q=a", ""), env)).status).toBe(401);
    expect((await getArchitectFactsShortlist(get("?q=a", "Bearer nope"), env)).status).toBe(401);
  });
});

describe("PATCH architect fact category", () => {
  function patchEnv() {
    const writes: Array<{ sql: string; binds: unknown[] }> = [];
    const env = {
      ADMIN_SECRET: "s",
      DB: {
        prepare: (sql: string) => ({
          bind: (...binds: unknown[]) => ({
            first: async () => ({ id: "abc", status: "active", weight: 100, category: "general" }),
            run: async () => { writes.push({ sql, binds }); return { meta: { changes: 1 } }; },
          }),
        }),
      },
    } as never;
    return { env, writes };
  }
  const req = (body: unknown) => new Request("https://x/identity/architect-facts/abc", {
    method: "PATCH", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("category alone is valid; trimmed and lowercased", async () => {
    const { env, writes } = patchEnv();
    const res = await patchArchitectFactStatus(req({ category: "  Body_Regulation " }), env, { id: "abc" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.category).toBe("body_regulation");
    expect(writes[0]!.sql).toContain("category = ?");
    expect(writes[0]!.sql).not.toContain("status = ?");
    expect(writes[0]!.binds).toEqual(["body_regulation", "abc"]);
  });

  it("combines with status and weight", async () => {
    const { env, writes } = patchEnv();
    const res = await patchArchitectFactStatus(req({ status: "active", weight: 10, category: "people" }), env, { id: "abc" });
    expect(res.status).toBe(200);
    expect(writes[0]!.binds).toEqual(["active", 10, "people", "abc"]);
  });

  it("rejects invalid categories", async () => {
    for (const c of ["a", "x".repeat(33), "has space", "bad-dash", "num1", "", 5, "   "]) {
      const { env, writes } = patchEnv();
      const res = await patchArchitectFactStatus(req({ category: c }), env, { id: "abc" });
      expect(res.status).toBe(400);
      expect(writes).toHaveLength(0);
    }
  });
});

describe("shortlist open-fact age cap", () => {
  it("drops open facts older than the render's cap, keeps fresh open and all active", async () => {
    const rows: DbRow[] = [
      { id: "fo", category: "people", status: "open", fact: "fresh open", created_at: fresh() },
      { id: "so", category: "people", status: "open", fact: "stale open", created_at: stale() },
      { id: "uo", category: "people", status: "open", fact: "undated open" },
      { id: "oa", category: "body", status: "active", fact: "old active", created_at: stale() },
    ];
    const matches = rows.map((r, i) => ({ id: `architect_facts:${r.id}`, score: 0.9 - i / 10 }));
    const { env } = mkEnv({ matches, rows });
    const res = await getArchitectFactsShortlist(get("?q=x"), env);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id).sort()).toEqual(["fo", "oa"]);
  });
});

describe("shortlist core exclusion (B3 blocker A)", () => {
  it("never returns active core facts; non-core fill the slots; asks Vectorize for headroom", async () => {
    const rows: DbRow[] = [
      { id: "c1", category: "addressing", status: "active", fact: "core one", core: 1 },
      { id: "c2", category: "addressing", status: "active", fact: "core two", core: 1 },
      { id: "n1", category: "body", status: "active", fact: "non core", core: 0 },
    ];
    const matches = rows.map((r, i) => ({ id: `architect_facts:${r.id}`, score: 0.9 - i / 10 }));
    const { env, queries } = mkEnv({ matches, rows });
    const res = await getArchitectFactsShortlist(get("?q=x&k=2"), env);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["n1"]);
    expect(queries[0]!.topK).toBeGreaterThan(4); // more than k*2 so core rows do not eat the slots
  });

  it("an OPEN core row is not hidden (scope=core never renders open, so this lane is its only route)", async () => {
    const rows: DbRow[] = [{ id: "oc", category: "people", status: "open", fact: "q", created_at: fresh(), core: 1 }];
    const { env } = mkEnv({ matches: [{ id: "architect_facts:oc", score: 0.9 }], rows });
    const body = (await (await getArchitectFactsShortlist(get("?q=x"), env)).json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["oc"]);
  });
});

describe("shortlist open-fact row cap (B3 blocker B)", () => {
  it("applies the render's 8-row cap across ALL open facts, not just the shortlisted ones", async () => {
    // 10 fresh open facts, o0 newest ... o9 oldest. The render shows o0..o7; o8/o9 are held.
    const rows: DbRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `o${i}`, category: "people", status: "open", fact: `open ${i}`,
      created_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    }));
    // Only the two held ones match semantically, plus one shown.
    const matches = ["o9", "o8", "o2"].map((id, i) => ({ id: `architect_facts:${id}`, score: 0.9 - i / 10 }));
    const { env } = mkEnv({ matches, rows });
    const body = (await (await getArchitectFactsShortlist(get("?q=x"), env)).json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual(["o2"]);
  });
});
