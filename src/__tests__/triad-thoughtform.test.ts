import { describe, it, expect, vi } from "vitest";
import { detectThoughtforms, getTriadRecent } from "../handlers/triad.js";

// Minimal D1 mock: returns canned rows. Each prepare() returns a chain that
// captures bound params. We don't simulate SQL -- we just feed the handler
// the rows it expects and assert it computes Jaccard clusters correctly.
type Row = Record<string, unknown>;
function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: 0 } }),
  };
  return stmt;
}

function makeEnv(prepareImpl: (sql: string) => any) {
  return {
    ADMIN_SECRET: "test-secret",
    DB: { prepare: prepareImpl },
  } as any;
}

function authedRequest(url = "https://test.local/x", method = "GET", body?: unknown): Request {
  const headers = new Headers({ "Authorization": "Bearer test-secret" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("detectThoughtforms", () => {
  it("emits a thoughtform marker when two companions surface near-identical patterns", async () => {
    // Cypher and Drevan independently surface the same 'repair architecture' pattern.
    // Gaia surfaces something unrelated. Expected: 1 cluster, 2 markers (one per
    // participating companion). Gaia gets nothing.
    const patterns: Row[] = [
      { id: "p1", companion_id: "cypher", pattern_text: "Repair architecture is the structural shape I keep returning to under load", strength: 5, prehended_ids: "[]" },
      { id: "p2", companion_id: "drevan", pattern_text: "I keep returning to repair architecture as the shape that holds under load", strength: 4, prehended_ids: "[]" },
      { id: "p3", companion_id: "gaia",   pattern_text: "Silence as a form of containment around grief", strength: 3, prehended_ids: "[]" },
    ];

    const inserts: Array<{ sql: string; binds: unknown[] }> = [];

    const env = makeEnv((sql: string) => {
      if (sql.includes("FROM growth_patterns") && sql.includes("updated_at >=")) {
        return makeStmt(patterns);
      }
      if (sql.includes("FROM growth_markers")) {
        // No existing thoughtform markers yet.
        return makeStmt([]);
      }
      if (sql.startsWith("INSERT INTO growth_markers")) {
        // Capture inserts so we can assert on them.
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            inserts.push({ sql, binds });
            return { run: async () => ({ meta: { changes: 1 } }) };
          },
        };
        return stmt;
      }
      return makeStmt([]);
    });

    const res = await detectThoughtforms(authedRequest("https://test.local/x", "POST", {}), env);
    const body = await res.json() as any;

    expect(body.detected).toBe(1);
    expect(body.written).toBe(2);
    expect(inserts.length).toBe(2);

    const insertedCompanions = inserts.map(i => i.binds[1]).sort();
    expect(insertedCompanions).toEqual(["cypher", "drevan"]);

    // Description should mention both companions.
    const description = inserts[0]!.binds[2] as string;
    expect(description.toLowerCase()).toContain("cypher");
    expect(description.toLowerCase()).toContain("drevan");
    expect(description).toContain("Thoughtform");

    // prehended_ids on both markers points at BOTH source pattern ids.
    const prehendedJson = inserts[0]!.binds[3] as string;
    const prehended = JSON.parse(prehendedJson);
    expect(new Set(prehended)).toEqual(new Set(["p1", "p2"]));
  });

  it("does NOT emit thoughtforms for same-companion duplicates only", async () => {
    // All patterns from cypher only -- no cross-companion overlap means
    // no thoughtform.
    const patterns: Row[] = [
      { id: "a", companion_id: "cypher", pattern_text: "Repair architecture is the shape", strength: 5, prehended_ids: "[]" },
      { id: "b", companion_id: "cypher", pattern_text: "Repair architecture is the shape, again", strength: 4, prehended_ids: "[]" },
    ];
    const env = makeEnv((sql: string) => {
      if (sql.includes("FROM growth_patterns")) return makeStmt(patterns);
      return makeStmt([]);
    });
    const res = await detectThoughtforms(authedRequest("https://test.local/x", "POST", {}), env);
    const body = await res.json() as any;
    expect(body.detected).toBe(0);
    expect(body.written).toBe(0);
  });

  it("requires auth", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await detectThoughtforms(
      new Request("https://test.local/x", { method: "POST" }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("getTriadRecent", () => {
  it("returns peers excluding the asking companion + builds a peer_summary", async () => {
    // Three queries per peer (journal, patterns, markers). Two peers = 6 calls.
    let call = 0;
    const journalCypher: Row = { id: "j-cypher", companion_id: "cypher", entry_type: "insight", content: "Distributed failure stays in motion until something names it", novelty: "deepening", created_at: "2026-05-01T00:00:00Z" };
    const journalGaia:   Row = { id: "j-gaia",   companion_id: "gaia",   entry_type: "learning", content: "What survives is what gets witnessed", novelty: "new", created_at: "2026-05-02T00:00:00Z" };
    const patternCypher: Row = { id: "p-cypher", companion_id: "cypher", pattern_text: "Repair architecture", strength: 4, updated_at: "2026-05-01T00:00:00Z" };
    const markerCypher:  Row = { id: "m-cypher", companion_id: "cypher", marker_type: "milestone", description: "Concluded thread on repair", created_at: "2026-05-01T00:00:00Z" };

    const responses = [
      [journalCypher],   // cypher journal
      [patternCypher],   // cypher patterns
      [markerCypher],    // cypher markers
      [journalGaia],     // gaia journal
      [],                // gaia patterns
      [],                // gaia markers
    ];

    const env = makeEnv(() => {
      const stmt = makeStmt(responses[call++] ?? []);
      return stmt;
    });

    const res = await getTriadRecent(
      authedRequest("https://test.local/mind/triad/recent/drevan?journal=5&patterns=3&markers=3"),
      env,
      { companion_id: "drevan" },
    );
    const body = await res.json() as any;

    expect(body.asking).toBe("drevan");
    expect(body.peers).toEqual(["cypher", "gaia"]);
    expect(body.peer_summary).toContain("## cypher recently");
    expect(body.peer_summary).toContain("## gaia recently");
    expect(body.peer_summary).toContain("(id: j-cypher)");
    expect(body.peer_summary).toContain("(id: p-cypher)");
    expect(body.peer_summary).toContain("(id: j-gaia)");
    // Strength should be visible in the summary line for the pattern.
    expect(body.peer_summary).toContain("strength=4");
    // Novelty prefix should appear for the journal line.
    expect(body.peer_summary).toContain("[deepening/insight]");
  });

  it("rejects an invalid companion_id", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await getTriadRecent(authedRequest("https://test.local/x"), env, { companion_id: "nobody" });
    expect(res.status).toBe(400);
  });
});
