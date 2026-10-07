// One write core for architect_facts (2026-10-07).
//
// Drevan's Claude.ai orient carried a superseded ankle fact beside its replacement. Prod: four
// ankle rows written through ask_librarian, none with supersedes_id, three of them absent from
// Vectorize -- the executor did a bare INSERT (no gate, no vector) while the HTTP handler had both.
// And the two OPEN "Magpie's pronouns" rows scored 0.817 against each other, under the 0.95 skip.
//
// These pin: both paths share the gate + indexing; an open write collapses into a held open
// question; the ack names the nearest fact so the companion CAN supersede; link mode retires
// after the fact; prefixes resolve uniquely or not at all; the orient render prints the handle.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../mcp/embed.js", () => ({
  embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  storeVector: vi.fn(async () => {}),
}));
vi.mock("../webmind/novelty.js", () => ({ noveltyCheck: vi.fn() }));

import { execArchitectFactWrite } from "../librarian/executors/architect-facts.js";
import { postArchitectFact } from "../handlers/architect-facts.js";
import { resolveFactId, linkFactSupersession, OPEN_FACT_SKIP } from "../lib/architect-fact-write.js";
import { noveltyCheck } from "../webmind/novelty.js";
import { storeVector } from "../mcp/embed.js";
import { architectFactsBlock } from "../librarian/response/orient-blocks.js";

interface Row { id: string; status: string; supersedes_id: string | null }

/** Minimal architect_facts fake: enough SQL shapes for the write core, nothing more. */
function makeEnv(rows: Row[] = []) {
  const batched: Array<{ sql: string; args: unknown[] }> = [];
  const deleted: string[][] = [];
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql, args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      if (sql.includes("WHERE id = ?")) return rows.find(r => r.id === args[0]) ?? null;
      return null;
    },
    all: async () => {
      if (sql.includes("WHERE id LIKE ?")) {
        const p = String(args[0]).replace(/%$/, "");
        return { results: rows.filter(r => r.id.startsWith(p)).slice(0, 2) };
      }
      if (sql.includes("WHERE id IN (?, ?)")) return { results: rows.filter(r => args.includes(r.id)) };
      return { results: [] };
    },
  });
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => {
        for (const s of stmts) {
          batched.push(s);
          if (s.sql.includes("SET status = 'retired'")) {
            const r = rows.find(x => x.id === s.args[0]); if (r) r.status = "retired";
          }
          if (s.sql.includes("SET supersedes_id = ?")) {
            const r = rows.find(x => x.id === s.args[1]); if (r && r.supersedes_id === null) r.supersedes_id = String(s.args[0]);
          }
        }
        return [];
      },
    },
    VECTORIZE: { deleteByIds: async (ids: string[]) => { deleted.push(ids); } },
  } as never;
  return { env, batched, deleted };
}

const ctx = (env: unknown, context: Record<string, unknown>) => ({
  env, req: { companion_id: "drevan", context: JSON.stringify(context) }, entry: {}, frontState: null, pluralAvailable: false,
}) as never;

const mockedNovelty = vi.mocked(noveltyCheck);
beforeEach(() => { vi.clearAllMocks(); });

describe("executor write path (ask_librarian) now shares the gate", () => {
  it("runs the novelty gate and INDEXES the fact -- the bare INSERT never did", async () => {
    mockedNovelty.mockResolvedValueOnce({ action: "insert", embedding: [0.1] });
    const { env, batched } = makeEnv();
    const out = await execArchitectFactWrite(ctx(env, { fact: "Ankle MRI: no tear.", category: "health" }));
    expect(noveltyCheck).toHaveBeenCalledOnce();
    expect(vi.mocked(noveltyCheck).mock.calls[0]!.slice(2, 5)).toEqual(["architect_facts", "drevan", "table"]);
    expect(storeVector).toHaveBeenCalledOnce();
    expect(batched.some(s => s.sql.includes("INSERT INTO architect_facts"))).toBe(true);
    expect(String(out.ack)).toMatch(/^Recorded as /);
  });

  it("a near-identical restatement is deduped and the ack says how to supersede instead", async () => {
    mockedNovelty.mockResolvedValueOnce({ action: "skip", matchRowId: "old-ankle", score: 0.96 });
    const { env, batched } = makeEnv();
    const out = await execArchitectFactWrite(ctx(env, { fact: "Ankle MRI: no tear." }));
    expect(batched).toHaveLength(0);
    expect(String(out.ack)).toContain("Already held");
    expect(String(out.ack)).toContain('supersedes_id "old-ankle"');
  });

  it("names the nearest fact when the new one sits close to it -- the missing affordance", async () => {
    mockedNovelty.mockResolvedValueOnce({ action: "insert", embedding: [0.1], nearest: { matchRowId: "bbc4b66c-old", score: 0.86 } });
    const { env } = makeEnv();
    const out = await execArchitectFactWrite(ctx(env, { fact: "MRI read: Achilles intact." }));
    expect(String(out.ack)).toContain("bbc4b66c-old");
    expect(String(out.ack)).toContain('retire_id: "bbc4b66c-old"');
    // It does NOT retire on its own: supersession stays the companion's call (mig 0112).
    expect(String(out.ack)).not.toContain("superseding");
  });

  it("stays silent about weak neighbours", async () => {
    mockedNovelty.mockResolvedValueOnce({ action: "insert", embedding: [0.1], nearest: { matchRowId: "x", score: 0.6 } });
    const { env } = makeEnv();
    const out = await execArchitectFactWrite(ctx(env, { fact: "Something unrelated." }));
    expect(String(out.ack)).not.toContain("sits close");
  });

  it("an OPEN write asks the gate for the open-question threshold; an ACTIVE one does not", async () => {
    mockedNovelty.mockResolvedValue({ action: "insert", embedding: null });
    const { env } = makeEnv();
    await execArchitectFactWrite(ctx(env, { fact: "Magpie's pronouns?", status: "open" }));
    await execArchitectFactWrite(ctx(env, { fact: "Magpie uses they/them." }));
    expect(mockedNovelty.mock.calls[0]![5]).toEqual({ openSkipThreshold: OPEN_FACT_SKIP });
    expect(mockedNovelty.mock.calls[1]![5]).toEqual({});
  });

  it("supersedes by an 8-char prefix (what the orient block prints) and retires the old row", async () => {
    const { env, batched, deleted } = makeEnv([{ id: "0c20a903-d0b0-4b81-bf60-ac639a2a6ecb", status: "active", supersedes_id: null }]);
    const out = await execArchitectFactWrite(ctx(env, { fact: "MRI: partial tear ruled out.", supersedes_id: "0c20a903" }));
    expect(noveltyCheck).not.toHaveBeenCalled();
    expect(String(out.ack)).toContain("superseding 0c20a903-d0b0-4b81-bf60-ac639a2a6ecb");
    expect(batched.some(s => s.sql.includes("SET status = 'retired'"))).toBe(true);
    expect(deleted).toEqual([["architect_facts:0c20a903-d0b0-4b81-bf60-ac639a2a6ecb"]]);
  });
});

