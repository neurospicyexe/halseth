import { describe, it, expect } from "vitest";
import { filterExistingIds, postVaultPathsLookup } from "../handlers/growth.js";

type Row = Record<string, unknown>;

function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: results.length || 1 } }),
  };
  return stmt;
}

function makeEnv(prepareImpl: (sql: string) => any) {
  return { ADMIN_SECRET: "test-secret", DB: { prepare: prepareImpl } } as any;
}

function authedJson(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Authorization": "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("filterExistingIds", () => {
  it("returns the subset of ids that exist across journal/patterns/markers", async () => {
    const env = makeEnv((_sql: string) => {
      // Mock returns just two of the three input ids as found.
      return makeStmt([{ id: "exists-1" }, { id: "exists-2" }]);
    });
    const result = await filterExistingIds(env, ["exists-1", "exists-2", "ghost-3"]);
    expect(result).toEqual(["exists-1", "exists-2"]);
  });

  it("returns empty array on empty input without hitting the DB", async () => {
    let dbCalled = false;
    const env = makeEnv(() => { dbCalled = true; return makeStmt([]); });
    expect(await filterExistingIds(env, [])).toEqual([]);
    expect(dbCalled).toBe(false);
  });

  it("dedupes input before binding", async () => {
    let bindCalls: unknown[][] = [];
    const env = makeEnv(() => {
      const stmt: any = {
        bind: (...binds: unknown[]) => { bindCalls.push(binds); return { all: async () => ({ results: [{ id: "a" }] }) }; },
      };
      return stmt;
    });
    await filterExistingIds(env, ["a", "a", "a"]);
    // 3 unique placeholders × 1 deduped id = 3 binds (same id repeated for the 3 UNION clauses)
    expect(bindCalls.length).toBe(1);
    expect(bindCalls[0]).toEqual(["a", "a", "a"]);
  });

  it("strips non-string ids defensively", async () => {
    const env = makeEnv(() => makeStmt([]));
    // @ts-expect-error -- intentionally passing junk
    expect(await filterExistingIds(env, [null, undefined, 42, ""])).toEqual([]);
  });
});

describe("postVaultPathsLookup", () => {
  it("returns vault_path for known ids and null for unknown", async () => {
    const env = makeEnv((_sql: string) => {
      return makeStmt([
        { id: "j1", vault_path: "Companions/cypher/growth/journal/x.md" },
        { id: "p1", vault_path: null },
      ]);
    });
    const res = await postVaultPathsLookup(
      authedJson("https://test.local/x", "POST", { ids: ["j1", "p1", "ghost"] }),
      env,
    );
    const body = await res.json() as any;
    expect(body.paths).toEqual({
      j1: "Companions/cypher/growth/journal/x.md",
      p1: null,
      ghost: null,
    });
  });

  it("returns empty paths object for empty input", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await postVaultPathsLookup(
      authedJson("https://test.local/x", "POST", { ids: [] }),
      env,
    );
    const body = await res.json() as any;
    expect(body.paths).toEqual({});
  });

  it("requires auth", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await postVaultPathsLookup(
      new Request("https://test.local/x", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
