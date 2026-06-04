import { describe, it, expect } from "vitest";
import { chunkKey, mergeChunkResults } from "../librarian/backends/second-brain.js";

const payload = (chunks: Array<Record<string, unknown>>) => JSON.stringify({ chunks });

describe("dual-vector merge", () => {
  it("chunkKey prefers vault_path, then path, id, source, then text", () => {
    expect(chunkKey({ vault_path: "a.md", path: "b" })).toBe("a.md");
    expect(chunkKey({ path: "b.md" })).toBe("b.md");
    expect(chunkKey({ id: "x" })).toBe("x");
    expect(chunkKey({ chunk_text: "hello" })).toBe(JSON.stringify("hello"));
  });

  it("keeps primary chunks first and dedupes overlap, primary wins", () => {
    const primary = payload([{ vault_path: "a.md", score: 0.9 }, { vault_path: "b.md", score: 0.8 }]);
    const continuity = payload([{ vault_path: "b.md", score: 0.7 }, { vault_path: "c.md", score: 0.6 }]);
    const merged = JSON.parse(mergeChunkResults(primary, continuity)) as { chunks: Array<{ vault_path: string; score: number }> };
    expect(merged.chunks.map((c) => c.vault_path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(merged.chunks.find((c) => c.vault_path === "b.md")!.score).toBe(0.8);
  });

  it("falls back to primary payload when shapes are not chunk-arrays", () => {
    expect(mergeChunkResults("not json", "{}")).toBe("not json");
    expect(mergeChunkResults(JSON.stringify({ foo: 1 }), JSON.stringify({ chunks: [] }))).toBe(JSON.stringify({ foo: 1 }));
  });

  it("preserves sibling fields on the primary payload", () => {
    const merged = JSON.parse(
      mergeChunkResults(JSON.stringify({ query: "q", chunks: [{ vault_path: "a.md" }] }), payload([{ vault_path: "z.md" }])),
    ) as { query: string; chunks: Array<{ vault_path: string }> };
    expect(merged.query).toBe("q");
    expect(merged.chunks.map((c) => c.vault_path)).toEqual(["a.md", "z.md"]);
  });
});
