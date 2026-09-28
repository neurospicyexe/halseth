// A claude-ai surface counts as Raziel only from an OAuth caller (surface.ts, 2026-09-28).
// Measured: Drevan's Hermes agent opened `claude-ai:<thread>` in his heartbeat minute, which
// readOwnerLastSeen read as Raziel present, the input to esc_silence (the alert to Blue).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { surfaceForAuth } from "../librarian/surface.js";

describe("surfaceForAuth", () => {
  it("a static-secret caller claiming claude-ai is moved to an agent lane", () => {
    expect(surfaceForAuth("claude-ai:<thread>", "static")).toBe("agent:<thread>");
    expect(surfaceForAuth("claude-ai:drevan", "static")).toBe("agent:drevan");
    expect(surfaceForAuth("Claude-AI:gaia", "static")).toBe("agent:gaia");
  });

  it("the agent lane falls outside the owner-activity prefix range", () => {
    const s = surfaceForAuth("claude-ai:drevan", "static")!;
    // readOwnerLastSeen: surface >= 'claude' AND surface < 'claudf'
    expect(s >= "claude" && s < "claudf").toBe(false);
  });

  it("an OAuth caller (Claude.ai) keeps its claude-ai surface", () => {
    expect(surfaceForAuth("claude-ai:drevan", "oauth")).toBe("claude-ai:drevan");
  });

  it("every other surface is untouched, and a missing one stays missing", () => {
    expect(surfaceForAuth("discord:123", "static")).toBe("discord:123");
    expect(surfaceForAuth("claude-code:c-dev-bbh", "static")).toBe("claude-code:c-dev-bbh");
    expect(surfaceForAuth(undefined, "static")).toBeUndefined();
  });
});

describe("both doors apply it", () => {
  it("the MCP door marks OAuth and passes the kind to the surface rule", async () => {
    const src = await readFile(resolve(__dirname, "../librarian/mcp.ts"), "utf8");
    expect(src).toMatch(/let authKind: LibrarianAuthKind = "static"/);
    expect(src).toMatch(/boundCompanion = row\.companion_id \?\? null;\s*authKind = "oauth";/);
    expect(src).toMatch(/surfaceForAuth\(args\.surface\.trim\(\)\.slice\(0, 200\), authKind\)/);
  });

  it("the HTTP door, static-only, applies the static rule", async () => {
    const src = await readFile(resolve(__dirname, "../librarian/index.ts"), "utf8");
    expect(src).toMatch(/surfaceForAuth\(b\.surface\.trim\(\)\.slice\(0, 200\), "static"\)/);
  });
});
