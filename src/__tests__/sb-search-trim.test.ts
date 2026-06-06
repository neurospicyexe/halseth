import { describe, it, expect } from "vitest";
import { trimSearchChunks } from "../librarian/executors/memory.js";

// Build a chunk whose serialized size is ~`size` chars so we can force the 3000-char budget.
function chunk(vault_path: string, pool: number, size = 700) {
  return { vault_path, pool, score: 0.5, text: "x".repeat(size) };
}

describe("trimSearchChunks", () => {
  it("keeps the guaranteed corpus chunk (pool 4) even when pool-1 chunks would push it past budget", () => {
    // 8 large pool-1 chunks (~700 chars each) >> 3000-char budget, plus one pool-4 corpus chunk
    // appended last (as sb_search does). Naive tail-truncation would drop the corpus.
    const chunks = [
      ...Array.from({ length: 8 }, (_, i) => chunk(`rag/note/${i}`, 1)),
      chunk("rag/historical_corpus/Calethian backup.md/13", 4),
    ];
    const raw = JSON.stringify({ chunks });

    const out = JSON.parse(trimSearchChunks(raw)) as { chunks: Array<{ vault_path: string; pool: number }> };

    // valid JSON, under budget, and the corpus chunk is present
    expect(out.chunks.some(c => c.pool === 4)).toBe(true);
    expect(out.chunks.some(c => c.vault_path.startsWith("rag/historical_corpus/"))).toBe(true);
    // budget respected (whole-chunk trimming, so the top relevance hit is still there too)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000 + 400);
    expect(out.chunks.some(c => c.pool === 1)).toBe(true);
  });

  it("returns valid JSON (whole chunks), never a mid-object slice", () => {
    const chunks = Array.from({ length: 12 }, (_, i) => chunk(`rag/note/${i}`, 1));
    const out = trimSearchChunks(JSON.stringify({ chunks }));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("passes non-chunk payloads through unchanged behaviour (falls back to truncateRaw)", () => {
    const out = trimSearchChunks("not json at all");
    expect(out).toBe("not json at all");
  });
});
