// Quiet-drops sweep items 13/14/15: autonomy reaper, failed-synthesis prune, forage expiry.
// Runs against the REAL schema (every migration, node:sqlite), so the SQL is exercised, not string-matched.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  reapStuckAutonomyRuns, pruneFailedSynthesis, expireForageFinds, runHousekeeping,
  HOUSEKEEPING_GATE_COMPANION_ID, HOUSEKEEPING_GATE_KEY, REAP_REASON,
} from "../maintenance/housekeeping.js";
import { SUPPLY_SOURCES } from "../director/supply-query.js";

const ago = (modifier: string) => `datetime('now','${modifier}')`;

function setup() {
  const { db, DB } = makeSqliteD1();
  return { db, env: { DB } as any };
}

function run(db: any, id: string, status: string, startedMod: string | null) {
  db.exec(`INSERT INTO autonomy_runs (id, companion_id, run_type, status, started_at)
           VALUES ('${id}', 'cypher', 'exploration', '${status}', ${startedMod ? ago(startedMod) : "NULL"})`);
}
const rowOf = (db: any, t: string, id: string) => db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);

describe("reapStuckAutonomyRuns", () => {
  it("fails a run stuck 'running' > 6h, with the reason and an ended timestamp", async () => {
    const { db, env } = setup();
    run(db, "old", "running", "-7 hours");
    run(db, "ancient", "running", "-100 days");
    expect(await reapStuckAutonomyRuns(env)).toBe(2);
    const r = rowOf(db, "autonomy_runs", "old");
    expect(r.status).toBe("failed");
    expect(r.error_message).toBe(REAP_REASON);
    expect(r.completed_at).toBeTruthy();
  });

  it("leaves fresh runs, other statuses, and completed history alone", async () => {
    const { db, env } = setup();
    run(db, "fresh", "running", "-5 hours");
    run(db, "done", "completed", "-30 days");
    run(db, "bad", "failed", "-30 days");
    expect(await reapStuckAutonomyRuns(env)).toBe(0);
    expect(rowOf(db, "autonomy_runs", "fresh").status).toBe("running");
    expect(rowOf(db, "autonomy_runs", "done").status).toBe("completed");
    expect(rowOf(db, "autonomy_runs", "bad").error_message).toBeNull();
  });

  it("falls back to created_at when started_at is NULL (a pending-then-running row)", async () => {
    const { db, env } = setup();
    db.exec(`INSERT INTO autonomy_runs (id, companion_id, run_type, status, started_at, created_at)
             VALUES ('nostart', 'gaia', 'exploration', 'running', NULL, ${ago("-8 hours")})`);
    expect(await reapStuckAutonomyRuns(env)).toBe(1);
  });
});

describe("pruneFailedSynthesis", () => {
  const q = (db: any, id: string, status: string, mod: string) =>
    db.exec(`INSERT INTO synthesis_queue (id, session_id, status, created_at, processed_at)
             VALUES ('${id}', 's', '${status}', ${ago(mod)}, ${ago(mod)})`);

  it("deletes failed rows older than 14 days only", async () => {
    const { db, env } = setup();
    q(db, "f-old", "failed", "-15 days");
    q(db, "f-new", "failed", "-13 days");
    q(db, "d-old", "done", "-60 days");
    q(db, "p-old", "pending", "-60 days");
    expect(await pruneFailedSynthesis(env)).toBe(1);
    expect(rowOf(db, "synthesis_queue", "f-old")).toBeUndefined();
    for (const id of ["f-new", "d-old", "p-old"]) expect(rowOf(db, "synthesis_queue", id)).toBeDefined();
  });

  it("works through a backlog in batches (one batch per call)", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 1500; i++) q(db, `f${i}`, "failed", "-30 days");
    expect(await pruneFailedSynthesis(env)).toBe(1000);
    expect(await pruneFailedSynthesis(env)).toBe(500);
    expect(await pruneFailedSynthesis(env)).toBe(0);
  });
});

describe("expireForageFinds", () => {
  const find = (db: any, id: string, mod: string, consumed = false) =>
    db.exec(`INSERT INTO forage_finds (id, companion_id, domain, title, summary, gathered_at, consumed_at, consumed_by)
             VALUES ('${id}', 'cypher', 'd', 't', 's', ${ago(mod)}, ${consumed ? ago("-1 days") : "NULL"}, ${consumed ? "'cypher'" : "NULL"})`);

  it("stamps expired_at on unconsumed finds older than 21 days; never touches consumed or fresh ones", async () => {
    const { db, env } = setup();
    find(db, "stale", "-22 days");
    find(db, "fresh", "-20 days");
    find(db, "eaten", "-40 days", true);
    expect(await expireForageFinds(env)).toBe(1);
    expect(rowOf(db, "forage_finds", "stale").expired_at).toBeTruthy();
    expect(rowOf(db, "forage_finds", "stale").consumed_at).toBeNull();
    expect(rowOf(db, "forage_finds", "fresh").expired_at).toBeNull();
    expect(rowOf(db, "forage_finds", "eaten").expired_at).toBeNull();
    expect(await expireForageFinds(env)).toBe(0); // idempotent
  });

  it("expired finds drop out of the supply query and the pool reads", async () => {
    const { db, env } = setup();
    find(db, "stale", "-22 days");
    find(db, "fresh", "-2 days");
    await expireForageFinds(env);
    const supply = SUPPLY_SOURCES.find(s => s.kind === "forage")!;
    const rows = db.prepare(supply.sql).all("1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "", 50) as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(["fresh"]);
    const pool = db.prepare(
      "SELECT id FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND consumed_at IS NULL AND expired_at IS NULL"
    ).all("cypher") as { id: string }[];
    expect(pool.map(r => r.id)).toEqual(["fresh"]);
  });
});

describe("runHousekeeping gate", () => {
  it("runs all three, stamps its own gate, then self-gates for the hour; force bypasses", async () => {
    const { db, env } = setup();
    run(db, "stuck", "running", "-9 hours");
    const first = await runHousekeeping(env);
    expect(first).toMatchObject({ ran: true, reaped: 1 });
    const stamp = db.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
      .get(HOUSEKEEPING_GATE_COMPANION_ID, HOUSEKEEPING_GATE_KEY) as { value: string };
    expect(stamp.value).toBeTruthy();

    run(db, "stuck2", "running", "-9 hours");
    expect((await runHousekeeping(env)).ran).toBe(false);
    expect(rowOf(db, "autonomy_runs", "stuck2").status).toBe("running");
    expect(await runHousekeeping(env, { force: true })).toMatchObject({ ran: true, reaped: 1 });
  });
});
