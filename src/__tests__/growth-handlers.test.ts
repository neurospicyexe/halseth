import { describe, it, expect } from "vitest";
import { postGrowthPattern, postGrowthMarker, getUnmaterialized, patchVaultPath } from "../handlers/growth.js";

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

describe("postGrowthPattern UPSERT", () => {
  it("UPSERTS into an existing similar pattern (action=upsert, strength incremented)", async () => {
    const existingPattern: Row = {
      id: "existing-1",
      pattern_text: "I keep returning to repair architecture under load",
      strength: 4,
      evidence_json: JSON.stringify([{ quote: "earlier quote" }]),
      prehended_ids: JSON.stringify(["row-a"]),
    };
    let updateBound: unknown[] = [];

    const env = makeEnv((sql: string) => {
      // filterExistingIds union query — return row-b as found so the prehension
      // makes it through validation. row-a is already in the existing pattern.
      if (sql.startsWith("SELECT id FROM growth_journal") && sql.includes("UNION SELECT id FROM growth_patterns")) {
        return makeStmt([{ id: "row-b" }]);
      }
      if (sql.startsWith("SELECT id, pattern_text") && sql.includes("FROM growth_patterns")) {
        return makeStmt([existingPattern]);
      }
      if (sql.startsWith("UPDATE growth_patterns")) {
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            updateBound = binds;
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
        return stmt;
      }
      // No INSERT path expected.
      return makeStmt([]);
    });

    const res = await postGrowthPattern(authedJson(
      "https://test.local/mind/growth/patterns",
      "POST",
      {
        companion_id: "cypher",
        pattern_text: "Repair architecture is the shape I keep returning to",
        evidence: [{ quote: "new quote" }],
        prehended_ids: ["row-b"],
        strength: 7,
      },
    ), env);

    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.action).toBe("upsert");
    expect(body.id).toBe("existing-1");
    expect(body.strength).toBe(5);  // 4 + 1, capped at 10

    // Update bind order: strength, evidence, prehended_ids, id
    expect(updateBound[0]).toBe(5);
    const mergedEvidence = JSON.parse(updateBound[1] as string);
    const mergedPrehended = JSON.parse(updateBound[2] as string);
    expect(mergedEvidence).toContainEqual({ quote: "earlier quote" });
    expect(mergedEvidence).toContainEqual({ quote: "new quote" });
    expect(mergedPrehended).toEqual(["row-a", "row-b"]);
  });

  it("INSERTS a brand new pattern when no similar pattern exists (action=insert)", async () => {
    let insertBound: unknown[] = [];
    const env = makeEnv((sql: string) => {
      // filterExistingIds: return seed-1 as known so the prehension survives.
      if (sql.startsWith("SELECT id FROM growth_journal") && sql.includes("UNION SELECT id FROM growth_patterns")) {
        return makeStmt([{ id: "seed-1" }]);
      }
      if (sql.startsWith("SELECT id, pattern_text")) return makeStmt([]); // no candidates
      if (sql.includes("SELECT COUNT(*)")) return makeStmt([{ n: 0 }]);  // cap not reached
      if (sql.startsWith("INSERT INTO growth_patterns")) {
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

    const res = await postGrowthPattern(authedJson(
      "https://test.local/x",
      "POST",
      {
        companion_id: "drevan",
        pattern_text: "The grammar of vows requires recursion to hold",
        evidence: [{ quote: "evidence" }],
        prehended_ids: ["seed-1"],
      },
    ), env);

    const body = await res.json() as any;
    expect(res.status).toBe(201);
    expect(body.action).toBe("insert");
    expect(insertBound).toBeTruthy();
  });
});

describe("postGrowthMarker dedupe + thoughtform", () => {
  it("accepts thoughtform marker_type", async () => {
    let captured: unknown[] = [];
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT id FROM growth_markers")) return makeStmt([]); // no dup
      if (sql.includes("SELECT COUNT(*)")) return makeStmt([{ n: 0 }]);
      if (sql.startsWith("INSERT INTO growth_markers")) {
        const stmt: any = {
          bind: (...b: unknown[]) => { captured = b; return { run: async () => ({ meta: { changes: 1 } }) }; },
        };
        return stmt;
      }
      return makeStmt([]);
    });

    const res = await postGrowthMarker(authedJson("https://test.local/x", "POST", {
      companion_id: "cypher",
      marker_type: "thoughtform",
      description: "Triad-shared shape: repair architecture",
      prehended_ids: ["p-cypher", "p-drevan"],
    }), env);
    expect(res.status).toBe(201);
    // captured: id, companion_id, marker_type, description, related_pattern_id, run_id, prehended_ids
    expect(captured[2]).toBe("thoughtform");
  });

  it("returns 200 'duplicate' for repeat marker with same description", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("SELECT id FROM growth_markers")) return makeStmt([{ id: "marker-1" }]);
      return makeStmt([]);
    });
    const res = await postGrowthMarker(authedJson("https://test.local/x", "POST", {
      companion_id: "cypher",
      marker_type: "thoughtform",
      description: "duplicate",
    }), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.action).toBe("skip");
    expect(body.id).toBe("marker-1");
  });
});

describe("getUnmaterialized", () => {
  it("returns three groups (journal, patterns, markers) only including rows with NULL vault_path", async () => {
    let queriesSeen: string[] = [];
    const env = makeEnv((sql: string) => {
      queriesSeen.push(sql);
      if (sql.includes("FROM growth_journal"))   return makeStmt([{ id: "j1" }]);
      if (sql.includes("FROM growth_patterns"))  return makeStmt([{ id: "p1" }]);
      if (sql.includes("FROM growth_markers"))   return makeStmt([{ id: "m1" }]);
      return makeStmt([]);
    });
    const res = await getUnmaterialized(
      new Request("https://test.local/x?limit=10", {
        headers: { "Authorization": "Bearer test-secret" },
      }),
      env,
      { companion_id: "cypher" },
    );
    const body = await res.json() as any;
    expect(body.journal).toEqual([{ id: "j1" }]);
    expect(body.patterns).toEqual([{ id: "p1" }]);
    expect(body.markers).toEqual([{ id: "m1" }]);
    // All three queries must filter on vault_path IS NULL.
    expect(queriesSeen.every(q => q.includes("vault_path IS NULL"))).toBe(true);
  });
});

describe("patchVaultPath", () => {
  it("rejects path traversal", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await patchVaultPath(
      authedJson("https://test.local/x", "PATCH", { vault_path: "../etc/passwd" }),
      env,
      { kind: "journal", id: "abc" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown kind", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await patchVaultPath(
      authedJson("https://test.local/x", "PATCH", { vault_path: "Companions/cypher/x.md" }),
      env,
      { kind: "evil", id: "abc" },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when no row matched", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("UPDATE growth_journal")) {
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
      }
      return makeStmt([]);
    });
    const res = await patchVaultPath(
      authedJson("https://test.local/x", "PATCH", { vault_path: "Companions/cypher/x.md" }),
      env,
      { kind: "journal", id: "missing-id" },
    );
    expect(res.status).toBe(404);
  });

  it("succeeds and returns vault_path", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("UPDATE growth_patterns")) {
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      }
      return makeStmt([]);
    });
    const res = await patchVaultPath(
      authedJson("https://test.local/x", "PATCH", { vault_path: "Companions/drevan/growth/patterns/x.md" }),
      env,
      { kind: "patterns", id: "real-id" },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.vault_path).toBe("Companions/drevan/growth/patterns/x.md");
  });
});
