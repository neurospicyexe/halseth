// Migration 0154: a partial index on growth_journal(created_at DESC) WHERE review_status = 'pending',
// so the Needs-you badge count and list (RATIFIABLE_PENDING_SQL) stop full-scanning the journal.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { RATIFIABLE_PENDING_SQL } from "../lib/ratifiable.js";

describe("migration 0154", () => {
  it("creates idx_growth_journal_review_pending as a partial index on pending rows", () => {
    const { db } = makeSqliteD1();
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_growth_journal_review_pending'")
      .get() as { sql: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.sql).toMatch(/WHERE\s+review_status\s*=\s*'pending'/i);
  });

  it("the needs count and list use it instead of scanning growth_journal", () => {
    const { db } = makeSqliteD1();
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const count = plan(`SELECT COUNT(*) AS n FROM growth_journal WHERE ${RATIFIABLE_PENDING_SQL}`);
    const list = plan(
      `SELECT id FROM growth_journal WHERE ${RATIFIABLE_PENDING_SQL} ORDER BY created_at DESC LIMIT 50`,
    );
    expect(count).toContain("idx_growth_journal_review_pending");
    expect(list).toContain("idx_growth_journal_review_pending");
    expect(list).not.toMatch(/TEMP B-TREE/);
  });
});
