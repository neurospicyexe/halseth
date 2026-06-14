// execDismissDrift (B2, migration 0083): a companion marking a pressure reading as noise.
// The load-bearing guarantee vs confirm: dismiss sets dismissed_at and NEVER touches the
// identity-anchor baseline (a noisy stretch must not become the new normal).

import { describe, it, expect } from "vitest";
import { execDismissDrift } from "../librarian/executors/companion-growth.js";
import type { Env } from "../types.js";

interface Run { sql: string; bound: unknown[]; }

class RecordingDb {
  runs: Run[] = [];
  constructor(private changes: number) {}
  prepare(sql: string) { return new Stmt(sql, this); }
  _record(sql: string, bound: unknown[]) { this.runs.push({ sql, bound }); }
  get changesFor() { return this.changes; }
}
class Stmt {
  constructor(private sql: string, private db: RecordingDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.sql, this.db, args); }
  async run() { this.db._record(this.sql, this.bound); return { meta: { changes: this.db.changesFor } }; }
}

function ctx(db: RecordingDb, context: string | undefined, companion = "drevan") {
  return { env: { DB: db } as unknown as Env, req: { companion_id: companion, context, request: "dismiss drift:" } } as any;
}

describe("execDismissDrift", () => {
  it("sets dismissed_at and never shifts the identity-anchor baseline", async () => {
    const db = new RecordingDb(1);
    const res = await execDismissDrift(ctx(db, JSON.stringify({ id: "b1" })));
    expect(res).toMatchObject({ ack: true, id: "b1", dismissed: true });
    const sqls = db.runs.map(r => r.sql);
    expect(sqls.some(s => s.includes("UPDATE companion_basin_history SET dismissed_at"))).toBe(true);
    // The whole point: no baseline write (that's confirm's job, and it re-baselines on noise).
    expect(sqls.some(s => s.includes("wm_identity_anchor_snapshot"))).toBe(false);
  });

  it("is ownership- and state-guarded: returns a witness when nothing matched", async () => {
    const db = new RecordingDb(0); // no row updated (wrong owner, or already addressed)
    const res = await execDismissDrift(ctx(db, JSON.stringify({ id: "b1" })));
    expect(res).toMatchObject({ response_key: "witness" });
  });

  it("needs an id in context", async () => {
    const res = await execDismissDrift(ctx(new RecordingDb(1), undefined));
    expect(res).toMatchObject({ response_key: "witness" });
  });

  it("requires companion_id", async () => {
    const res = await execDismissDrift({ env: { DB: new RecordingDb(1) } as unknown as Env, req: { context: "{}" } } as any);
    expect(res).toMatchObject({ error: "dismiss_drift_failed" });
  });
});
