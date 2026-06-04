import { describe, it, expect } from "vitest";
import { buildHomeBlock } from "../webmind/orient.js";
import { promoteToCanon } from "../webmind/home/store.js";

type Row = Record<string, unknown>;
function makeStmt(results: Row[]) {
  const stmt: any = { bind: () => stmt, all: async () => ({ results }), first: async () => results[0] ?? null, run: async () => ({ meta: { changes: 1 } }) };
  return stmt;
}
function env(impl: (sql: string) => any) { return { DB: { prepare: impl } } as any; }

describe("buildHomeBlock", () => {
  it("returns unsurfaced events and never throws on DB error", async () => {
    const e = env((sql) => {
      if (sql.includes("UPDATE home_events")) return makeStmt([]);
      return makeStmt([{ id: "e1", companion_id: "drevan", event_type: "move", room: "bedroom", with_companion: null, text: "sat with a thread", surfaced_at: null, growth_journal_id: null, created_at: "t" }]);
    });
    const block = await buildHomeBlock(e, "drevan");
    expect(block).toHaveLength(1);
    expect(block[0]?.room).toBe("bedroom");
  });

  it("returns [] when the home layer errors (orient must not break)", async () => {
    const e = env(() => { throw new Error("d1 down"); });
    const block = await buildHomeBlock(e, "drevan");
    expect(block).toEqual([]);
  });
});

describe("promoteToCanon", () => {
  it("inserts a pending/home-sourced growth_journal row and links the event", async () => {
    const calls: { sql: string; bound: unknown[] }[] = [];
    const e = env((sql: string) => {
      const stmt: any = {
        bind: (...args: unknown[]) => { calls.push({ sql, bound: args }); return stmt; },
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
        first: async () => null,
      };
      return stmt;
    });

    const journalId = await promoteToCanon(e, "cypher", "evt-1", "I noticed I keep returning to the bedroom.");

    expect(typeof journalId).toBe("string");
    expect(journalId.length).toBeGreaterThan(0);

    const insert = calls.find(c => c.sql.includes("INSERT INTO growth_journal"));
    expect(insert).toBeDefined();
    // ratification gate: row lands pending; source tags it 'home'
    expect(insert!.sql).toContain("review_status");
    expect(insert!.bound).toContain("pending");
    expect(insert!.bound).toContain("home");
    expect(insert!.bound).toContain("cypher");
    expect(insert!.bound).toContain("I noticed I keep returning to the bedroom.");

    const update = calls.find(c => c.sql.includes("UPDATE home_events"));
    expect(update).toBeDefined();
    expect(update!.bound).toContain("evt-1");
    expect(update!.bound).toContain(journalId);
  });
});
