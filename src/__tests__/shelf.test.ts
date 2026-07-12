// Tests for the obsession shelf handlers (migration 0094, Phase 3).
import { describe, it, expect, beforeEach } from "vitest";
import { postObsession, getObsessions, patchObsession } from "../handlers/shelf.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private store: Row[], private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.store, args); }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT")) {
      const [id, title, kind, note] = this.bound as [string, string, string, string | null];
      this.store.push({ id, title, kind, note, status: "active", updated_at: String(this.store.length).padStart(4, "0") });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE")) {
      const id = this.bound[this.bound.length - 1] as string;
      const row = this.store.find(r => r["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      // crude: apply status if present in the SQL+binds (test only checks archive path)
      if (this.sql.includes("status = ?")) row["status"] = this.bound[0];
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("WHERE status = ?")) {
      const [status] = this.bound as [string];
      return { results: this.store.filter(r => r["status"] === status).slice().reverse() };
    }
    return { results: this.store.slice().reverse() };
  }
}

const ADMIN_SECRET = "test-admin-secret";

function makeEnv(store: Row[]): Env {
  return { DB: { prepare: (sql: string) => new FakeStatement(sql, store) }, ADMIN_SECRET } as unknown as Env;
}
function req(method: string, body?: unknown, url = "http://local/mind/shelf"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("obsession shelf handlers", () => {
  let store: Row[]; let env: Env;
  beforeEach(() => { store = []; env = makeEnv(store); });

  it("POST adds an item (default kind=other) and 201s", async () => {
    const res = await postObsession(req("POST", { title: "Severance" }), env);
    expect(res.status).toBe(201);
    expect(store[0]!["kind"]).toBe("other");
  });

  it("POST keeps a valid kind, rejects a missing title", async () => {
    await postObsession(req("POST", { title: "Pedro Pascal", kind: "actor" }), env);
    expect(store[0]!["kind"]).toBe("actor");
    expect((await postObsession(req("POST", { kind: "movie" }), env)).status).toBe(400);
  });

  it("GET returns active items newest-first", async () => {
    await postObsession(req("POST", { title: "A" }), env);
    await postObsession(req("POST", { title: "B" }), env);
    const data = await (await getObsessions(req("GET", undefined, "http://local/mind/shelf?status=active"), env)).json() as { items: Array<{ title: string }> };
    expect(data.items.map(i => i.title)).toEqual(["B", "A"]);
  });

  it("PATCH archives an item", async () => {
    await postObsession(req("POST", { title: "Done with this" }), env);
    const id = store[0]!["id"] as string;
    const res = await patchObsession(req("PATCH", { status: "archived" }), env, { id });
    expect(res.status).toBe(200);
    expect(store[0]!["status"]).toBe("archived");
  });
});
