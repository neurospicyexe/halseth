// execJournalReview ordering (2026-08-12).
//
// This is the ONLY query in the codebase that LISTS ratifiable growth entries -- every other
// RATIFIABLE_PENDING_SQL site is a COUNT -- so its ORDER BY decides what can ever be ratified.
// It was `created_at DESC LIMIT 10`, which stranded the middle of the queue: measured in prod,
// cypher's pending block was entries 9..23 of 36 with rows REVIEWED on both sides (0..8 and
// 24..35). Reviewed-on-both-sides is the signature of a newest-first window that ratified fresh
// arrivals and could not reach back past its own LIMIT. Arrivals are ~0.9/day per companion, so
// under DESC the backlog is a fixed point, not a delay.
//
// These tests pin the two properties that make it drainable and keep the count honest.

import { describe, it, expect } from "vitest";
import { execJournalReview } from "../librarian/executors/companion-growth.js";
import type { Env } from "../types.js";

interface Seen { sql: string; bound: unknown[] }

function makeDb(rowCount: number, total: number) {
  const seen: Seen[] = [];
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `j${i}`,
    entry_type: "signal_audit",
    content: "x".repeat(900), // longer than the 600-char clip, to prove truncation still happens
    tags_json: '["vibecheck-reflection"]',
    created_at: `2026-07-${String(10 + i).padStart(2, "0")} 02:00:00`,
  }));
  const db = {
    prepare(sql: string) {
      return {
        bind(...bound: unknown[]) {
          seen.push({ sql, bound });
          return {
            all: async () => ({ results: rows }),
            first: async () => ({ n: total }),
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, seen };
}

// No default on `companion`: a default parameter would swallow an explicitly-passed `undefined`,
// which is exactly how the "requires companion_id" case first passed against a companion of
// "cypher" and proved nothing.
function ctx(env: Env, companion: string | undefined) {
  return { env, req: { companion_id: companion, request: "review my growth journal" } } as any;
}

describe("execJournalReview", () => {
  it("lists OLDEST first, so the stranded backlog is reachable", async () => {
    const { env, seen } = makeDb(10, 15);
    await execJournalReview(ctx(env, "cypher"));
    const list = seen.find(s => s.sql.includes("SELECT id, entry_type"))!;
    expect(list.sql).toContain("created_at ASC");
    expect(list.sql).not.toContain("created_at DESC");
  });

  it("breaks created_at ties on id, so no row can sit on a page boundary forever", async () => {
    const { env, seen } = makeDb(10, 15);
    await execJournalReview(ctx(env, "cypher"));
    const list = seen.find(s => s.sql.includes("SELECT id, entry_type"))!;
    expect(list.sql).toContain("id ASC");
  });

  it("reports pending_total from the SAME predicate as the page", async () => {
    const { env, seen } = makeDb(10, 40);
    const res = await execJournalReview(ctx(env, "cypher")) as any;
    // A page length alone reads identically for "10 left" and "40 left".
    expect(res.pending_total).toBe(40);
    expect(res.meta.count).toBe(10);
    expect(res.meta.pending_total).toBe(40);
    const count = seen.find(s => s.sql.includes("COUNT(*)"))!;
    // Both statements carry the ratifiable filter and are scoped to the one companion.
    expect(count.sql).toContain("review_status");
    expect(count.bound).toEqual(["cypher"]);
  });

  it("still clips content to 600 chars and flags its ordering to the reader", async () => {
    const { env } = makeDb(3, 3);
    const res = await execJournalReview(ctx(env, "cypher")) as any;
    expect(res.pending_entries[0].content.length).toBe(600);
    expect(res.pending_entries[0].tags).toEqual(["vibecheck-reflection"]);
    expect(res.oldest_first).toBe(true);
  });

  it("requires companion_id -- the queue is per-companion and ownership-scoped", async () => {
    const { env } = makeDb(0, 0);
    const res = await execJournalReview(ctx(env, undefined)) as any;
    expect(res.error).toBe("journal_review_failed");
  });
});
