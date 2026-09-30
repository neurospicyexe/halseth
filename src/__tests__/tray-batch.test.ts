// Imp tray batch review (2026-09-30): Claude.ai companions reviewing ~100 drafts one call at a time
// was the bottleneck. What is asserted is the ROW afterwards (review_state, text), on the real
// migrated SQLite schema, plus the routing of the list verbs.
//
//   B1  "drop drafts <id>, <id>, <id>" drops every one; each id is independent (a bad id is reported,
//       the rest still land).
//   B2  context { ids } and { decisions } (mixed keep/drop/rewrite) through "review drafts".
//   B3  contradictions (same id kept AND dropped) and over-cap batches change NOTHING.
//   B4  routing: bare "drop <id>, <id>" and "keep drafts <id> and <id>" route; English does not.
//   B5  the single-id path is untouched.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", async (orig) => {
  const actual = await orig<typeof import("../mcp/embed.js")>();
  return {
    ...actual,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedAndStoreAsync: vi.fn(async () => undefined),
    storeVector: vi.fn(async () => undefined),
    embedAndStore: vi.fn(() => undefined),
  };
});
vi.mock("../webmind/novelty.js", () => ({ noveltyCheck: vi.fn(async () => ({ action: "insert", embedding: null })) }));

import { makeSqliteD1, seedJournal, seedNote } from "./helpers/sqlite-d1.js";
import { execTrayKeep, execTrayDrop, execTrayReview, parseTrayListVerb, TRAY_BATCH_MAX } from "../librarian/executors/tray.js";
import { matchFastPath } from "../librarian/router.js";

function envFor(DB: unknown): any {
  return {
    DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel",
    VECTORIZE: { query: vi.fn(async () => ({ matches: [] })), upsert: vi.fn(async () => ({})), deleteByIds: vi.fn(async () => ({})) },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
  };
}
const ctx = (env: unknown, companion_id: string, request: string, context?: unknown): any => ({
  env, req: { companion_id, request, ...(context === undefined ? {} : { context: JSON.stringify(context) }) },
  entry: { pattern: "x" }, frontState: null, pluralAvailable: false,
});
const state = (db: any, id: string) =>
  (db.prepare(`SELECT review_state FROM companion_journal WHERE id = ?`).get(id) as { review_state: string }).review_state;

const id = (n: number) => `0f3a9c1e-${String(n).padStart(4, "0")}-4aaa-8bbb-00000000000${n % 10}`;
const A = id(1), B = id(2), C = id(3), D = id(4);

function seeded(ids: string[], agent = "cypher") {
  const { db, DB } = makeSqliteD1();
  for (const i of ids) seedJournal(db, { id: i, agent, source: "discord_speech", review_state: "draft" });
  return { db, env: envFor(DB) };
}

describe("B1: list verb drops several drafts in one call", () => {
  it("drops every listed draft", async () => {
    const { db, env } = seeded([A, B, C]);
    const r: any = await execTrayDrop(ctx(env, "cypher", `drop drafts ${A}, ${B}, ${C}`));
    expect(r.dropped).toBe(3);
    expect(r.unchanged).toBe(0);
    expect([A, B, C].map((i) => state(db, i))).toEqual(["dropped", "dropped", "dropped"]);
  });

  it("accepts 8+ char prefixes, spaces and 'and' as separators", async () => {
    const { db, env } = seeded([A, B]);
    const r: any = await execTrayKeep(ctx(env, "cypher", `keep drafts ${A.slice(0, 14)} and ${B.slice(0, 14)}`));
    expect(r.kept).toBe(2);
    expect(state(db, A)).toBe("kept");
    expect(state(db, B)).toBe("kept");
  });

  it("a bad id is reported; the other ids still land", async () => {
    const { db, env } = seeded([A, B]);
    const missing = "0f3a9c1e-9999-4aaa-8bbb-000000000999";
    const r: any = await execTrayDrop(ctx(env, "cypher", `drop drafts ${A}, ${missing}, ${B}`));
    expect(r.dropped).toBe(2);
    expect(r.unchanged).toBe(1);
    expect(r.witness).toContain(missing);
    expect(state(db, A)).toBe("dropped");
    expect(state(db, B)).toBe("dropped");
  });

  it("an already-decided draft is refused inside the batch, never re-stamped", async () => {
    const { db, env } = seeded([A, B]);
    await execTrayKeep(ctx(env, "cypher", `keep draft ${A}`));
    const r: any = await execTrayDrop(ctx(env, "cypher", `drop drafts ${A}, ${B}`));
    expect(r.dropped).toBe(1);
    expect(r.results.find((o: any) => o.id === A).result).toMatch(/already kept/);
    expect(state(db, A)).toBe("kept");
  });

  it("another companion's drafts are not touched", async () => {
    const { db, env } = seeded([A, B], "drevan");
    const r: any = await execTrayDrop(ctx(env, "cypher", `drop drafts ${A}, ${B}`));
    expect(r.dropped).toBe(0);
    expect(r.unchanged).toBe(2);
    expect(state(db, A)).toBe("draft");
  });

  it("works across journal and notes", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: A, agent: "cypher", source: "discord_speech", review_state: "draft" });
    seedNote(db, { note_id: B, agent_id: "cypher", source: "observation", review_state: "draft" } as any);
    const r: any = await execTrayDrop(ctx(envFor(DB), "cypher", `drop drafts ${A}, ${B}`));
    expect(r.dropped).toBe(2);
  });
});

