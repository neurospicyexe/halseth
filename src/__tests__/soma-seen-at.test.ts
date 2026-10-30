// /soma seen_at: when a companion last showed up by their own act (mood set, journal entry, session
// close). Never updated_at -- the ferment cron moves that hourly, so "seen" would always read "now".
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getSoma } from "../handlers/soma.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  for (const c of ["cypher", "drevan", "gaia"]) {
    db.prepare("INSERT OR REPLACE INTO companion_state (companion_id, updated_at, mood_set_at) VALUES (?, '2026-10-30T12:00:00.000Z', NULL)").run(c);
  }
  const soma = async () =>
    (await (await getSoma(new Request("https://x/soma", { headers: { Authorization: "Bearer s" } }), env)).json()) as any;
  return { db, soma };
}

describe("/soma seen_at", () => {
  it("is null when the companion has done nothing (never falls back to updated_at)", async () => {
    const { soma } = setup();
    expect((await soma()).cypher.seen_at).toBeNull();
  });

  it("is the latest of mood_set_at, the companion's own journal entry and their session close", async () => {
    const { db, soma } = setup();
    db.prepare("UPDATE companion_state SET mood_set_at = '2026-10-28T10:00:00.000Z' WHERE companion_id = 'cypher'").run();
    db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text) VALUES ('j1', '2026-10-29T09:00:00.000Z', 'cypher', 'x')").run();
    db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text) VALUES ('j2', '2026-10-30T11:00:00.000Z', 'drevan', 'y')").run();
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, companion_id) VALUES ('s1', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z', 'gaia')").run();
    // sqlite datetime format on purpose: the max must compare instants, not strings
    db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, last_real_thing, motion_state) VALUES ('h1', 's1', '2026-10-29 23:30:00', 'sp', 'lrt', 'at_rest')").run();
    const body = await soma();
    expect(body.cypher.seen_at).toBe("2026-10-29T09:00:00.000Z");
    expect(body.drevan.seen_at).toBe("2026-10-30T11:00:00.000Z");
    expect(body.gaia.seen_at).toBe("2026-10-29T23:30:00.000Z");
  });

  it("compares instants across formats (a later sqlite-format close beats an earlier ISO mood)", async () => {
    const { db, soma } = setup();
    db.prepare("UPDATE companion_state SET mood_set_at = '2026-10-30T08:00:00.000Z' WHERE companion_id = 'cypher'").run();
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, companion_id) VALUES ('s2', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z', 'cypher')").run();
    db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, last_real_thing, motion_state) VALUES ('h2', 's2', '2026-10-30 09:00:00', 'sp', 'lrt', 'at_rest')").run();
    expect((await soma()).cypher.seen_at).toBe("2026-10-30T09:00:00.000Z");
  });
});
