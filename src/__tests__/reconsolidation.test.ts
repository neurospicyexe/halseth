import { describe, it, expect } from "vitest";
import { postGrowthJournal, acceptJournalEntry } from "../handlers/growth.js";

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

describe("postGrowthJournal reconsolidation", () => {
  it("accepts entry_type reconsolidation with a valid supersedes_id and binds it into the INSERT", async () => {
    let insertBound: unknown[] = [];
    const env = makeEnv((sql: string) => {
      // supersedes validation -- target exists, accepted, same companion
      if (sql.startsWith("SELECT id FROM growth_journal") && sql.includes("review_status = 'accepted'")) {
        return makeStmt([{ id: "canon-1" }]);
      }
      if (sql.includes("SELECT COUNT(*)")) return makeStmt([{ n: 0 }]); // cap not reached
      if (sql.startsWith("INSERT INTO growth_journal")) {
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            insertBound = binds;
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
        return stmt;
      }
      return makeStmt([]);
    });

    const res = await postGrowthJournal(authedJson("https://test.local/mind/growth/journal", "POST", {
      companion_id: "cypher",
      entry_type: "reconsolidation",
      content: "Updated understanding of the old take.",
      source: "autonomous",
      tags: ["reconsolidation"],
      supersedes_id: "canon-1",
    }), env);

    expect(res.status).toBe(201);
    // entry_type is bind position 2 (after id, companion_id); supersedes_id is last
    expect(insertBound[2]).toBe("reconsolidation");
    expect(insertBound[insertBound.length - 1]).toBe("canon-1");
  });

  it("rejects a supersedes_id that is missing / not accepted / other companion", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT id FROM growth_journal") && sql.includes("review_status = 'accepted'")) {
        return makeStmt([]); // not found
      }
      return makeStmt([]);
    });

    const res = await postGrowthJournal(authedJson("https://test.local/mind/growth/journal", "POST", {
      companion_id: "cypher",
      entry_type: "reconsolidation",
      content: "Proposal pointing at nothing.",
      supersedes_id: "ghost-id",
    }), env);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("supersedes_id");
  });
});

describe("acceptJournalEntry reconsolidation tagging", () => {
  it("tags the superseded row via json_insert when the accepting entry carries supersedes_id", async () => {
    let tagSql = "";
    let tagBound: unknown[] = [];
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("UPDATE growth_journal SET review_status")) {
        return makeStmt([{}]); // changes: 1 -> flip succeeded
      }
      if (sql.startsWith("SELECT supersedes_id, charge_phase FROM growth_journal")) {
        return makeStmt([{ supersedes_id: "canon-1", charge_phase: "active" }]);
      }
      if (sql.includes("json_insert")) {
        tagSql = sql;
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            tagBound = binds;
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
        return stmt;
      }
      return makeStmt([]);
    });

    const res = await acceptJournalEntry(
      authedJson("https://test.local/mind/growth/journal/new-1/accept", "PATCH", { companion_id: "cypher" }),
      env,
      { id: "new-1" },
    );

    expect(res.status).toBe(200);
    // SQL-level json mutation, no JS read-modify-write
    expect(tagSql).toContain("json_insert(coalesce(tags_json, '[]')");
    expect(tagBound[0]).toBe("superseded:new-1");
    expect(tagBound[1]).toBe("canon-1");
  });

  it("does not tag anything when the accepted entry has no supersedes_id", async () => {
    let tagged = false;
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("UPDATE growth_journal SET review_status")) return makeStmt([{}]);
      if (sql.startsWith("SELECT supersedes_id")) return makeStmt([{ supersedes_id: null }]);
      if (sql.includes("json_insert")) { tagged = true; return makeStmt([{}]); }
      return makeStmt([]);
    });

    const res = await acceptJournalEntry(
      authedJson("https://test.local/mind/growth/journal/new-2/accept", "PATCH", { companion_id: "cypher" }),
      env,
      { id: "new-2" },
    );

    expect(res.status).toBe(200);
    expect(tagged).toBe(false);
  });
});
