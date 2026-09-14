/**
 * close_kind = 'consolidation' (2026-09-11).
 *
 * The bots' idle-consolidation cron closes and reopens each Discord lane every ~2h with a
 * narrator-written spine: ~12 closes a day per companion that summarise an idle lane. They were
 * written with close_kind NULL -- "authored live" under mig 0114's own definition -- so:
 *   - the vibe-check day ledger (`close_kind IS NULL`) reported "sessions closed 12" as the whole
 *     of a quiet day and the reflections narrated it ("twelve closures, one quiet day");
 *   - continuity's "latest authored handover" surfaced a two-hour-old re-narration of stillness
 *     ahead of the last close a person actually wrote.
 * The Librarian close path now honours a caller-asserted `close_kind` from an allowlist, and the
 * consolidation caller asserts it. Source-reading tests, like the rest of this area: the guarantee
 * is in the SQL shape and the allowlist, not in behaviour a fake D1 could exercise.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SUPERSEDABLE_CLOSE_KINDS, CALLER_CLOSE_KINDS } from "../db/queries.js";

const src = (p: string) => readFile(resolve(__dirname, "..", p), "utf8");

describe("caller-asserted close_kind", () => {
  it("'consolidation' is the only kind a caller may assert, and it is supersedable", () => {
    // 2026-09-14: 'shutdown' joined -- a bot's "[auto] <id> bot shutdown -- process received a stop
    // signal" close was landing as close_kind NULL, i.e. authored, and surfaced as the latest
    // authored handover at the next boot (a pm2 reload is not the last thing that happened).
    expect([...CALLER_CLOSE_KINDS]).toEqual(["consolidation", "shutdown"]);
    // A later authored close for the same session must be able to replace the machine one.
    expect([...SUPERSEDABLE_CLOSE_KINDS]).toContain("consolidation");
    expect([...SUPERSEDABLE_CLOSE_KINDS]).toContain("shutdown");
    // 'reconstructed' holds hand-written content and must stay non-supersedable and non-assertable.
    expect([...SUPERSEDABLE_CLOSE_KINDS]).not.toContain("reconstructed");
    expect([...CALLER_CLOSE_KINDS] as string[]).not.toContain("reconstructed");
  });

  it("the Librarian close INSERT writes close_kind from the allowlisted param, else NULL", async () => {
    const backend = await src("librarian/backends/halseth.ts");
    const fn = backend.slice(backend.indexOf("export async function sessionClose("));
    expect(fn).toMatch(/close_kind\?: string \| null;/);
    // Allowlist gate, not a passthrough: an unknown value from the wire becomes NULL.
    expect(fn).toMatch(/CALLER_CLOSE_KINDS as readonly string\[\]\)\.includes\(params\.close_kind\)/);
    expect(fn).toMatch(/INSERT INTO handover_packets \([^)]*\bclose_kind\)/);
    const insert = fn.match(/INSERT INTO handover_packets \(([^)]*)\) VALUES \(([^)]*)\)/);
    expect(insert).not.toBeNull();
    const cols = (insert?.[1] ?? "").split(",").map((s) => s.trim());
    const vals = (insert?.[2] ?? "").split(",").map((s) => s.trim());
    expect(cols.length).toBe(vals.length);
    expect(cols.at(-1)).toBe("close_kind");
    expect(vals.at(-1)).toBe("?");
    // The bound value is the gated variable, never the raw param.
    expect(fn).toMatch(/params\.motion_state, closeKind\)/);
  });

  it("the executor's parsed context declares close_kind so `...p` carries it to the backend", async () => {
    const exec = await src("librarian/executors/session.ts");
    const fn = exec.slice(exec.indexOf("export async function execSessionClose("));
    expect(fn).toMatch(/close_kind\?: string;/);
    expect(fn).toMatch(/sessionClose\(ctx\.env, \{ \.\.\.p,/);
  });

  it("the day ledger and continuity reads still filter close_kind IS NULL (that is what makes this work)", async () => {
    const vibe = await src("webmind/vibecheck.ts");
    expect(vibe).toMatch(/handover_packets hp JOIN sessions s ON s\.id = hp\.session_id[\s\S]{0,200}hp\.close_kind IS NULL/);
    const queries = await src("db/queries.ts");
    expect(queries).toMatch(/SELECT \* FROM handover_packets WHERE close_kind IS NULL ORDER BY created_at DESC LIMIT 1/);
  });
});
