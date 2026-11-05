// An outage of Second Brain must render as an explicit degraded line in orient, never as an empty block.
// callTool returns null for every FAILURE; an honest empty answer is a non-null string. recallOrDegrade
// turns that distinction into a flag the orient executors render and log.

import { describe, it, expect, vi, afterEach } from "vitest";
import { recallOrDegrade, secondBrainConfigured, semanticSearch } from "../librarian/backends/second-brain.js";
import { recallDegradedLine, ragBlock } from "../librarian/response/orient-blocks.js";
import type { Env } from "../types.js";

const configured = { SECOND_BRAIN_WEBHOOK_URL: "https://sb.example.test", SECOND_BRAIN_TOKEN: "t" } as unknown as Env;
const unconfigured = {} as unknown as Env;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("recallOrDegrade", () => {
  it("a null from a configured Second Brain is degraded and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await recallOrDegrade(configured, "vault excerpts", async () => null);
    expect(r).toEqual({ value: null, degraded: true });
    expect(warn.mock.calls[0][0]).toContain("recall degraded: Second Brain unreachable");
    expect(warn.mock.calls[0][0]).toContain("vault excerpts");
  });

  it("a thrown read is degraded too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await recallOrDegrade(configured, "vault history", async () => { throw new Error("boom"); });
    expect(r.degraded).toBe(true);
  });

  it("an honest empty answer is NOT degraded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await recallOrDegrade(configured, "vault excerpts", async () => '{"chunks":[]}');
    expect(r).toEqual({ value: '{"chunks":[]}', degraded: false });
    expect(warn).not.toHaveBeenCalled();
    expect(ragBlock(r.value)).toBe("");
  });

  it("an unconfigured Second Brain is not an outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(secondBrainConfigured(unconfigured)).toBe(false);
    const r = await recallOrDegrade(unconfigured, "vault excerpts", async () => null);
    expect(r.degraded).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("end to end: a 503 from Second Brain through semanticSearch is degraded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const r = await recallOrDegrade(configured, "vault excerpts", () => semanticSearch(configured, "q"));
    expect(r.degraded).toBe(true);
  });

  it("the rendered line names Second Brain and the block", () => {
    const line = recallDegradedLine("vault excerpts");
    expect(line).toContain("(recall degraded: Second Brain unreachable");
    expect(line).toContain("vault excerpts");
  });
});
