import { describe, it, expect } from "vitest";
import { postGrowthPattern, postGrowthMarker, getUnmaterialized, patchVaultPath, getGrowthJournal } from "../handlers/growth.js";

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
  it("materializes only ACCEPTED journal, and surfaces orphaned (non-accepted but materialized) rows", async () => {
    let queriesSeen: string[] = [];
    const env = makeEnv((sql: string) => {
      queriesSeen.push(sql);
      // Orphaned query: journal rows with a vault_path that are NOT accepted.
      if (sql.includes("FROM growth_journal") && sql.includes("IS NOT NULL")) {
        return makeStmt([{ id: "orph1", vault_path: "Companions/cypher/growth/journal/x.md" }]);
      }
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
    expect(body.orphaned).toEqual([{ id: "orph1", vault_path: "Companions/cypher/growth/journal/x.md" }]);
    // The journal-materialize query gates on accepted; the three materialize
    // queries filter vault_path IS NULL; the orphaned query filters IS NOT NULL.
    const journalMaterialize = queriesSeen.find(q => q.includes("FROM growth_journal") && q.includes("vault_path IS NULL"));
    expect(journalMaterialize).toContain("review_status = 'accepted'");
    const orphanedQ = queriesSeen.find(q => q.includes("FROM growth_journal") && q.includes("IS NOT NULL"));
    expect(orphanedQ).toContain("review_status != 'accepted'");
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

  it("clears vault_path to NULL when body.vault_path is null (un-materialization)", async () => {
    let updateSql = "";
    const env = makeEnv((sql: string) => {
      if (sql.startsWith("UPDATE growth_journal")) {
        updateSql = sql;
        return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      }
      return makeStmt([]);
    });
    const res = await patchVaultPath(
      authedJson("https://test.local/x", "PATCH", { vault_path: null }),
      env,
      { kind: "journal", id: "abc" },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.vault_path).toBe(null);
    expect(updateSql).toContain("vault_path = NULL");
  });
});

// ---------------------------------------------------------------------------
// getGrowthJournal paging (2026-08-12)
//
// The list was `LIMIT ?` with no offset and a hard cap of 100, and all three companions sat AT
// the cap -- so Hearth's "view the full list" showed a first page it could not describe as
// partial. These tests pin the three properties that made the old shape unfixable from outside:
// a total on the SAME predicate as the page, a deterministic order under OFFSET, and a queue
// that drains from its oldest end.
// ---------------------------------------------------------------------------

function authedGet(url: string): Request {
  return new Request(url, { headers: { "Authorization": "Bearer test-secret" } });
}

/** Captures the SELECT that returns rows and the COUNT that labels them, plus their bindings. */
function makeJournalEnv(rowCount: number, total: number) {
  const seen = { listSql: "", listBinds: [] as unknown[], countSql: "", countBinds: [] as unknown[] };
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: `j${i}`, companion_id: "cypher" }));
  const env = makeEnv((sql: string) => {
    if (sql.startsWith("SELECT COUNT(*)")) {
      seen.countSql = sql;
      return { bind: (...b: unknown[]) => { seen.countBinds = b; return { first: async () => ({ n: total }) }; } };
    }
    if (sql.startsWith("SELECT * FROM growth_journal")) {
      seen.listSql = sql;
      return { bind: (...b: unknown[]) => { seen.listBinds = b; return { all: async () => ({ results: rows }) }; } };
    }
    return makeStmt([]);
  });
  return { env, seen };
}

describe("getGrowthJournal paging", () => {
  it("returns total/offset/has_more and pages with OFFSET", async () => {
    const { env, seen } = makeJournalEnv(100, 247);
    const res = await getGrowthJournal(
      authedGet("https://test.local/mind/growth/journal/cypher?limit=100&offset=100"),
      env,
      { companion_id: "cypher" },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.total).toBe(247);
    expect(body.offset).toBe(100);
    expect(body.limit).toBe(100);
    // 100 + 100 < 247 -- there is a third page, and the caller is told so rather than inferring it
    // from a full page (the inference that could not distinguish "exactly 100" from "hundreds").
    expect(body.has_more).toBe(true);
    expect(seen.listSql).toContain("OFFSET ?");
    expect(seen.listBinds).toEqual(["cypher", 100, 100]);
  });

  it("has_more is false on the last page", async () => {
    const { env } = makeJournalEnv(47, 247);
    const res = await getGrowthJournal(
      authedGet("https://test.local/x?limit=100&offset=200"), env, { companion_id: "cypher" });
    const body = await res.json() as any;
    expect(body.has_more).toBe(false);
  });

  it("breaks ORDER BY ties on id, so a row cannot repeat on one page and vanish from the next", async () => {
    const { env, seen } = makeJournalEnv(20, 20);
    await getGrowthJournal(authedGet("https://test.local/x"), env, { companion_id: "cypher" });
    expect(seen.listSql).toContain("created_at DESC, id DESC");
  });

  it("counts on the SAME predicate as the page it labels (pending view)", async () => {
    const { env, seen } = makeJournalEnv(17, 17);
    await getGrowthJournal(
      authedGet("https://test.local/x?pending=1"), env, { companion_id: "cypher" });
    // Both statements must carry the ratifiable filter; a total from a wider WHERE would name a
    // number the list cannot show -- the disagreement this file has already recorded twice.
    expect(seen.listSql).toContain("review_status");
    expect(seen.countSql).toContain("review_status");
    expect(seen.countBinds).toEqual(["cypher"]);
  });

  it("orders the ratification queue oldest-first, so the backlog's tail is reachable", async () => {
    const { env, seen } = makeJournalEnv(5, 5);
    await getGrowthJournal(authedGet("https://test.local/x?pending=1"), env, { companion_id: "cypher" });
    expect(seen.listSql).toContain("created_at ASC");
  });

  it("clamps limit to 100 and rejects a negative or unparseable offset", async () => {
    const { env, seen } = makeJournalEnv(100, 500);
    await getGrowthJournal(
      authedGet("https://test.local/x?limit=99999&offset=-5"), env, { companion_id: "cypher" });
    expect(seen.listBinds).toEqual(["cypher", 100, 0]);

    const b = makeJournalEnv(20, 20);
    await getGrowthJournal(
      authedGet("https://test.local/x?limit=abc&offset=xyz"), b.env, { companion_id: "cypher" });
    expect(b.seen.listBinds).toEqual(["cypher", 20, 0]);
  });
});
