/**
 * MCP ask_librarian forwards `surface` (2026-09-14).
 *
 * The Discord bots have sent `surface: "discord:<id>"` on every /librarian/mcp call since mig 0113,
 * and the tool schema silently dropped it (zod strips unknown keys). Verified in prod: zero session
 * rows ever carried a Discord surface, so per-(companion, surface) dedup never applied to the bots,
 * every boot and idle cycle opened a fresh row, and the Claude.ai orient listed bot rows as sessions
 * the companion "never closed". Source-reading, like the sibling MCP tests: the guarantee is that
 * the key exists in the schema AND is copied onto the LibrarianRequest with the same trim/cap rule
 * as the HTTP door (index.ts).
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("ask_librarian surface forwarding", () => {
  it("declares `surface` in the tool schema and forwards it trimmed and capped, never defaulted", async () => {
    const src = await readFile(resolve(__dirname, "../librarian/mcp.ts"), "utf8");
    expect(src).toMatch(/surface:\s+z\.string\(\)\.max\(200\)\.optional\(\)/);
    expect(src).toMatch(/args\.surface\.trim\(\)\.slice\(0, 200\)/);
    // Never defaulted: a missing surface must stay missing (index.ts rule), so the spread is conditional.
    expect(src).toMatch(/typeof args\.surface === "string" && args\.surface\.trim\(\)\s*\?\s*\{ surface:/);
    expect(src).not.toMatch(/surface:\s*args\.surface\s*\?\?/);
  });

  it("the HTTP door applies the same rule (one surface contract, two doors)", async () => {
    const src = await readFile(resolve(__dirname, "../librarian/index.ts"), "utf8");
    expect(src).toMatch(/b\.surface\.trim\(\)\.slice\(0, 200\)/);
  });
});
