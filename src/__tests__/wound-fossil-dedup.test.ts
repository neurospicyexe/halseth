// P3-5 (BUGS.md 2026-10-08). living_wounds and prohibited_fossils only had mig 0007's UNIQUE index on
// the EXACT name/subject, so "Grief" and "grief " were two rows. Without a migration, every write path
// now asks first on LOWER(TRIM(x)) (+ owner for wounds, legacy NULL owner reads as Gaia's) and acks
// the existing id instead of inserting. There is no SQLite harness here: the fake D1 answers the SELECT
// with a row when told to, and the assertions are on which statements fire and what comes back.
import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import { normalizeName, findExistingWound, findExistingFossil } from "../lib/wound-dedup.js";
import { woundAdd } from "../librarian/backends/halseth.js";
import { execWoundAdd } from "../librarian/executors/writes.js";
import { bootstrapConfig } from "../handlers/admin.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

type Call = { sql: string; binds: unknown[] };

/** A fake D1 whose SELECTs on the given table answer with `hit`; every other statement is inert. */
function fakeEnv(hits: Record<string, { id: string; created_at: string } | null>) {
  const calls: Call[] = [];
  const batches: Call[][] = [];
  const stmt = (sql: string) => {
    const call: Call = { sql, binds: [] };
    calls.push(call);
    const s = {
      bind: (...b: unknown[]) => { call.binds = b; return s; },
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
      first: async () => {
        if (!/^\s*SELECT/i.test(sql)) return null;
        for (const [table, row] of Object.entries(hits)) if (sql.includes(`FROM ${table}`)) return row;
        return null;
      },
      __call: call,
    };
    return s;
  };
  const env = {
    DB: {
      prepare: stmt,
      batch: async (stmts: { __call: Call }[]) => { batches.push(stmts.map((x) => x.__call)); return []; },
    },
    ADMIN_SECRET: "s3cret",
  } as unknown as Env;
  return { env, calls, batches };
}

const inserts = (calls: Call[], table: string) => calls.filter((c) => new RegExp(`INSERT[^;]*INTO ${table}`, "i").test(c.sql));
const selects = (calls: Call[], table: string) => calls.filter((c) => /^\s*SELECT/i.test(c.sql) && c.sql.includes(`FROM ${table}`));

describe("normalizeName", () => {
  it("folds case and surrounding whitespace", () => {
    expect(normalizeName("  Grief ")).toBe("grief");
    expect(normalizeName("GRIEF")).toBe("grief");
  });
});

describe("findExistingWound / findExistingFossil", () => {
  it("compares LOWER(TRIM(name)) against the normalized input, scoped to the owner (NULL owner = gaia)", async () => {
    const { env, calls } = fakeEnv({});
    await findExistingWound(env, " Grief ", "drevan");
    expect(calls[0]!.sql).toMatch(/LOWER\(TRIM\(name\)\) = \?/);
    expect(calls[0]!.sql).toMatch(/COALESCE\(companion_id, 'gaia'\) = \?/);
    expect(calls[0]!.binds).toEqual(["grief", "drevan"]);
    await findExistingWound(env, "Grief", null);
    expect(calls[1]!.binds).toEqual(["grief", "gaia"]);
  });

  it("fossils compare LOWER(TRIM(subject))", async () => {
    const { env, calls } = fakeEnv({});
    await findExistingFossil(env, " Rome ");
    expect(calls[0]!.sql).toMatch(/LOWER\(TRIM\(subject\)\) = \?/);
    expect(calls[0]!.binds).toEqual(["rome"]);
  });
});