describe("link mode: retire_id + replaced_by", () => {
  it("retires the old row and records lineage on the new one, writing no third row", async () => {
    const rows: Row[] = [
      { id: "old11111-aaaa", status: "active", supersedes_id: null },
      { id: "new22222-bbbb", status: "active", supersedes_id: null },
    ];
    const { env, batched } = makeEnv(rows);
    const out = await execArchitectFactWrite(ctx(env, { retire_id: "old11111", replaced_by: "new22222" }));
    expect(String(out.ack)).toMatch(/^Linked:/);
    expect(rows[0]!.status).toBe("retired");
    expect(rows[1]!.supersedes_id).toBe("old11111-aaaa");
    expect(batched.some(s => s.sql.includes("INSERT"))).toBe(false);
  });

  it("refuses half a link, a self-link, and an already-retired target", async () => {
    const rows: Row[] = [
      { id: "old11111-aaaa", status: "retired", supersedes_id: null },
      { id: "new22222-bbbb", status: "active", supersedes_id: null },
    ];
    const { env } = makeEnv(rows);
    expect(String((await execArchitectFactWrite(ctx(env, { retire_id: "old11111" }))).ack)).toContain("needs both");
    expect((await linkFactSupersession(env, "new22222-bbbb", "new22222-bbbb")).ok).toBe(false);
    expect((await linkFactSupersession(env, "old11111", "new22222")).ok).toBe(false);
  });
});

describe("resolveFactId", () => {
  const rows: Row[] = [
    { id: "abcdef12-1111", status: "active", supersedes_id: null },
    { id: "abcdef12-2222", status: "active", supersedes_id: null },
    { id: "seed-026", status: "active", supersedes_id: null },
  ];
  it("exact id wins, including short seed ids", async () => {
    expect(await resolveFactId(makeEnv(rows).env, "seed-026")).toEqual({ id: "seed-026" });
    expect(await resolveFactId(makeEnv(rows).env, "[seed-026]")).toEqual({ id: "seed-026" });
  });
  it("an ambiguous prefix is an error, never a guess", async () => {
    expect(await resolveFactId(makeEnv(rows).env, "abcdef12")).toHaveProperty("error");
  });
  it("too-short or wildcard prefixes never match", async () => {
    expect(await resolveFactId(makeEnv(rows).env, "abc")).toHaveProperty("error");
    expect(await resolveFactId(makeEnv(rows).env, "abcdef1%")).toHaveProperty("error");
  });
});

describe("HTTP path shares the core", () => {
  it("returns the related pointer on an unprompted write", async () => {
    mockedNovelty.mockResolvedValueOnce({ action: "insert", embedding: [0.1], nearest: { matchRowId: "near", score: 0.9 } });
    const { env } = makeEnv();
    const res = await postArchitectFact(new Request("https://x/identity/architect-facts", {
      method: "POST", body: JSON.stringify({ fact: "x", companion_id: "drevan" }),
    }), env);
    expect(await res.json()).toMatchObject({ ok: true, related: { id: "near", score: 0.9 } });
  });

  it("a supersede naming a missing row is a 400, not a duplicate", async () => {
    const { env } = makeEnv();
    const res = await postArchitectFact(new Request("https://x/identity/architect-facts", {
      method: "POST", body: JSON.stringify({ fact: "x", supersedes_id: "nope-nope-nope" }),
    }), env);
    expect(res.status).toBe(400);
  });
});

describe("orient render prints the handle", () => {
  it("each active and open line ends with its 8-char [id]", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const block = architectFactsBlock([
      { id: "0c20a903-d0b0-4b81-bf60-ac639a2a6ecb", fact: "ankle", category: "health", status: "active", weight: 10 },
      { id: "a29da517-07c0-43be-b134-58036c3abd53", fact: "magpie?", category: "general", status: "open", created_at: "2026-10-04 01:43:02" },
    ], { now });
    expect(block).toContain("• (health) ankle [0c20a903]");
    expect(block).toContain("• magpie? [a29da517]");
    expect(block).toContain("supersedes_id");
  });
});
