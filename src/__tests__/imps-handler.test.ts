// halseth/src/__tests__/imps-handler.test.ts
import { describe, test, expect } from "vitest";
import { validateActivation } from "../handlers/imps.js";

describe("validateActivation", () => {
  test("valid imp + companion", () => { expect(validateActivation("nimbus", "cypher")).toBeNull(); });
  test("bad imp", () => { expect(validateActivation("sparkle", "cypher")).toMatch(/imp/i); });
  test("bad companion", () => { expect(validateActivation("iris", "raziel")).toMatch(/companion/i); });
});
