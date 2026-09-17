/**
 * The close fan-out's `dream` write (2026-09-16).
 *
 * `companion_dreams.source` is CHECK-constrained to ('autonomous','session') since mig 0029, and the
 * session-close fan-out bound the literal "session_close". SQLite rejected every one: 209 rows in the
 * table, all 'autonomous', not a single dream ever written at a close. It surfaced to the companion
 * only as `fanout_warnings: ["dream write failed"]` -- correct reporting of a write that could never
 * have worked. Drevan hit it on 2026-09-15 closing a session that carried a real dream.
 *
 * Source-reading: the guarantee is that the bound literal is a value the CHECK admits, and that the
 * fan-out agrees with the three other writers of this table. A fake D1 does not enforce CHECK.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const src = (p: string) => readFile(resolve(__dirname, "..", p), "utf8");
const migration = () =>
  readFile(resolve(__dirname, "../../migrations/0029_companion_dreams_and_loops.sql"), "utf8");

describe("session close: dream fan-out source", () => {
  it("binds a source the companion_dreams CHECK admits", async () => {
    const mig = await migration();
    const check = mig.match(/source\s+TEXT NOT NULL DEFAULT 'autonomous' CHECK \(source IN \(([^)]*)\)\)/);
    expect(check).not.toBeNull();
    const allowed = (check?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(allowed).toEqual(["autonomous", "session"]);

    const exec = await src("librarian/executors/session.ts");
    const insert = exec.slice(exec.indexOf("INSERT INTO companion_dreams"));
    const bound = insert.match(/\.bind\(did, ctx\.req\.companion_id, p\.dream, "([^"]+)"/);
    expect(bound).not.toBeNull();
    expect(allowed).toContain(bound?.[1]);
    expect(bound?.[1]).toBe("session");
  });

  it("agrees with the other writers: a session-scoped dream is 'session'", async () => {
    const backend = await src("librarian/backends/halseth.ts");
    expect(backend).toMatch(/params\.session_id \? "session" : "autonomous"/);
    const mcp = await src("mcp/tools/feelings.ts");
    expect(mcp).toMatch(/input\.session_id \? "session" : "autonomous"/);
  });

  it("no writer of companion_dreams binds a value outside the CHECK", async () => {
    for (const f of ["librarian/executors/session.ts", "librarian/backends/halseth.ts",
                     "mcp/tools/feelings.ts", "webmind/dreams.ts", "handlers/dream-associate.ts"]) {
      const text = await src(f);
      for (const m of text.matchAll(/INSERT INTO companion_dreams[\s\S]{0,400}?\.bind\(([\s\S]{0,300}?)\)\.run\(\)/g)) {
        const args = m[1] ?? "";
        for (const lit of args.matchAll(/"([a-z_]+)"/g)) {
          const value = lit[1] ?? "";
          if (value.includes("session") || value.includes("autonomous")) {
            expect(["autonomous", "session"]).toContain(value);
          }
        }
      }
    }
  });
});