describe("woundAdd (Librarian backend)", () => {
  it("acks the existing id and does not INSERT when the normalized name already exists for this owner", async () => {
    const { env, calls } = fakeEnv({ living_wounds: { id: "w_existing", created_at: "2026-05-01T00:00:00.000Z" } });
    const r = await woundAdd(env, "drevan", { name: "Grief ", description: "d", witness_type: "survival" });
    expect(r).toEqual({ id: "w_existing", created_at: "2026-05-01T00:00:00.000Z", witness_type: "survival", existing: true });
    expect(inserts(calls, "living_wounds")).toHaveLength(0);
    expect(selects(calls, "living_wounds")).toHaveLength(1);
  });

  it("inserts when nothing matches, after the check", async () => {
    const { env, calls } = fakeEnv({ living_wounds: null });
    const r = await woundAdd(env, "drevan", { name: "Grief", description: "d", witness_type: "survival" });
    expect("error" in r).toBe(false);
    expect((r as { existing?: true }).existing).toBeUndefined();
    expect(selects(calls, "living_wounds")).toHaveLength(1);
    const ins = inserts(calls, "living_wounds");
    expect(ins).toHaveLength(1);
    expect(ins[0]!.binds[2]).toBe("Grief");
    expect(ins[0]!.binds.at(-1)).toBe("drevan");
  });

  it("the executor acks with the existing id", async () => {
    const { env } = fakeEnv({ living_wounds: { id: "w_existing", created_at: "2026-05-01T00:00:00.000Z" } });
    const ctx = {
      env,
      req: { companion_id: "drevan", request: "add wound", context: JSON.stringify({ name: "grief", description: "d", witness_type: "survival" }) },
    } as unknown as ExecutorContext;
    const r = await execWoundAdd(ctx) as Record<string, unknown>;
    expect(r).toEqual({ ack: true, id: "w_existing", existing: true });
  });
});

describe("POST /admin/bootstrap seeds", () => {
  const post = (body: unknown) => new Request("https://test.local/admin/bootstrap", {
    method: "POST",
    headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("skips wound and fossil seeds whose normalized name/subject already exists and reports them", async () => {
    const { env, calls, batches } = fakeEnv({
      living_wounds: { id: "w_existing", created_at: "2026-05-01T00:00:00.000Z" },
      prohibited_fossils: { id: "f_existing", created_at: "2026-05-01T00:00:00.000Z" },
    });
    const res = await bootstrapConfig(post({
      wounds: [{ name: "GRIEF", description: "d", companion_id: "drevan" }],
      fossils: [{ subject: " rome ", directive: "x", reason: "y" }],
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { seeded: number; skipped_existing: unknown[] };
    expect(body.skipped_existing).toEqual([
      { table: "living_wounds", name: "GRIEF", id: "w_existing" },
      { table: "prohibited_fossils", name: " rome ", id: "f_existing" },
    ]);
    expect(inserts(calls, "living_wounds")).toHaveLength(0);
    expect(inserts(calls, "prohibited_fossils")).toHaveLength(0);
    // system_config rows still seed; the batch carries none of the skipped rows.
    expect(batches).toHaveLength(1);
    expect(batches[0]!.some((c) => /living_wounds|prohibited_fossils/.test(c.sql))).toBe(false);
  });

  it("keeps INSERT OR IGNORE for seeds that do not exist", async () => {
    const { env, calls } = fakeEnv({ living_wounds: null, prohibited_fossils: null });
    const res = await bootstrapConfig(post({
      wounds: [{ name: "Grief", description: "d" }],
      fossils: [{ subject: "Rome", directive: "x", reason: "y" }],
    }), env);
    const body = await res.json() as { seeded: number; skipped_existing: unknown[] };
    expect(body.skipped_existing).toEqual([]);
    expect(inserts(calls, "living_wounds")).toHaveLength(1);
    expect(inserts(calls, "living_wounds")[0]!.sql).toMatch(/INSERT OR IGNORE/);
    expect(inserts(calls, "prohibited_fossils")).toHaveLength(1);
    expect(inserts(calls, "prohibited_fossils")[0]!.sql).toMatch(/INSERT OR IGNORE/);
    // The wound seed with no companion_id checks as Gaia's (legacy NULL owner convention).
    expect(selects(calls, "living_wounds")[0]!.binds).toEqual(["grief", "gaia"]);
  });
});
