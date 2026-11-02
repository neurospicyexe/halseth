// Librarian sb_search must ask Second Brain for RECALL mode when the request is a factual
// "what did we say / do you remember" question (2026-10-26, R19 follow-up).
//
// Found the day R19 (b) shipped: the Discord per-message recall passed mode "recall" (relevance floor,
// no query-blind pools), but every ask_librarian vault search -- Claude.ai and Hermes -- called
// sb_search with no mode, so "have we talked about X" got the default pool mix: 30% novelty/edge chunks
// chosen without looking at the query, and no floor at all. Exploratory asks ("search for", "anything
// about") keep the pool mix on purpose: that is where serendipity belongs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const dual = vi.fn(async () => JSON.stringify({ chunks: [] }));
const filtered = vi.fn(async () => JSON.stringify({ chunks: [] }));
vi.mock("../librarian/backends/second-brain.js", async (orig) => ({
  ...(await orig<typeof import("../librarian/backends/second-brain.js")>()),
  dualVectorSearch: (...a: unknown[]) => dual(...(a as [])),
  filteredRecall: (...a: unknown[]) => filtered(...(a as [])),
}));

import { execSbSearch, execSbRecall, sbSearchMode } from "../librarian/executors/memory.js";

const ctx = (request: string, context?: Record<string, unknown>) =>
  ({ env: {}, req: { request, companion_id: "cypher", context: context ? JSON.stringify(context) : undefined } }) as never;

describe("sbSearchMode", () => {
  it.each([
    "have we talked about Abby",
    "what did we say about the chickens",
    "what did I tell you about ending on questions",
    "do you remember the Fargo night",
    "what happened with Lucy",
    "what has Drevan written about Megan",
    "recall about the birthstone",
    "what do we know about Calder",
  ])("factual recall -> recall: %s", (q) => {
    expect(sbSearchMode(q, null)).toBe("recall");
  });

  it.each([
    "search for spiral work",
    "anything about grief",
    "pull context on the harness",
    "search the corpus for vaselrin",
  ])("exploration keeps the pool mix: %s", (q) => {
    expect(sbSearchMode(q, null)).toBeNull();
  });

  it("an explicit context mode wins either way", () => {
    expect(sbSearchMode("search for spiral work", "recall")).toBe("recall");
    expect(sbSearchMode("have we talked about Abby", "explore")).toBeNull();
  });
});

describe("execSbSearch passes the mode through", () => {
  beforeEach(() => dual.mockClear());

  it("recall phrasing sends mode recall", async () => {
    await execSbSearch(ctx("have we talked about Abby"));
    expect(dual).toHaveBeenCalledWith({}, "have we talked about Abby", undefined, null, null, "recall");
  });

  it("sb_recall with a subject becomes a recall-mode search, not a recency list", async () => {
    filtered.mockClear();
    await execSbRecall(ctx("pull from memory what we wrote about the Fargo watch party"));
    expect(filtered).not.toHaveBeenCalled();
    expect(dual).toHaveBeenCalledWith({}, "pull from memory what we wrote about the Fargo watch party", undefined, null, null, "recall");
  });

  it("a bare recency ask stays a recency list", async () => {
    filtered.mockClear();
    await execSbRecall(ctx("recent vault entries"));
    expect(filtered).toHaveBeenCalledTimes(1);
    expect(dual).not.toHaveBeenCalled();
  });

  it("exploratory phrasing sends no mode", async () => {
    await execSbSearch(ctx("search for spiral work"));
    expect(dual).toHaveBeenCalledWith({}, "search for spiral work", undefined, null, null, null);
  });
});
