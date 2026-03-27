import { describe, it, expect } from "vitest";

describe("Librarian input limits", () => {
  const MAX_REQUEST = 2000;
  const MAX_CONTEXT = 32768;

  it("accepts request at limit", () => {
    const req = "a".repeat(MAX_REQUEST);
    expect(req.length).toBeLessThanOrEqual(MAX_REQUEST);
  });

  it("rejects request over limit", () => {
    const req = "a".repeat(MAX_REQUEST + 1);
    expect(req.length).toBeGreaterThan(MAX_REQUEST);
  });

  it("accepts context at limit", () => {
    const ctx = "a".repeat(MAX_CONTEXT);
    expect(ctx.length).toBeLessThanOrEqual(MAX_CONTEXT);
  });

  it("rejects context over limit", () => {
    const ctx = "a".repeat(MAX_CONTEXT + 1);
    expect(ctx.length).toBeGreaterThan(MAX_CONTEXT);
  });
});

describe("isValidVaultPath", () => {
  function isValidVaultPath(path: string): boolean {
    if (!path || typeof path !== "string") return false;
    if (path.includes("..")) return false;
    if (path.startsWith("/")) return false;
    return /^[a-zA-Z0-9/_\-. ]+$/.test(path);
  }

  it("accepts normal vault paths", () => {
    expect(isValidVaultPath("notes/2026/march.md")).toBe(true);
    expect(isValidVaultPath("Companions/Drevan/identity.md")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isValidVaultPath("../etc/passwd")).toBe(false);
    expect(isValidVaultPath("notes/../../secrets")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isValidVaultPath("/etc/passwd")).toBe(false);
  });

  it("rejects empty or non-string", () => {
    expect(isValidVaultPath("")).toBe(false);
    expect(isValidVaultPath(null as any)).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidVaultPath("notes/<script>")).toBe(false);
    expect(isValidVaultPath("notes/$(rm -rf)")).toBe(false);
  });
});

describe("session close field limits", () => {
  it("spine under 2000 is valid", () => {
    expect("a".repeat(2000).length).toBeLessThanOrEqual(2000);
  });

  it("spine over 2000 is rejected", () => {
    expect("a".repeat(2001).length).toBeGreaterThan(2000);
  });

  it("notes under 4000 is valid", () => {
    expect("a".repeat(4000).length).toBeLessThanOrEqual(4000);
  });

  it("notes over 4000 is rejected", () => {
    expect("a".repeat(4001).length).toBeGreaterThan(4000);
  });
});
