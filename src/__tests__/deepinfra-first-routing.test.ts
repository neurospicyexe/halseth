// DeepInfra-first routing for every Halseth DeepSeek-model caller (2026-09-26).
//
// Raziel's rule: ALL DeepSeek-model inference goes through DeepInfra (same weights,
// deepseek-ai/DeepSeek-V4-Flash-0731). Direct DeepSeek keeps ~$10 as an EMERGENCY lane: used
// only when DeepInfra fails, and loudly. basin-drift-check.ts called api.deepseek.com directly
// with no DeepInfra lane and 402'd on every session close at a $0 balance -- these tests pin
// the order, the fallback, and the "no DeepSeek call when DeepInfra succeeds" invariant.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  complete, vendors, vendorFailover, FELL_BACK_TAG, contentBudget,
} from "../synthesis/deepseek.js";
import { runBasinDriftCheck } from "../synthesis/jobs/basin-drift-check.js";
import type { Env } from "../types.js";

const DI = "https://api.deepinfra.com/v1/openai/chat/completions";
const DS = "https://api.deepseek.com/chat/completions";

const both = { DEEPINFRA_API_KEY: "di-key", DEEPSEEK_API_KEY: "ds-key" } as unknown as Env;

function ok(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}
function fail(status: number): Response {
  return new Response("nope", { status });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = { mock: { calls: any[][] } };
function urls(fn: AnyMock): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}
function bodyAt(fn: AnyMock, i: number): { max_tokens: number; temperature: number } {
  return JSON.parse(String((fn.mock.calls[i]![1] as RequestInit).body));
}
function warnLines(): string[] {
  return (warn.mock.calls as unknown[][]).map((c) => String(c[0]));
}

let warn: AnyMock & { mockClear: () => void };
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {}) as unknown as typeof warn;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("vendors()", () => {
  it("puts DeepInfra first and DeepSeek second when both keys exist", () => {
    expect(vendors(both).map((v) => v.label)).toEqual(["DeepInfra", "DeepSeek"]);
    expect(vendors(both)[0]!.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });
  it("is DeepSeek-only when DeepInfra is absent, DeepInfra-only when DeepSeek is absent", () => {
    expect(vendors({ DEEPSEEK_API_KEY: "k" } as unknown as Env).map((v) => v.label)).toEqual(["DeepSeek"]);
    expect(vendors({ DEEPINFRA_API_KEY: "k" } as unknown as Env).map((v) => v.label)).toEqual(["DeepInfra"]);
  });
});

describe("complete() vendor chain", () => {
  it("never calls DeepSeek when DeepInfra answers", async () => {
    const fn = vi.fn(async () => ok("fine"));
    vi.stubGlobal("fetch", fn);
    await expect(complete("s", "u", both)).resolves.toBe("fine");
    expect(urls(fn)).toEqual([DI]);
    expect(warnLines().some((l) => l.includes(FELL_BACK_TAG))).toBe(false);
  });

  it("falls back to DeepSeek on a DeepInfra 5xx/402 and logs the FELL BACK line", async () => {
    for (const status of [402, 429, 503]) {
      warn.mockClear();
      const fn = vi.fn().mockResolvedValueOnce(fail(status)).mockResolvedValueOnce(ok("rescued"));
      vi.stubGlobal("fetch", fn);
      await expect(complete("s", "u", both, { caller: "t" })).resolves.toBe("rescued");
      expect(urls(fn)).toEqual([DI, DS]);
      const line = warnLines().find((l) => l.includes(FELL_BACK_TAG));
      expect(line).toContain(`HTTP ${status}`);
      expect(line).toContain("caller=t");
    }
  });

  it("falls back on a DeepInfra network error", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok("rescued"));
    vi.stubGlobal("fetch", fn);
    await expect(complete("s", "u", both)).resolves.toBe("rescued");
    expect(urls(fn)).toEqual([DI, DS]);
  });

  it("does NOT spend the emergency lane on a deterministic 400", async () => {
    const fn = vi.fn(async () => fail(400));
    vi.stubGlobal("fetch", fn);
    await expect(complete("s", "u", both)).resolves.toBeNull();
    expect(urls(fn)).toEqual([DI]);
  });

  it("does NOT spend the emergency lane on a reasoning-starved empty answer (same weights repeat it)", async () => {
    const fn = vi.fn(async () => ok(""));
    vi.stubGlobal("fetch", fn);
    await expect(complete("s", "u", both)).resolves.toBeNull();
    expect(urls(fn)).toEqual([DI]);
  });

  it("honors contentTokens/temperature and keeps the 800/0.3 defaults", async () => {
    const fn = vi.fn(async () => ok("x"));
    vi.stubGlobal("fetch", fn);
    await complete("s", "u", both, { contentTokens: 120, temperature: 0 });
    await complete("s", "u", both);
    const b0 = bodyAt(fn, 0);
    const b1 = bodyAt(fn, 1);
    expect([b0.max_tokens, b0.temperature]).toEqual([contentBudget(120), 0]);
    expect([b1.max_tokens, b1.temperature]).toEqual([contentBudget(800), 0.3]);
  });

  it("vendorFailover is the shared rule (400 fatal, 401/402/403/429/5xx fail over)", () => {
    expect(vendorFailover(400)).toBe(false);
    for (const s of [401, 402, 403, 429, 500, 503]) expect(vendorFailover(s)).toBe(true);
  });
});

