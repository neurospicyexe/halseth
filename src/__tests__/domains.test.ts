import { describe, it, expect } from "vitest";
import {
  SUPPORTED_MEMORY_DOMAINS,
  normalizeDomainValue,
  isSupportedMemoryDomain,
  validateDomains,
  extractDomains,
} from "../synthesis/domains.js";

describe("memory domain vocabulary", () => {
  it("is frozen and includes BBH additions", () => {
    expect(Object.isFrozen(SUPPORTED_MEMORY_DOMAINS)).toBe(true);
    for (const d of ["systems", "spiral", "companions", "anchors", "rituals", "stressors"]) {
      expect((SUPPORTED_MEMORY_DOMAINS as readonly string[]).includes(d)).toBe(true);
    }
  });

  it("normalizeDomainValue lowercases, trims, slugs", () => {
    expect(normalizeDomainValue("  Recent Events! ")).toBe("recent_events");
    expect(normalizeDomainValue("SYSTEMS")).toBe("systems");
    expect(normalizeDomainValue(null)).toBe("");
  });

  it("isSupportedMemoryDomain matches after normalization", () => {
    expect(isSupportedMemoryDomain("Spiral")).toBe(true);
    expect(isSupportedMemoryDomain("not-a-domain")).toBe(false);
  });

  it("validateDomains drops unknowns, dedupes, falls back to general", () => {
    expect(validateDomains(["spiral", "Spiral", "bogus", "work"])).toEqual(["spiral", "work"]);
    expect(validateDomains([])).toEqual(["general"]);
    expect(validateDomains(["nonsense"])).toEqual(["general"]);
  });

  it("extractDomains parses a ## Domains section, dropping out-of-vocab tags", () => {
    const md = [
      "## Close State",
      "floated, gentle",
      "## Domains",
      "spiral, companions, systems, made_up_tag",
      "",
      "source: synthesis-worker",
    ].join("\n");
    expect(extractDomains(md)).toEqual(["spiral", "companions", "systems"]);
  });

  it("extractDomains handles bullets and missing section", () => {
    expect(extractDomains("## Domains\n- work\n- projects\n- patterns\n")).toEqual(["work", "projects", "patterns"]);
    expect(extractDomains("no section here")).toEqual(["general"]);
    expect(extractDomains("")).toEqual(["general"]);
  });
});
