// Owner pronoun rule coverage (2026-09-24).
//
// Drevan reported background synthesis narratives calling Crash (Raziel) "she" -- confirmed in
// prod (`synthesis_summary` rows: "she hurt, she curled in"). Only the live Discord prompt carried
// a pronoun rule; no background LLM writer did. This asserts:
//   1. the shared rule module is idempotent (never doubles on repeated wrapping);
//   2. the synthesis clerk's `complete()` chokepoint sends it on every call;
//   3. every other known prose writer that calls a model directly (not through `complete()`)
//      references the rule at its call site -- a grep-based durable guard so a future writer
//      added the same way doesn't quietly ship without it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_PRONOUN_RULE, withOwnerPronounRule } from "../pronoun-rule.js";
import { complete } from "../synthesis/deepseek.js";
import type { Env } from "../types.js";

describe("OWNER_PRONOUN_RULE / withOwnerPronounRule", () => {
  it("states he/him or they/them, never she/her, for Raziel", () => {
    expect(OWNER_PRONOUN_RULE).toMatch(/he\/him/);
    expect(OWNER_PRONOUN_RULE).toMatch(/they\/them/);
    expect(OWNER_PRONOUN_RULE).toMatch(/NEVER she\/her/);
  });

  it("appends the rule to a plain system prompt", () => {
    const out = withOwnerPronounRule("You are a synthesis clerk.");
    expect(out).toContain("You are a synthesis clerk.");
    expect(out).toContain(OWNER_PRONOUN_RULE);
  });

  it("is idempotent -- wrapping an already-wrapped prompt does not double the rule", () => {
    const once = withOwnerPronounRule("You are a synthesis clerk.");
    const twice = withOwnerPronounRule(once);
    expect(twice).toBe(once);
    const occurrences = twice.split(OWNER_PRONOUN_RULE).length - 1;
    expect(occurrences).toBe(1);
  });

  it("handles an empty system prompt without a leading blank line", () => {
    expect(withOwnerPronounRule("")).toBe(OWNER_PRONOUN_RULE);
  });
});

describe("synthesis complete() carries the pronoun rule", () => {
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

  it("appends the rule to whatever system prompt the caller passed", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "a summary" } }] });
    await complete("You are a synthesis clerk.", "user prompt", env);

    const sent = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body));
    const systemMsg = sent.messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toContain("You are a synthesis clerk.");
    expect(systemMsg.content).toContain(OWNER_PRONOUN_RULE);
  });

  it("does not double the rule if a caller's own systemPrompt already includes it", async () => {
    const fn = mockFetch({ choices: [{ message: { content: "a summary" } }] });
    const already = withOwnerPronounRule("You are a synthesis clerk.");
    await complete(already, "user prompt", env);

    const sent = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body));
    const systemMsg = sent.messages.find((m: { role: string }) => m.role === "system");
    const occurrences = (systemMsg.content as string).split(OWNER_PRONOUN_RULE).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("prose writers outside complete() reference the pronoun rule", () => {
  // These four call a model directly (Anthropic or a raw DeepSeek fetch) rather than through the
  // synthesis clerk's complete(). Each produces prose that can name Raziel (a witness line, a
  // triage reason, a shift rationale, a drift reasoning sentence), so each must import and use
  // withOwnerPronounRule at its call site. Classifier-only callers (tag-classifier, the Librarian
  // router classifier) are intentionally excluded -- they return labels/numbers, never prose.
  const root = join(import.meta.dirname, "..");
  const mustReference = [
    "drift/pass.ts",
    "clearing/pass.ts",
    "soma/emergent.ts",
    "synthesis/jobs/basin-drift-check.ts",
  ];

  it.each(mustReference)("%s imports and calls withOwnerPronounRule", (relPath) => {
    const src = readFileSync(join(root, relPath), "utf8");
    expect(src).toMatch(/import\s*\{\s*withOwnerPronounRule\s*\}\s*from\s*["'][^"']+pronoun-rule\.js["']/);
    expect(src).toMatch(/withOwnerPronounRule\(/);
  });
});