describe("basin-drift-check rides the DeepInfra-first chain", () => {
  function driftEnv(keys: Record<string, string>): Env {
    const mk = (sql: string) => ({
      bind: () => mk(sql),
      all: async () => ({
        results: sql.includes("wm_session_handoffs")
          ? [{ title: "t", summary: "a summary", state_hint: null, facet: null, created_at: "2026-09-26T00:00:00Z" }]
          : [],
      }),
      first: async () => {
        if (sql.includes("blocks_analyzed=")) return { id: "owner-1", drift_type: "stable" };
        if (sql.includes("wm_identity_anchor_snapshot")) return { anchor_summary: "blade", constraints_summary: null, baseline_shift_at: null };
        if (sql.includes("companion_state")) return { soma_float_1: 0.5, soma_float_2: 0.5, soma_float_3: 0.5, motion_state: "at_rest" };
        return null;
      },
      run: async () => ({ meta: { changes: 1 } }),
    });
    return { ...keys, DB: { prepare: (sql: string) => mk(sql) } } as unknown as Env;
  }
  const verdict = JSON.stringify({ drift_type: "stable", drift_score: 0.1, worst_basin: null, reasoning: "held" });

  it("calls DeepInfra only, at the classifier budget, when DeepInfra answers", async () => {
    const fn = vi.fn(async () => ok(verdict));
    vi.stubGlobal("fetch", fn);
    await runBasinDriftCheck("cypher", driftEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" }));
    expect(urls(fn)).toEqual([DI]);
    const body = bodyAt(fn, 0);
    expect(body.max_tokens).toBe(contentBudget(120));
    expect(body.temperature).toBe(0);
  });

  it("runs with ONLY a DeepInfra key (the gate used to demand DEEPSEEK_API_KEY)", async () => {
    const fn = vi.fn(async () => ok(verdict));
    vi.stubGlobal("fetch", fn);
    await runBasinDriftCheck("cypher", driftEnv({ DEEPINFRA_API_KEY: "di" }));
    expect(urls(fn)).toEqual([DI]);
  });

  it("falls back to DeepSeek on a DeepInfra 503, and throws when both lanes fail", async () => {
    const fn = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok(verdict));
    vi.stubGlobal("fetch", fn);
    await runBasinDriftCheck("cypher", driftEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" }));
    expect(urls(fn)).toEqual([DI, DS]);

    vi.stubGlobal("fetch", vi.fn(async () => fail(402)));
    await expect(
      runBasinDriftCheck("cypher", driftEnv({ DEEPINFRA_API_KEY: "di", DEEPSEEK_API_KEY: "ds" })),
    ).rejects.toThrow(/every vendor/);
  });
});
