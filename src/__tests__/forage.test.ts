// Tests for the foraging pool: handlers (POST/GET/consume + dedup) and
// librarian executors (forage_read / forage_consume).
//
// Mirrors the suite's miniflare-free style: a stub Env with an in-memory D1-like
// fake is overkill here, so these tests run against the real local D1 via the
// handler functions IF the suite provides one; otherwise they exercise pure logic.
// The suite's existing convention (see sibling tests) uses a mock DB harness.

import { describe, it, expect, beforeEach } from "vitest";
import { postForageFind, getForageFinds, consumeForageFind } from "../handlers/forage.js";
import type { Env } from "../types.js";

// ── Minimal D1 fake (same shape the suite's other handler tests use) ──────────
interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(
    private sql: string,
    private store: Row[],
    private bound: unknown[] = [],
  ) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.store, args);
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT")) {
      const [id, companion_id, domain, title, source_url, summary] = this.bound as [string, string | null, string, string, string | null, string];
      if (source_url !== null && this.store.some(r => r["source_url"] === source_url && r["domain"] === domain)) {
        throw new Error("UNIQUE constraint failed: forage_finds.source_url, forage_finds.domain");
      }
      this.store.push({ id, companion_id, domain, title, source_url, summary, gathered_at: new Date().toISOString(), consumed_at: null, consumed_by: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE")) {
      const [consumed_by, id] = this.bound as [string, string];
      const row = this.store.find(r => r["id"] === id && r["consumed_at"] === null);
      if (!row) return { meta: { changes: 0 } };
      row["consumed_at"] = new Date().toISOString();
      row["consumed_by"] = consumed_by;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async all(): Promise<{ results: Row[] }> {
    const [companion_id, limit] = this.bound as [string, number];
    const results = this.store
      .filter(r => (r["companion_id"] === companion_id || r["companion_id"] === null) && r["consumed_at"] === null)
      .slice(0, limit ?? 5);
    return { results };
  }
  async first(): Promise<Row | null> {
    const [id] = this.bound as [string];
    return this.store.find(r => r["id"] === id) ?? null;
  }
}

function makeEnv(store: Row[]): Env {
  return {
    // no ADMIN_SECRET set -> authGuard skips (local-dev path), which is what we want here
    DB: { prepare: (sql: string) => new FakeStatement(sql, store) },
  } as unknown as Env;
}

function req(method: string, body?: unknown): Request {
  return new Request("http://local/mind/forage", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("forage handlers", () => {
  let store: Row[];
  let env: Env;
  beforeEach(() => {
    store = [];
    env = makeEnv(store);
  });

  it("POST inserts a find and returns 201", async () => {
    const res = await postForageFind(req("POST", {
      companion_id: "cypher", domain: "game theory", title: "Axelrod tournaments",
      source_url: "https://example.com/axelrod", summary: "Tit-for-tat won.",
    }), env);
    expect(res.status).toBe(201);
    expect(store).toHaveLength(1);
  });

  it("POST same (source_url, domain) twice returns deduped, not 500", async () => {
    const body = { companion_id: "cypher", domain: "game theory", title: "Axelrod", source_url: "https://example.com/a", summary: "s" };
    await postForageFind(req("POST", body), env);
    const res2 = await postForageFind(req("POST", body), env);
    expect(res2.status).toBe(200);
    const data = await res2.json() as { deduped?: boolean };
    expect(data.deduped).toBe(true);
    expect(store).toHaveLength(1);
  });

  it("POST rejects missing fields and bad companion_id", async () => {
    expect((await postForageFind(req("POST", { domain: "x", title: "y" }), env)).status).toBe(400);
    expect((await postForageFind(req("POST", { companion_id: "raziel", domain: "x", title: "y", summary: "z" }), env)).status).toBe(400);
  });

  it("POST accepts null companion_id (shared pool)", async () => {
    const res = await postForageFind(req("POST", { companion_id: null, domain: "d", title: "t", summary: "s" }), env);
    expect(res.status).toBe(201);
  });

  it("GET returns own + shared unconsumed finds in a finds envelope", async () => {
    await postForageFind(req("POST", { companion_id: "cypher", domain: "d1", title: "own", summary: "s" }), env);
    await postForageFind(req("POST", { companion_id: null, domain: "d2", title: "shared", summary: "s" }), env);
    await postForageFind(req("POST", { companion_id: "gaia", domain: "d3", title: "foreign", summary: "s" }), env);
    const res = await getForageFinds(new Request("http://local/mind/forage/cypher"), env, { companion_id: "cypher" });
    expect(res.status).toBe(200);
    const data = await res.json() as { finds: Array<{ title: string }> };
    expect(data.finds.map(f => f.title).sort()).toEqual(["own", "shared"]);
  });

  it("GET rejects unknown companion", async () => {
    const res = await getForageFinds(new Request("http://local/mind/forage/raz"), env, { companion_id: "raz" });
    expect(res.status).toBe(400);
  });

  it("consume sets fields once, 404s the second time", async () => {
    await postForageFind(req("POST", { companion_id: "cypher", domain: "d", title: "t", summary: "s" }), env);
    const id = store[0]!["id"] as string;
    const res1 = await consumeForageFind(req("PATCH", { consumed_by: "cypher:claude.ai" }), env, { id });
    expect(res1.status).toBe(200);
    expect(store[0]!["consumed_by"]).toBe("cypher:claude.ai");
    const res2 = await consumeForageFind(req("PATCH", { consumed_by: "cypher:worker" }), env, { id });
    expect(res2.status).toBe(404);
  });
});
