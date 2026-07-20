import { describe, it, expect, vi } from "vitest";
import { noveltyCheck, NOVELTY_SKIP, NOVELTY_SUPERSEDE } from "../webmind/novelty.js";

function makeEnv(matches: Array<{ id: string; score: number }>) {
  return {
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: { query: vi.fn(async () => ({ matches })), upsert: vi.fn() },
  } as any;
}

describe("noveltyCheck", () => {
  it("inserts when nothing similar exists", async () => {
    const d = await noveltyCheck(makeEnv([]), "fresh thought", "companion_conclusions", "cypher");
    expect(d.action).toBe("insert");
  });
  it("skips near-identical (>= 0.95)", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_conclusions:abc", score: 0.97 }]), "same thought", "companion_conclusions", "cypher");
    expect(d).toMatchObject({ action: "skip", matchRowId: "abc", score: 0.97 });
  });
  it("supersedes conclusions in the 0.88-0.95 band", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_conclusions:abc", score: 0.9 }]), "evolved thought", "companion_conclusions", "cypher");
    expect(d.action).toBe("supersede");
  });
  it("journal in the supersede band still inserts (supersede is conclusions-only)", async () => {
    const d = await noveltyCheck(makeEnv([{ id: "companion_journal:xyz", score: 0.9 }]), "similar entry", "companion_journal", "cypher");
    expect(d.action).toBe("insert");
  });
  it("fails open when embedding is unavailable", async () => {
    const env = makeEnv([]); env.AI.run = vi.fn(async () => ({ data: [] }));
    const d = await noveltyCheck(env, "text", "companion_journal", "cypher");
    expect(d.action).toBe("insert");
  });
});
