import { describe, it, expect, vi, beforeEach } from "vitest";
import { warnCareHoldReadFailed, __resetCareHoldWarn } from "../handlers/reach-cap.js";

describe("care-hold read failure is named, not silent (11-05 sweep)", () => {
  beforeEach(() => __resetCareHoldWarn());

  it("warns once per 10 minutes per companion, error class only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    expect(warnCareHoldReadFailed("drevan", new TypeError("boom secret detail"), t0)).toBe(true);
    expect(warnCareHoldReadFailed("drevan", new Error("again"), t0 + 60_000)).toBe(false);
    expect(warnCareHoldReadFailed("cypher", new Error("x"), t0 + 60_000)).toBe(true);
    expect(warnCareHoldReadFailed("drevan", new Error("later"), t0 + 10 * 60_000)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toContain("companion=drevan error=TypeError");
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret");
    warn.mockRestore();
  });
});
