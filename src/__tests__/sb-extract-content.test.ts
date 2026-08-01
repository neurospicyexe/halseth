// src/__tests__/sb-extract-content.test.ts
//
// sbExtractContent: pull readable prose out of an sbRead result.
//
// The bug it fixes, found 2026-08-01 during the bot cutover and PRE-EXISTING on both surfaces: `sbRead` returns
// a JSON envelope (`{"path":...,"content":"---\nfrontmatter\n---\n\nbody"}`), and both orient paths ran
// `.replace(/^---[\s\S]*?---\n+/, "")` directly on that string. The regex is anchored at `^`, the string starts
// with `{`, so it never matched -- every companion's "last session narrative" arrived as a JSON blob with its
// YAML header intact. Same wrong regex in two places, which is the shape where fixing the copy you are looking
// at leaves the symptom alive.

import { describe, it, expect } from "vitest";
import { sbExtractContent } from "../librarian/backends/second-brain.js";

const BODY = "Cypher and Raziel closed the ratification floor: 41 of 52 entries were unreachable.";

describe("sbExtractContent", () => {
  it("unwraps the JSON envelope AND strips frontmatter -- the actual bug", () => {
    const raw = JSON.stringify({
      path: "raziel/sessions/2026-07-20-8e46248a-summary.md",
      content: `---\ntitle: session\ncompanion: cypher\n---\n\n${BODY}`,
    });

    const out = sbExtractContent(raw);
    expect(out).toBe(BODY);
    // The three things that leaked before, asserted individually so a regression names itself.
    expect(out).not.toContain('"path"');
    expect(out).not.toContain("---");
    expect(out).not.toContain("companion: cypher");
  });

  it("proves the OLD expression was broken on this exact input (non-vacuous)", () => {
    const raw = JSON.stringify({ path: "p.md", content: `---\na: b\n---\n\n${BODY}` });
    // What both call sites used to do:
    const legacy = String(raw).replace(/^---[\s\S]*?---\n+/, "");
    expect(legacy).toBe(raw);          // unchanged -- the regex never fired
    expect(legacy).toContain('"path"'); // so JSON reached the model
    expect(sbExtractContent(raw)).toBe(BODY);
  });

  it("handles plain markdown with frontmatter (not every caller passes an envelope)", () => {
    expect(sbExtractContent(`---\nx: 1\n---\n\n${BODY}`)).toBe(BODY);
  });

  it("handles plain prose with no frontmatter and no envelope", () => {
    expect(sbExtractContent(BODY)).toBe(BODY);
  });

  it("returns null for nothing usable rather than an empty-string narrative", () => {
    // null is honest ("no narrative"); "" renders as a present-but-blank block, which reads as a companion
    // whose last session had nothing in it.
    expect(sbExtractContent(null)).toBeNull();
    expect(sbExtractContent(undefined)).toBeNull();
    expect(sbExtractContent("")).toBeNull();
    expect(sbExtractContent("   \n  ")).toBeNull();
    expect(sbExtractContent(JSON.stringify({ path: "p.md", content: "---\na: b\n---\n\n" }))).toBeNull();
  });

  it("falls back to the raw text when the envelope is malformed, losing as little as possible", () => {
    // Truncated JSON: better to hand back something readable than to drop the narrative entirely.
    const broken = '{"path":"p.md","content":"' + BODY;
    expect(sbExtractContent(broken)).toContain(BODY);
  });

  it("survives an envelope whose content is not a string", () => {
    expect(sbExtractContent(JSON.stringify({ path: "p.md", content: { nested: true } }))).toContain("nested");
  });
});
