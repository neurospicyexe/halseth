// B63: forage_cross_domain (interest events) and intellectual_reward (Cypher's answered questions).
// Real schema via node:sqlite; LOOP_STIMULI_MODE unset = shadow, so a "fire" is a kind='shadow' row.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { applyInterestAction } from "../handlers/interests.js";
import { patchQuestion } from "../handlers/companion-questions.js";
import { fireForageCross, fireIntellectualReward } from "../webmind/loop-stimuli.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-02T12:00:00.000Z");

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  return { db, env };
}
const find = (db: any, id: string, domain: string) =>
  db.prepare("INSERT INTO forage_finds (id, domain, title, summary) VALUES (?, ?, 't', 's')").run(id, domain);
const born = (env: any, companion: string, ref: string | null, now = T0) =>
  applyInterestAction(env, { companion_id: companion, action: "born", name: "rivers", why: "w", ref } as any, now);
const fed = (env: any, companion: string, ref: string | null, now: number) =>
  applyInterestAction(env, { companion_id: companion, action: "returned", name: "rivers", why: "w", ref } as any, now);
const fires = (db: any, stim: string, c?: string) =>
  db.prepare(`SELECT * FROM companion_ferment_events WHERE stimulus = ?${c ? " AND companion_id = ?" : ""}`).all(...(c ? [stim, c] : [stim]));

describe("forage_cross_domain", () => {
  it("fires in shadow for a new-domain find fed to an interest that already has an event; cause is the event id", async () => {
    const { db, env } = setup();
    find(db, "f1", "geology"); find(db, "f2", "poetry");
    await born(env, "drevan", "f1");
    expect(fires(db, "forage_cross_domain")).toHaveLength(0); // first feed is never cross
    const r: any = await fed(env, "drevan", "f2", T0 + 2 * DAY);
    const rows = fires(db, "forage_cross_domain", "drevan");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("shadow");
    expect(rows[0].detail).toContain(r.event.id);
  });
  it("fires for cypher too; never for gaia", async () => {
    const { db, env } = setup();
    find(db, "f1", "geology"); find(db, "f2", "poetry");
    await born(env, "cypher", "f1"); await fed(env, "cypher", "f2", T0 + DAY);
    await born(env, "gaia", "f1"); await fed(env, "gaia", "f2", T0 + DAY);
    expect(fires(db, "forage_cross_domain", "cypher")).toHaveLength(1);
    expect(fires(db, "forage_cross_domain", "gaia")).toHaveLength(0);
  });
  it("does not fire on the first feed, a same-domain find, a non-forage ref, or no ref", async () => {
    const { db, env } = setup();
    find(db, "f1", "geology"); find(db, "f3", "geology");
    await born(env, "drevan", "f1");
    await fed(env, "drevan", "f3", T0 + 2 * DAY);   // same domain as an earlier event's find
    await fed(env, "drevan", "some-make-id", T0 + 3 * DAY); // not a forage id
    await fed(env, "drevan", null, T0 + 4 * DAY);
    expect(fires(db, "forage_cross_domain")).toHaveLength(0);
  });
  it("an interest never fed by a find has no domain to cross from: its first find is a first feed", async () => {
    const { db, env } = setup();
    find(db, "f2", "poetry");
    await born(env, "drevan", "a-make-id");
    await fed(env, "drevan", "f2", T0 + 2 * DAY);
    expect(fires(db, "forage_cross_domain")).toHaveLength(0);
  });
  it("one fire per interest per day", async () => {
    const { db, env } = setup();
    find(db, "f1", "geology"); find(db, "f2", "poetry"); find(db, "f4", "music");
    await born(env, "drevan", "f1");
    await fed(env, "drevan", "f2", T0 + DAY);
    await fed(env, "drevan", "f4", T0 + 2 * DAY);
    expect(fires(db, "forage_cross_domain", "drevan")).toHaveLength(1);
  });
  it("never fails the parent act when the fire path throws", async () => {
    const { db, env } = setup();
    find(db, "f1", "geology"); find(db, "f2", "poetry");
    await born(env, "drevan", "f1");
    db.exec("DROP TABLE companion_ferment_events");
    const r: any = await fed(env, "drevan", "f2", T0 + DAY);
    expect(r.ok).toBe(true);
    expect(await fireForageCross(env, "drevan", "i", "e", "f2")).toBe(false);
  });
});

describe("intellectual_reward", () => {
  const q = (db: any, id: string, companion: string) =>
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status) VALUES (?, ?, 'q?', 'open')").run(id, companion);
  const patch = (env: any, id: string, body: unknown) =>
    patchQuestion(new Request(`http://x/mind/questions/${id}`, {
      method: "PATCH", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, { id });

  it("fires in shadow when Cypher's open question is answered with text; question id is the cause", async () => {
    const { db, env } = setup();
    q(db, "q1", "cypher");
    expect((await patch(env, "q1", { status: "answered", answer: "here is why" })).status).toBe(200);
    const rows = fires(db, "intellectual_reward");
    expect(rows).toHaveLength(1);
    expect(rows[0].companion_id).toBe("cypher");
    expect(rows[0].kind).toBe("shadow");
    expect(rows[0].detail).toContain("q1");
  });
  it("does not fire for another asker, a dismissal, or a blank answer", async () => {
    const { db, env } = setup();
    q(db, "q2", "drevan"); q(db, "q3", "cypher"); q(db, "q4", "cypher");
    await patch(env, "q2", { status: "answered", answer: "yes" });
    await patch(env, "q3", { status: "dismissed", answer: "no" });
    await patch(env, "q4", { status: "answered", answer: "   " });
    expect(fires(db, "intellectual_reward")).toHaveLength(0);
  });
  it("a repeat save is a 404 and does not fire again", async () => {
    const { db, env } = setup();
    q(db, "q5", "cypher");
    await patch(env, "q5", { status: "answered", answer: "a" });
    expect((await patch(env, "q5", { status: "answered", answer: "b" })).status).toBe(404);
    expect(fires(db, "intellectual_reward")).toHaveLength(1);
  });
  it("the parent request still succeeds if the fire throws", async () => {
    const { db, env } = setup();
    q(db, "q6", "cypher");
    db.exec("DROP TABLE companion_ferment_events");
    expect((await patch(env, "q6", { status: "answered", answer: "a" })).status).toBe(200);
    expect(await fireIntellectualReward(env, "cypher", "q6", "a")).toBe(false);
  });
});
