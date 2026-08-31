// Librarian classifier vendor failover (2026-08-28).
//
// DeepSeek balance hit $0 and every non-fast-path companion request started returning
// { error: "cognitive_routing_offline" } -- the classifier (Tier 2) was a single point of
// failure behind every fast-path miss. This mirrors the autonomous-worker's DeepSeek/DeepInfra
// failover shape (packages/autonomous-worker/src/deepseek.ts): on 401/402/403/429/5xx/network
// error from DeepSeek, retry ONCE against DeepInfra (OpenAI-compatible) if DEEPINFRA_API_KEY is
// set. A 400 is deterministic (the payload itself is malformed) and stays fatal on every vendor.
// No secret set = unchanged behavior.

import { describe, it, expect, vi, afterEach } from "vitest";
import { LibrarianRouter, vendorFailover } from "../librarian/router.js";
import type { Env } from "../types.js";
import type { LibrarianRequest } from "../librarian/executors/types.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LIBRARIAN_KV: {
      get: vi.fn(async (key: string) => {
        if (key === "_index") return "";
        if (key === "_hints") return "";
        return null;
      }),
    },
    DEEPSEEK_API_KEY: "deepseek-test-key",
    // AI / VECTORIZE deliberately absent -- Tier 2a (edge-native routing) is skipped, so
    // classify() falls straight through to the DeepSeek/DeepInfra path under test.
    ...overrides,
  } as unknown as Env;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const UNMATCHED_REQUEST = "banana zoo request that matches no fast path xyz789";

describe("vendorFailover status classifier", () => {
  it("fails over on auth/quota/rate-limit/server-error statuses", () => {
    expect(vendorFailover(401)).toBe(true);
    expect(vendorFailover(402)).toBe(true);
    expect(vendorFailover(403)).toBe(true);
    expect(vendorFailover(429)).toBe(true);
    expect(vendorFailover(500)).toBe(true);
    expect(vendorFailover(503)).toBe(true);
  });

  it("does not fail over on a deterministic payload error", () => {
    expect(vendorFailover(400)).toBe(false);
  });
});

describe("LibrarianRouter classifier failover", () => {
  afterEach(() => vi.restoreAllMocks());

  it("degrades to DeepSeek and still classifies when DeepInfra returns 402 (empty balance)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(402, { error: { message: "Insufficient Balance" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "unknown" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = makeEnv({ DEEPINFRA_API_KEY: "deepinfra-test-key" });
    const router = new LibrarianRouter(env);
    const result = await router.route({ request: UNMATCHED_REQUEST, companion_id: "cypher" } as LibrarianRequest);

    // The whole point: no cognitive_routing_offline surfaced to the companion.
    expect(result.error).not.toBe("cognitive_routing_offline");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0]![0] as string;
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    // Vendor order since 2026-08-31: DeepInfra PRIMARY, DeepSeek-direct fallback.
    expect(firstUrl).toContain("api.deepinfra.com/v1/openai");
    expect(secondUrl).toContain("api.deepseek.com");

    const firstBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(firstBody.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    const firstHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer deepinfra-test-key");
  });

  it("logs a warning on failover", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(402, { error: { message: "Insufficient Balance" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "unknown" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = makeEnv({ DEEPINFRA_API_KEY: "deepinfra-test-key" });
    const router = new LibrarianRouter(env);
    await router.route({ request: UNMATCHED_REQUEST, companion_id: "cypher" } as LibrarianRequest);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failing over to DeepSeek"));
  });

  it("without DEEPINFRA_API_KEY set, DeepSeek is the single vendor and its failure degrades as before", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(402, { error: { message: "Insufficient Balance" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = makeEnv(); // no DEEPINFRA_API_KEY
    const router = new LibrarianRouter(env);
    const result = await router.route({ request: UNMATCHED_REQUEST, companion_id: "cypher" } as LibrarianRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("cognitive_routing_offline");
  });

  it("a 400 (deterministic payload error) stays fatal and never reaches the fallback vendor", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad request" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = makeEnv({ DEEPINFRA_API_KEY: "deepinfra-test-key" });
    const router = new LibrarianRouter(env);
    const result = await router.route({ request: UNMATCHED_REQUEST, companion_id: "cypher" } as LibrarianRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("cognitive_routing_offline");
  });

  it("fast-path requests never touch either vendor", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = makeEnv({ DEEPINFRA_API_KEY: "deepinfra-test-key" });
    const router = new LibrarianRouter(env);
    // "log a feeling" is a FAST_PATH_PATTERNS trigger (feeling_log) -- Tier 1 must short-circuit
    // before classify() ever runs. The executor itself may fail against this bare fake env
    // (no DB binding); only the routing tier is under test here.
    try {
      await router.route({ request: "log a feeling", companion_id: "cypher" } as LibrarianRequest);
    } catch {
      // executor-level failure against a fake env is expected and irrelevant to this assertion
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
