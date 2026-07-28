// Delisted-model + reasoning-headroom guard for Halseth's two DeepSeek callers (2026-07-28).
//
// Halseth calls DeepSeek in exactly two places: the Librarian classifier (highest-frequency
// caller in the suite -- every non-fast-path companion request) and the synthesis clerk. Both
// were pinned to `deepseek-chat`, which DeepSeek has DELISTED: GET /v1/models returns exactly
// deepseek-v4-pro and deepseek-v4-flash. The alias still answers, so both kept working -- which
// is the whole problem. The autonomous worker sat on the same alias and started 400ing
// intermittently on 2026-07-26; ~37% of runs failed for a day before anyone noticed.
//
// Both live models are REASONING models: reasoning tokens are billed against `max_tokens` and
// emitted BEFORE any content, so a naive model swap on the classifier (max_tokens: 20) would
// have returned "" for every classify and silently routed every request to __offline__.
// Measured on flash with the classifier prompt shape: 60-117 reasoning tokens, 1.6-2.0s.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK_DEFAULT_MODEL, REASONING_HEADROOM, contentBudget, complete } from "../synthesis/deepseek.js";
import type { Env } from "../types.js";

const DELISTED = ["deepseek-chat", "deepseek-reasoner"];

describe("DeepSeek model + budget constants", () => {
  it("points at a model that GET /v1/models actually lists", () => {
    expect(DELISTED).not.toContain(DEEPSEEK_DEFAULT_MODEL);
    expect(DEEPSEEK_DEFAULT_MODEL).toMatch(/^deepseek-v4-(pro|flash)$/);
  });

  it("uses the cheap tier for clerk work, not the deep-thinking tier", () => {
    // Synthesis and classification are assembly, not thinking. Pro would be a pure cost add.
    expect(DEEPSEEK_DEFAULT_MODEL).toBe("deepseek-v4-flash");
  });

  it("adds headroom well above the measured reasoning burn", () => {
    expect(contentBudget(20)).toBe(20 + REASONING_HEADROOM);
    expect(REASONING_HEADROOM).toBeGreaterThanOrEqual(1000);
  });

  it("preserves the relative size of different content ceilings", () => {
    expect(contentBudget(800) - contentBudget(20)).toBe(780);
  });
});

describe("synthesis complete()", () => {
  afterEach(() => vi.restoreAllMocks());

  const env = { DEEPSEEK_API_KEY: "test-key" } as unknown as Env;

  function mockFetch(body: unknown) {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("sends the content budget PLUS headroom, and a live model id", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "a summary" } }] });
    await complete("sys", "user", env);

    const sent = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body));
    expect(sent.model).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(sent.max_tokens).toBe(contentBudget(800));
  });

  it("returns the content when the model actually answered", async () => {
    mockFetch({ choices: [{ message: { content: "a summary" } }] });
    await expect(complete("sys", "user", env)).resolves.toBe("a summary");
  });

  it("returns null -- not an empty string -- when reasoning ate the whole budget", async () => {
    // An empty string would be written as a real summary. Callers must see a failed call.
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    await expect(complete("sys", "user", env)).resolves.toBeNull();
  });

  it("treats whitespace-only content as empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ choices: [{ message: { content: "  \n " }, finish_reason: "length" }] });
    await expect(complete("sys", "user", env)).resolves.toBeNull();
  });

  it("logs the knob to raise, so the fix is discoverable from the log alone", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    await complete("sys", "user", env);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("REASONING_HEADROOM"));
  });
});

describe("no source file ships a delisted DeepSeek model id", () => {
  // The durable half. Five separate places in the suite defaulted to `deepseek-chat` and every
  // one of them "worked" until it didn't; the second, third and fourth were found by grepping
  // the shape after fixing the first. This is that grep, run in CI.
  it("finds no delisted model id in any wire payload", () => {
    const root = join(import.meta.dirname, "..");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith(".ts")) continue;
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          // Only flag a model id being SENT (`model: "deepseek-chat"`), not prose about it --
          // the constants above are documented with the history and must stay readable.
          if (/model:\s*["'](deepseek-chat|deepseek-reasoner)["']/.test(line)) {
            offenders.push(`${name}:${i + 1}`);
          }
        });
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
