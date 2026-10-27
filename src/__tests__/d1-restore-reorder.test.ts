// scripts/backup/make-d1-restore.mjs (2026-10-27): a raw `wrangler d1 export` does not import back into
// D1 (child tables created before their parent). The reorder must keep every statement intact -- stored
// notes contain ';', quotes and newlines -- and put tables, then rows, then triggers/indexes.
import { describe, it, expect } from "vitest";
// @ts-expect-error -- plain .mjs script, no types
import { splitStatements, phaseOf, reorderDump } from "../../scripts/backup/make-d1-restore.mjs";

const DUMP = [
  "PRAGMA defer_foreign_keys=TRUE;",
  "CREATE TABLE child(id TEXT PRIMARY KEY, round_id TEXT REFERENCES parent(id));",
  "INSERT INTO \"child\" VALUES('c1','p1');",
  "CREATE TRIGGER bump AFTER INSERT ON parent BEGIN UPDATE child SET id = id || '!'; END;",
  "CREATE TABLE parent(id TEXT PRIMARY KEY, note TEXT);",
  "INSERT INTO \"parent\" VALUES('p1','she said; \"stay\" -- it''s fine\nsecond line;');",
  "CREATE INDEX idx_child ON child(round_id);",
].join("\n");

describe("make-d1-restore", () => {
  it("splits on semicolons outside quotes only (notes keep their ; '' \"\" -- and newlines)", () => {
    const s = splitStatements(DUMP);
    expect(s).toHaveLength(7);
    expect(s[5]).toContain("she said; \"stay\" -- it''s fine\nsecond line;");
    // a trigger body's own ';' does not cut the trigger in two
    expect(s[3]).toBe("CREATE TRIGGER bump AFTER INSERT ON parent BEGIN UPDATE child SET id = id || '!'; END;");
    expect(s.join("\n")).toBe(DUMP);
  });

  it("orders pragma -> tables -> rows -> everything else, nothing dropped", () => {
    const r = reorderDump(DUMP);
    expect(r.total).toBe(7);
    const order = splitStatements(r.text).map(phaseOf);
    expect(order).toEqual([...order].sort((a: number, b: number) => a - b));
    expect(r.text.indexOf("CREATE TABLE parent")).toBeLessThan(r.text.indexOf("INSERT INTO \"child\""));
    expect(r.text.indexOf("CREATE TRIGGER")).toBeGreaterThan(r.text.indexOf("INSERT INTO \"parent\""));
  });
});
