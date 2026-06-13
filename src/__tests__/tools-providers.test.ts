import { describe, it, expect } from "vitest";
import {
  normalizeTavilyResults,
  imageKeyFor,
  summarizeArgs,
  toolsEnabled,
  extImageMime,
} from "../tools/providers.js";

describe("normalizeTavilyResults", () => {
  it("maps Tavily's {results:[{title,url,content,score}]} to normalized shape, capped", () => {
    const raw = {
      results: [
        { title: "A", url: "https://a.test", content: "alpha body", score: 0.9 },
        { title: "B", url: "https://b.test", content: "beta body", score: 0.7 },
        { title: "C", url: "https://c.test", content: "gamma body", score: 0.5 },
      ],
    };
    const out = normalizeTavilyResults(raw, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: "A", url: "https://a.test", snippet: "alpha body", score: 0.9 });
    expect(out[1]!.title).toBe("B");
  });

  it("is defensive against missing fields and non-array results", () => {
    expect(normalizeTavilyResults({}, 5)).toEqual([]);
    expect(normalizeTavilyResults(null, 5)).toEqual([]);
    expect(normalizeTavilyResults({ results: "nope" }, 5)).toEqual([]);
    const out = normalizeTavilyResults({ results: [{ url: "https://x.test" }] }, 5);
    expect(out[0]).toEqual({ title: "(untitled)", url: "https://x.test", snippet: "", score: 0 });
  });

  it("drops entries with no url (nothing to cite)", () => {
    const out = normalizeTavilyResults({ results: [{ title: "no url" }, { title: "ok", url: "https://ok.test" }] }, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://ok.test");
  });

  it("truncates long snippets to keep audit + payload bounded", () => {
    const long = "x".repeat(2000);
    const out = normalizeTavilyResults({ results: [{ title: "L", url: "https://l.test", content: long }] }, 1);
    expect(out[0]!.snippet.length).toBeLessThanOrEqual(500);
  });
});

describe("imageKeyFor", () => {
  it("namespaces by companion + call id under tool-images/ with the right extension", () => {
    expect(imageKeyFor("cypher", "abc123", "image/png")).toBe("tool-images/cypher/abc123.png");
    expect(imageKeyFor("drevan", "def456", "image/jpeg")).toBe("tool-images/drevan/def456.jpg");
  });
  it("defaults unknown mime to .png", () => {
    expect(imageKeyFor("gaia", "x", "application/octet-stream")).toBe("tool-images/gaia/x.png");
  });
});

describe("extImageMime", () => {
  it("maps known image mimes to extensions", () => {
    expect(extImageMime("image/png")).toBe("png");
    expect(extImageMime("image/jpeg")).toBe("jpg");
    expect(extImageMime("image/webp")).toBe("webp");
    expect(extImageMime("image/gif")).toBe("gif");
  });
  it("falls back to png for anything else", () => {
    expect(extImageMime("text/plain")).toBe("png");
    expect(extImageMime(null)).toBe("png");
  });
});

describe("summarizeArgs", () => {
  it("produces a short bounded human summary per tool", () => {
    expect(summarizeArgs("web_search", "what is the weather in rome")).toBe("query: what is the weather in rome");
    const long = "a".repeat(500);
    expect(summarizeArgs("generate_image", long).length).toBeLessThanOrEqual(220);
    expect(summarizeArgs("generate_image", long).startsWith("prompt: ")).toBe(true);
  });
});

describe("toolsEnabled gate", () => {
  it("explicit per-companion setting wins over the env default", () => {
    expect(toolsEnabled("true", false)).toBe(true);
    expect(toolsEnabled("false", true)).toBe(false);
  });
  it("falls back to the env default when no setting row exists", () => {
    expect(toolsEnabled(null, true)).toBe(true);
    expect(toolsEnabled(undefined, false)).toBe(false);
  });
  it("treats only the literal string 'true' as enabled (case/space tolerant)", () => {
    expect(toolsEnabled(" TRUE ", false)).toBe(true);
    expect(toolsEnabled("1", false)).toBe(false); // not 'true' -> falls to setting-is-present-but-not-true => disabled
  });
});
