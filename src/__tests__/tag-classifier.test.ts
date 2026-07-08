import { describe, it, expect } from "vitest";
import { classifyDomainTags, classifyKeywordTags } from "../synthesis/tag-classifier.js";

describe("classifyDomainTags", () => {
  it("matches health keywords", () => {
    expect(classifyDomainTags("HRV was low this morning, took my meds late")).toContain("health");
  });

  it("matches multiple domains", () => {
    const tags = classifyDomainTags("Deployed the migration for the database project today");
    expect(tags).toContain("projects");
    expect(tags).toContain("recent_events");
  });

  it("falls back to general on no match", () => {
    expect(classifyDomainTags("xyz abc qwe")).toEqual(["general"]);
  });

  it("falls back to general on empty text", () => {
    expect(classifyDomainTags("")).toEqual(["general"]);
  });
});

describe("classifyKeywordTags", () => {
  it("extracts proper nouns", () => {
    const tags = classifyKeywordTags("Scanned the Babita folder and wrote the meeting script");
    expect(tags).toContain("babita");
  });

  it("extracts multi-word proper noun phrases", () => {
    const tags = classifyKeywordTags("The House of Translation session with Drevan is next");
    expect(tags).toContain("house-of-translation");
  });

  it("drops stopwords and common sentence-start capitals", () => {
    const tags = classifyKeywordTags("The dog ran. It was fast.");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("it");
  });

  it("caps at 8 tags", () => {
    const words = Array.from({ length: 12 }, (_, i) => `Proper${i}`).join(" met ");
    const tags = classifyKeywordTags(words);
    expect(tags.length).toBeLessThanOrEqual(8);
  });

  it("returns empty array for empty text", () => {
    expect(classifyKeywordTags("")).toEqual([]);
  });
});