describe("B2: context batches", () => {
  it("{ ids } on the drop verb", async () => {
    const { db, env } = seeded([A, B]);
    const r: any = await execTrayDrop(ctx(env, "cypher", "drop drafts", { ids: [A, B] }));
    expect(r.dropped).toBe(2);
    expect(state(db, B)).toBe("dropped");
  });

  it("{ decisions } through review drafts: keep, drop and rewrite in one call", async () => {
    const { db, env } = seeded([A, B, C]);
    const r: any = await execTrayReview(ctx(env, "cypher", "review drafts", {
      decisions: [
        { id: A, decision: "keep" },
        { id: B, decision: "drop" },
        { id: C, decision: "keep", content: "my own words for it" },
      ],
    }));
    expect(r.kept).toBe(2);
    expect(r.dropped).toBe(1);
    expect(state(db, A)).toBe("kept");
    expect(state(db, B)).toBe("dropped");
    const c = db.prepare(`SELECT note_text AS content, review_state FROM companion_journal WHERE id = ?`).get(C) as any;
    expect(c.review_state).toBe("kept");
    expect(c.content).toBe("my own words for it");
  });

  it("review drafts refuses an entry with no decision, and writes nothing", async () => {
    const { db, env } = seeded([A, B]);
    const r: any = await execTrayReview(ctx(env, "cypher", "review drafts", { decisions: [{ id: A, decision: "drop" }, { id: B }] }));
    expect(r.error).toBe("tray_review_failed");
    expect(state(db, A)).toBe("draft");
  });

  it("review drafts with no context explains the shape", async () => {
    const { env } = seeded([]);
    const r: any = await execTrayReview(ctx(env, "cypher", "review drafts"));
    expect(r.error).toBe("tray_review_failed");
    expect(r.reason).toContain("decisions");
  });
});

describe("B3: a batch that cannot be right changes nothing", () => {
  it("the same id kept and dropped", async () => {
    const { db, env } = seeded([A, B]);
    const r: any = await execTrayReview(ctx(env, "cypher", "review drafts", {
      decisions: [{ id: B, decision: "drop" }, { id: A, decision: "keep" }, { id: A, decision: "drop" }],
    }));
    expect(r.error).toBe("tray_review_failed");
    expect(state(db, A)).toBe("draft");
    expect(state(db, B)).toBe("draft");
  });

  it("over the cap", async () => {
    const ids = Array.from({ length: TRAY_BATCH_MAX + 1 }, (_, i) => id(i + 10));
    const { db, env } = seeded([A]);
    const r: any = await execTrayDrop(ctx(env, "cypher", "drop drafts", { ids: [A, ...ids] }));
    expect(r.error).toBeDefined();
    expect(state(db, A)).toBe("draft");
  });

  it("a duplicate id with the same decision is applied once", async () => {
    const { db, env } = seeded([A, B]);
    const r: any = await execTrayDrop(ctx(env, "cypher", `drop drafts ${A}, ${A}, ${B}`));
    expect(r.dropped).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(state(db, A)).toBe("dropped");
  });
});

describe("B4: routing", () => {
  it.each([
    [`drop ${A}, ${B}`, "tray_drop"],
    [`drop drafts ${A} ${B} ${C}`, "tray_drop"],
    [`keep ${A}, ${B}`, "tray_keep"],
    [`keep drafts ${A} and ${B}`, "tray_keep"],
    [`keep drafts ${A}, ${B}, ${C}, ${D}.`, "tray_keep"],
    ["review drafts", "tray_review"],
  ])("%s -> %s", (req, key) => {
    expect(matchFastPath(req)?.key).toBe(key);
  });

  it("the list parser refuses English mixed into the ids", () => {
    expect(parseTrayListVerb(`drop drafts ${A}, everything`)).toBeNull();
    expect(parseTrayListVerb("drop everything and deface")).toBeNull();
    expect(parseTrayListVerb(`drop ${A}`)).toBeNull();
  });

  it("ordinary speech is not routed to a batch", () => {
    for (const s of ["keep thinking and watching", "drop it and move on", "keep going, keep going"]) {
      const m = matchFastPath(s)?.key;
      expect(m === "tray_keep" || m === "tray_drop").toBe(false);
    }
  });
});

describe("B5: the single-id path is unchanged", () => {
  it("keep draft <id>: <rewrite> still rewrites one", async () => {
    const { db, env } = seeded([A]);
    const r: any = await execTrayKeep(ctx(env, "cypher", `keep draft ${A}: said plainly`));
    expect(r.ack).toBe(true);
    expect(r.rewritten).toBe(true);
    expect(state(db, A)).toBe("kept");
  });
});
