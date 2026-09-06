// Repeat breaker (2026-09-05): Drevan issued the byte-identical retrieval request
// ("search vault for vevan vethmerin") 161 times in one Hermes agent turn -- Hermes's own loop
// guard only tracks a hard-coded set of built-in idempotent tools and needs identical RESULTS,
// which our search never produces (the novelty pool rotates). This breaker is keyed on the
// REQUEST and lives entirely on the Librarian side, governing retrieval-family patterns only.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isRetrievalPattern,
  repeatKey,
  checkAndCount,
  breakerResponse,
  REPEAT_WINDOW_SECONDS,
  REPEAT_LIMIT,
} from "../librarian/repeat-breaker.js";
import { execSbSearch } from "../librarian/executors/memory.js";

vi.mock("../librarian/executors/memory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/executors/memory.js")>();
  return {
    ...actual,
    execSbSearch: vi.fn(async () => ({ data: "mock vault result", meta: { operation: "sb_search" } })),
  };
});

import { LibrarianRouter } from "../librarian/router.js";
import type { Env } from "../types.js";
import type { LibrarianRequest } from "../librarian/executors/types.js";

// ── In-memory KV mock ───────────────────────────────────────────────────────
class FakeKV {
  private store = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === "json") return JSON.parse(raw);
    return raw;
  }
  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function makeEnv(kv: FakeKV, overrides: Partial<Env> = {}): Env {
  return {
    LIBRARIAN_KV: kv as unknown as Env["LIBRARIAN_KV"],
    ...overrides,
  } as unknown as Env;
}

describe("isRetrievalPattern", () => {
  it("is true for sb_search (Second-Brain vector retrieval)", () => {
    expect(isRetrievalPattern("sb_search")).toBe(true);
  });

  it("is true for the other vault/vector read keys", () => {
    for (const key of [
      "sb_search_by_tags", "sb_file_chunks", "sb_recall", "sb_list", "sb_read",
      "sb_recent_patterns", "book_read", "notes_recall_meaning",
    ]) {
      expect(isRetrievalPattern(key), key).toBe(true);
    }
  });

  it("is false for the session-open lifecycle key", () => {
    expect(isRetrievalPattern("session_open")).toBe(false);
  });

  it("is false for a write key", () => {
    expect(isRetrievalPattern("sb_save_note")).toBe(false);
  });

  it("is false for cheap Halseth-state reads that are legitimately polled", () => {
    for (const key of ["get_tasks", "feelings_read", "journal_search", "get_front"]) {
      expect(isRetrievalPattern(key), key).toBe(false);
    }
  });
});

describe("repeatKey", () => {
  it("normalizes case, whitespace, and trailing punctuation to the same key", async () => {
    const a = await repeatKey("drevan", "Search vault for vevan vethmerin!");
    const b = await repeatKey("drevan", "  search   vault for vevan vethmerin  ");
    const c = await repeatKey("drevan", "search vault for vevan vethmerin.");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("differs per companion for the identical request text", async () => {
    const drevan = await repeatKey("drevan", "search vault for vevan vethmerin");
    const cypher = await repeatKey("cypher", "search vault for vevan vethmerin");
    expect(drevan).not.toBe(cypher);
  });

  it("differs for different request text", async () => {
    const a = await repeatKey("drevan", "search vault for vevan vethmerin");
    const b = await repeatKey("drevan", "search vault for something else");
    expect(a).not.toBe(b);
  });
});

describe("checkAndCount", () => {
  it("returns blocked=false for the 1st-3rd hits and blocked=true on the 4th", async () => {
    const kv = new FakeKV();
    const key = "loop:drevan:testhash";
    const r1 = await checkAndCount(kv as unknown as KVNamespace, key);
    const r2 = await checkAndCount(kv as unknown as KVNamespace, key);
    const r3 = await checkAndCount(kv as unknown as KVNamespace, key);
    const r4 = await checkAndCount(kv as unknown as KVNamespace, key);
    expect(r1).toEqual({ repeats: 1, blocked: false });
    expect(r2).toEqual({ repeats: 2, blocked: false });
    expect(r3).toEqual({ repeats: 3, blocked: false });
    expect(r4).toEqual({ repeats: 4, blocked: true });
  });

  it("fails open (blocked=false) when KV throws", async () => {
    const kv = {
      get: vi.fn(async () => { throw new Error("KV unavailable"); }),
      put: vi.fn(async () => { throw new Error("KV unavailable"); }),
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await checkAndCount(kv as unknown as KVNamespace, "loop:drevan:x");
    expect(result).toEqual({ repeats: 0, blocked: false });
    vi.restoreAllMocks();
  });
});

describe("breakerResponse shape", () => {
  it("returns a witness response carrying loop_guard metadata", () => {
    const r = breakerResponse(4, "sb_search");
    expect(r.response_key).toBe("witness");
    expect(typeof r.witness).toBe("string");
    expect(r.witness as string).toContain("4 times");
    expect(r.loop_guard).toEqual({ repeats: 4, pattern: "sb_search", window_seconds: REPEAT_WINDOW_SECONDS });
  });
});

describe("constants", () => {
  it("REPEAT_LIMIT is 4 and REPEAT_WINDOW_SECONDS is 600", () => {
    expect(REPEAT_LIMIT).toBe(4);
    expect(REPEAT_WINDOW_SECONDS).toBe(600);
  });
});

describe("LibrarianRouter.route repeat breaker integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const REQUEST = "search vault for vevan vethmerin";

  it("executes sb_search on the 1st-3rd identical requests", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    const router = new LibrarianRouter(env);
    const req: LibrarianRequest = { request: REQUEST, companion_id: "drevan" } as LibrarianRequest;

    await router.route(req);
    await router.route(req);
    await router.route(req);

    expect(execSbSearch).toHaveBeenCalledTimes(3);
  });

  it("the 4th identical request is answered by the breaker and the executor is not called again", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    const router = new LibrarianRouter(env);
    const req: LibrarianRequest = { request: REQUEST, companion_id: "drevan" } as LibrarianRequest;

    await router.route(req);
    await router.route(req);
    await router.route(req);
    const fourth = await router.route(req);

    expect(execSbSearch).toHaveBeenCalledTimes(3);
    expect(fourth.response_key).toBe("witness");
    expect((fourth.loop_guard as { repeats: number }).repeats).toBe(4);
  });

  it("a non-retrieval pattern repeated 6 times never touches KV", async () => {
    const kv = new FakeKV();
    const getSpy = vi.spyOn(kv, "get");
    const putSpy = vi.spyOn(kv, "put");
    const env = makeEnv(kv);
    const router = new LibrarianRouter(env);
    // "my tasks" fast-paths to get_tasks -- a Halseth-state read excluded from the breaker.
    // No env.DB is provided, so the underlying executor is expected to reject; the point of
    // this test is solely that the repeat-breaker's own KV get/put are never reached for a
    // non-retrieval pattern, regardless of what the executor itself does downstream.
    const req: LibrarianRequest = { request: "my tasks", companion_id: "drevan" } as LibrarianRequest;

    for (let i = 0; i < 6; i++) {
      await router.route(req).catch(() => undefined);
    }

    expect(getSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
  });
});
