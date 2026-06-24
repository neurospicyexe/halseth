import { describe, it, expect } from "vitest";
import { deleteJournalEntry } from "../handlers/growth.js";
import { deleteAutonomySeed, patchAutonomySeed } from "../handlers/autonomy.js";

type Row = Record<string, unknown>;

function makeStmt(results: Row[], changes?: number) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: changes ?? (results.length || 1) } }),
  };
  return stmt;
}

function makeEnv(prepareImpl: (sql: string) => any) {
  return { ADMIN_SECRET: "test-secret", DB: { prepare: prepareImpl } } as any;
}

function authed(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("deleteJournalEntry — canon-protecting hard delete", () => {
  it("400 when companion_id query param is missing", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await deleteJournalEntry(
      authed("https://t.local/mind/growth/journal/j1", "DELETE"),
      env,
      { id: "j1" },
    );
    expect(res.status).toBe(400);
  });

  it("404 when the row does not exist for that companion", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT review_status")) return makeStmt([]); // not found
      return makeStmt([]);
    });
    const res = await deleteJournalEntry(
      authed("https://t.local/x?companion_id=cypher", "DELETE"),
      env,
      { id: "missing" },
    );
    expect(res.status).toBe(404);
  });

  it("409 refuses to delete ACCEPTED canon", async () => {
    let deleteRan = false;
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT review_status")) return makeStmt([{ review_status: "accepted" }]);
      if (sql.startsWith("DELETE FROM growth_journal")) { deleteRan = true; return makeStmt([], 1); }
      return makeStmt([]);
    });
    const res = await deleteJournalEntry(
      authed("https://t.local/x?companion_id=cypher", "DELETE"),
      env,
      { id: "canon-1" },
    );
    expect(res.status).toBe(409);
    expect(deleteRan).toBe(false); // never reached the DELETE
  });

  it("deletes a pending/declined entry", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT review_status")) return makeStmt([{ review_status: "declined" }]);
      if (sql.startsWith("DELETE FROM growth_journal")) return makeStmt([], 1);
      return makeStmt([]);
    });
    const res = await deleteJournalEntry(
      authed("https://t.local/x?companion_id=cypher", "DELETE"),
      env,
      { id: "noise-1" },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
  });
});

describe("deleteAutonomySeed", () => {
  it("404 when the seed does not exist", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("DELETE FROM autonomy_seeds")) return makeStmt([], 0);
      return makeStmt([]);
    });
    const res = await deleteAutonomySeed(authed("https://t.local/x", "DELETE"), env, { id: "nope" });
    expect(res.status).toBe(404);
  });

  it("deletes an existing seed", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("DELETE FROM autonomy_seeds")) return makeStmt([], 1);
      return makeStmt([]);
    });
    const res = await deleteAutonomySeed(authed("https://t.local/x", "DELETE"), env, { id: "s1" });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.deleted).toBe(true);
  });
});

describe("patchAutonomySeed — re-enable vs mark-used", () => {
  it("re-enable clears used_at (action=reenable)", async () => {
    let reenableSql = "";
    const env = makeEnv((sql: string) => {
      if (sql.includes("used_at = NULL")) { reenableSql = sql; return makeStmt([], 1); }
      return makeStmt([]);
    });
    const res = await patchAutonomySeed(
      authed("https://t.local/x", "PATCH", { action: "reenable" }),
      env,
      { id: "s1" },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.reenabled).toBe(true);
    expect(reenableSql).toContain("used_at = NULL");
  });

  it("re-enable returns 404 when seed is already active", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.includes("used_at = NULL")) return makeStmt([], 0);
      return makeStmt([]);
    });
    const res = await patchAutonomySeed(
      authed("https://t.local/x", "PATCH", { action: "reenable" }),
      env,
      { id: "s1" },
    );
    expect(res.status).toBe(404);
  });

  it("default (no body) still marks used — back-compat", async () => {
    let markedUsed = false;
    const env = makeEnv((sql: string) => {
      if (sql.includes("used_at = datetime")) { markedUsed = true; return makeStmt([], 1); }
      return makeStmt([]);
    });
    const res = await patchAutonomySeed(
      authed("https://t.local/x", "PATCH"), // no body
      env,
      { id: "s1" },
    );
    expect(res.status).toBe(200);
    expect(markedUsed).toBe(true);
  });
});
