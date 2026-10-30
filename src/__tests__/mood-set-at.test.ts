// mood_set_at (mig 0153) moves ONLY when a companion authors current_mood / compound_state.
// Hearth's Home shows "last said: <word>, <age>" off it, so floats, ticks and legacy fields must not touch it.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { updateCompanionState, sessionClose } from "../librarian/backends/halseth.js";
import { getSoma } from "../handlers/soma.js";
import { fermentTickUpdateSql, stimulusBumpSql } from "../webmind/fermentation.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  db.prepare("INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES ('cypher', '2026-01-01 00:00:00')").run();
  return { db, env };
}
const session = (db: any, id: string) =>
  db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, datetime('now'), datetime('now'))").run(id);
const row = (db: any) =>
  db.prepare("SELECT mood_set_at, updated_at, current_mood FROM companion_state WHERE companion_id = 'cypher'").get() as any;

describe("companion_state.mood_set_at", () => {
  it("updateCompanionState stamps mood_set_at (same instant as updated_at) when current_mood is written", async () => {
    const { db, env } = setup();
    expect(row(db).mood_set_at).toBeNull();
    await updateCompanionState(env, "cypher", { current_mood: "steady" });
    const r = row(db);
    expect(r.mood_set_at).not.toBeNull();
    expect(r.mood_set_at).toBe(r.updated_at);
  });

  it("updateCompanionState stamps on compound_state alone", async () => {
    const { db, env } = setup();
    await updateCompanionState(env, "cypher", { compound_state: "braced but warm" });
    expect(row(db).mood_set_at).not.toBeNull();
  });

  it("updateCompanionState leaves mood_set_at untouched when only floats change", async () => {
    const { db, env } = setup();
    await updateCompanionState(env, "cypher", { soma_float_1: 0.7 });
    expect(row(db).mood_set_at).toBeNull();
  });

  it("a mood write after a float-only write still stamps; a later float-only write does not move it", async () => {
    const { db, env } = setup();
    await updateCompanionState(env, "cypher", { current_mood: "quiet" });
    db.prepare("UPDATE companion_state SET mood_set_at = '2026-02-02 02:02:02' WHERE companion_id = 'cypher'").run();
    await updateCompanionState(env, "cypher", { soma_float_2: 0.4 });
    expect(row(db).mood_set_at).toBe("2026-02-02 02:02:02");
  });

  it("sessionClose stamps mood_set_at when somaFields carries current_mood, not for floats only", async () => {
    const { db, env } = setup();
    session(db, "sess-a"); session(db, "sess-b");
    const base = { spine: "s", last_real_thing: "l", motion_state: "at_rest", companionId: "cypher" };
    await sessionClose(env, { ...base, session_id: "sess-a", somaFields: { soma_float_1: 0.6 } });
    expect(row(db).mood_set_at).toBeNull();
    await sessionClose(env, { ...base, session_id: "sess-b", somaFields: { current_mood: "settled" } });
    const r = row(db);
    expect(r.mood_set_at).not.toBeNull();
    expect(r.mood_set_at).toBe(r.updated_at);
  });

  it("the ferment tick and stimulus bump never stamp it", () => {
    const { db } = setup();
    db.prepare(fermentTickUpdateSql()).run(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, "a", "b", "c", null, "cypher", 0);
    db.prepare(stimulusBumpSql()).run(0.1, 0.1, 0.1, "cypher");
    expect(row(db).mood_set_at).toBeNull();
  });

  it("getSoma returns mood_set_at", async () => {
    const { db, env } = setup();
    await updateCompanionState(env, "cypher", { current_mood: "steady" });
    const res = await getSoma(new Request("https://x/soma", { headers: { Authorization: "Bearer s" } }), env);
    const body = await res.json() as any;
    expect(body.cypher).toHaveProperty("mood_set_at");
    expect(body.cypher.mood_set_at).toBe(row(db).mood_set_at);
  });
});
