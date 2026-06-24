// src/__tests__/creatures-handler.test.ts
import { describe, test, expect } from "vitest";
// Validation is pure; exported for testability.
import { validateInteract } from "../handlers/creatures.js";

describe("validateInteract", () => {
  test("companion may feed", () => {
    expect(validateInteract("cypher", "feed")).toBeNull();
  });
  test("sol may only appear", () => {
    expect(validateInteract("sol", "appear")).toBeNull();
    expect(validateInteract("sol", "feed")).toMatch(/sol/i);
  });
  test("companion may not 'appear'", () => {
    expect(validateInteract("cypher", "appear")).toMatch(/action/i);
  });
  test("unknown actor rejected", () => {
    expect(validateInteract("stranger", "feed")).toMatch(/actor/i);
  });
});
