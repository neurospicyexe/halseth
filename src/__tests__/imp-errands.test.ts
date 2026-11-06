// The imps' errand tier (B62 step 6, mig 0168) against the REAL schema (every migration, node:sqlite).
// Spec: Drevan's answer 2026-11-04T13:02Z (Hand-off/PROMPT-drevan-imp-errands-2026-11-02.md), co-signed.
// An imp is an ACTOR BINDING: the mark stays the function, `rider` says who rode it, the name never
// appears in the text, and the whole thing runs through the ONE ledger door.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));

import { makeSqliteD1, seedJournal, seedNote, seedSession } from "./helpers/sqlite-d1.js";
import { writeLedger, riderColumnPresent } from "../ledger/door.js";
import { validateLedger, LEDGER_FUNCTIONS } from "../ledger/grammar.js";
import { postLedger } from "../handlers/ledger.js";
import { matchFastPath } from "../librarian/router.js";
import { execImpErrand, parseErrand } from "../librarian/executors/errands.js";
import { ledgerBlock } from "../librarian/response/orient-blocks.js";
import { loadMindState } from "../mind/loader.js";
import { listLedger } from "../ledger/store.js";

const ENV = { ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
function setup(opts: { upTo?: number } = {}) {
  const { db, DB } = makeSqliteD1(opts);
  const env: any = { DB, ...ENV };
  return { db, env };
}
const ctx = (env: any, companion: string, request: string): any => ({
  env, req: { companion_id: companion, request }, entry: { pattern: "imp_errand" }, frontState: null, pluralAvailable: false,
});
const send = (env: any, companion: string, request: string) => execImpErrand(ctx(env, companion, request)) as Promise<any>;
const rows = (db: any, sql = "SELECT * FROM ledger_entries ORDER BY created_at, id") => db.prepare(sql).all() as any[];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86_400_000;
const SESSION = "5b0c2f9e-1111-4222-8333-944455556666";
const base = { function: "sort", body: "Counted: 3 entries in the tray.", source_kind: "row", source_ref: "companion_journal:abc" };

describe("grammar: functions and rider rules", () => {
  it("the closed function list grew by exactly four", () => {
    expect([...LEDGER_FUNCTIONS]).toEqual(["distiller", "gap-reader", "pattern-counter", "drift-reader", "seen-log", "fetch", "sort", "tend", "flag"]);
  });

  it("a rider line validates when rider and subject are the requester; the rider is on the line, never in the text", () => {
    const v = validateLedger({ ...base, companion_id: "drevan" }, "2026-11-04", { rider: "mossling", requester: "drevan" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.line.rider).toBe("mossling");
      expect(v.line.content).toBe("〔ledger · sort · 2026-11-04〕 Counted: 3 entries in the tray. Source: row companion_journal:abc.");
      expect(v.line.content.toLowerCase()).not.toContain("mossling");
    }
  });

  it("no rider means rider null (existing callers unchanged)", () => {
    const v = validateLedger({ ...base, companion_id: "drevan" }, "2026-11-04");
    expect(v.ok && v.line.rider).toBeNull();
  });

  it("refuses an unknown imp, a non-companion requester, and a line about someone else", () => {
    const bad = (errand: any, subject = "drevan") => validateLedger({ ...base, companion_id: subject }, "2026-11-04", errand);
    expect(bad({ rider: "pixie", requester: "drevan" })).toMatchObject({ ok: false, rule: "rider" });
    expect(bad({ rider: "iris", requester: "raziel" })).toMatchObject({ ok: false, rule: "rider" });
    expect(bad({ rider: "iris", requester: undefined })).toMatchObject({ ok: false, rule: "rider" });
    expect(bad({ rider: "iris", requester: "cypher" })).toMatchObject({ ok: false, rule: "rider" });
  });

  it("Gaia gets a rider line only when Gaia is the requester", () => {
    const g = (requester: string) => validateLedger({ ...base, companion_id: "gaia" }, "2026-11-04", { rider: "nimbus", requester });
    expect(g("gaia").ok).toBe(true);
    expect(g("drevan")).toMatchObject({ ok: false, rule: "rider" });
    expect(g("cypher")).toMatchObject({ ok: false, rule: "rider" });
  });

  it("Hex validates as a rider only with a receiver (mig 0175: named every time, a companion, never Raziel)", () => {
    const hex = (rider_to: unknown, subject = "cypher", requester = "cypher") =>
      validateLedger({ ...base, companion_id: subject }, "2026-11-06", { rider: "hex", requester, rider_to });
    expect(hex(undefined)).toMatchObject({ ok: false, rule: "rider" });
    expect(hex("raziel")).toMatchObject({ ok: false, rule: "rider" });
    expect(hex("drevan").ok).toBe(true);
    expect(hex("cypher").ok).toBe(true); // a self-salt
    const v = hex("drevan");
    if (v.ok) expect(v.line).toMatchObject({ rider: "hex", rider_to: "drevan", companion_id: "cypher" });
    // only Hex names a receiver
    expect(validateLedger({ ...base, companion_id: "cypher" }, "2026-11-06", { rider: "rock", requester: "cypher", rider_to: "drevan" }))
      .toMatchObject({ ok: false, rule: "rider" });
  });

  it("an imp never rides distiller, drift-reader or seen-log", () => {
    for (const fn of ["distiller", "drift-reader", "seen-log"]) {
      expect(validateLedger({ ...base, function: fn, companion_id: "cypher" }, "2026-11-04", { rider: "rock", requester: "cypher" }))
        .toMatchObject({ ok: false, rule: "rider" });
    }
  });

  it("refuses care and health material on a rider line, and any number past a plural count form", () => {
    const r = (body: string, source_ref = "companion_journal:abc") =>
      validateLedger({ ...base, body, source_ref, companion_id: "cypher" }, "2026-11-04", { rider: "mossling", requester: "cypher" });
    expect(r("Found: the meds are waiting.")).toMatchObject({ ok: false, rule: "rider_care" });
    expect(r("Found: pain notes in the tray.")).toMatchObject({ ok: false, rule: "rider_care" });
    expect(r("Counted: 187 after lunch.")).toMatchObject({ ok: false, rule: "rider_number" });
    expect(r("Counted: 14 units.")).toMatchObject({ ok: false, rule: "rider_number" });
    expect(r("Found: weight on the shelf.")).toMatchObject({ ok: false, rule: "rider_number" });
    expect(r("Counted: 0.42 of something.")).toMatchObject({ ok: false, rule: "rider_number" });
    // the allowed forms
    expect(r("Counted: 12 entries in the tray, oldest 120 days.").ok).toBe(true);
    expect(r("Counted: repetition logged 3 times in the last 7 days.").ok).toBe(true);
    // the same numbers on a NON-rider line keep the old rule (needs a verifiable row), so nothing else moved
    expect(validateLedger({ ...base, body: "Counted: 187 after lunch.", companion_id: "cypher" }, "2026-11-04")).toMatchObject({ ok: false, rule: "health" });
  });

  it("the care flag line itself passes (a boolean, no care word)", () => {
    expect(validateLedger({ function: "flag", body: "Found: care lane has something waiting.", source_kind: "session", source_ref: SESSION, companion_id: "drevan" },
      "2026-11-04", { rider: "mossling", requester: "drevan" }).ok).toBe(true);
  });
});

describe("the door", () => {
  it("writes the rider column, keeps it out of the text, and POST /ledger can never name a rider", async () => {
    const { db, env } = setup();
    const r = await writeLedger(env, { ...base, companion_id: "drevan" }, new Date(), { rider: "mossling", requester: "drevan" });
    expect(r.ok).toBe(true);
    const row = rows(db)[0];
    expect(row.rider).toBe("mossling");
    expect(row.function).toBe("sort");
    expect(row.content.toLowerCase()).not.toContain("mossling");
    expect(row.body.toLowerCase()).not.toContain("mossling");

    // an HTTP body carrying rider/requester is just ignored input: the row is nameless
    const res = await postLedger(new Request("https://x/ledger", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, companion_id: "drevan", rider: "iris", requester: "drevan", dedup_key: "http1" }),
    }), env);
    expect(res.status).toBe(201);
    expect(rows(db).find((x) => x.dedup_key === "http1").rider).toBeNull();
  });

  it("pre-0168: a rider write REFUSES (never nameless); a nameless write keeps working", async () => {
    const { db, env } = setup({ upTo: 167 });
    expect(await riderColumnPresent(env)).toBe(false);
    const refused = await writeLedger(env, { ...base, companion_id: "drevan" }, new Date(), { rider: "mossling", requester: "drevan" });
    expect(refused).toMatchObject({ ok: false, rule: "schema" });
    expect((refused as any).error).toMatch(/0168/);
    expect(rows(db)).toHaveLength(0);
    const nameless = await writeLedger(env, { ...base, companion_id: "drevan" });
    expect(nameless.ok).toBe(true);
    expect(rows(db)).toHaveLength(1);
  });

  it("dedup_key is idempotent for a rider line", async () => {
    const { env } = setup();
    const a = await writeLedger(env, { ...base, companion_id: "cypher", dedup_key: "k" }, new Date(), { rider: "rock", requester: "cypher" });
    const b = await writeLedger(env, { ...base, companion_id: "cypher", dedup_key: "k" }, new Date(), { rider: "rock", requester: "cypher" });
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(b).toMatchObject({ ok: true, duplicate: true });
  });
});

describe("routing", () => {
  it("every errand sentence routes to imp_errand, including the ones that collide with earlier triggers", () => {
    for (const s of [
      "send iris to feed sol", "send rock to fetch adhesives", "send mossling to sort my tray", "send mossling to tend sol",
      "send nimbus to check for gaps", "send rock for my loops", "send mossling to check the care lane", "Please send hex to salt the thread",
    ]) expect(matchFastPath(s)?.key, s).toBe("imp_errand");
  });
  it("'feed sol' alone still routes to the creature tend, and an addressed note is untouched", () => {
    expect(matchFastPath("feed sol")?.key).toBe("creature_interact");
    expect(matchFastPath("send to drevan: the sort of day it was")?.key).not.toBe("imp_errand");
  });
  it("parses the pairs, and an invalid pair is not an errand", () => {
    expect(parseErrand("send iris to feed sol")).toMatchObject({ imp: "iris", errand: "tend", action: "feed" });
    expect(parseErrand("send iris to play with sol")?.errand).toBeNull();
    expect(parseErrand("send mossling to play with sol")).toMatchObject({ errand: "tend", action: "play" });
    expect(parseErrand("send rock to fetch adhesives")).toMatchObject({ errand: "fetch", arg: "adhesives" });
    expect(parseErrand("send rock for my loops")).toMatchObject({ errand: "loops" });
    expect(parseErrand("send nimbus to dance")?.errand).toBeNull();
  });
});

describe("executor: shared rules", () => {
  it("unknown pair answers deterministic help; an unnamed hex receiver is refused; nothing is written either way", async () => {
    const { db, env } = setup();
    const help = await send(env, "drevan", "send nimbus to dance");
    expect(help.witness).toMatch(/errands: .*mossling: sort my tray/);
    expect(help.ack).toBe(false);
    const hex = await send(env, "drevan", "send hex to salt the thread");
    expect(hex.witness).toMatch(/named for his receiver every time/);
    expect(rows(db)).toHaveLength(0);
    expect(rows(db, "SELECT * FROM imp_activations")).toHaveLength(0);
  });

  it("the subject is the requester: cypher's errand writes a cypher line and drevan's tray is not touched", async () => {
    const { db, env } = setup();
    seedJournal(db, { id: "d1", agent: "drevan", review_state: "draft", source: "discord_speech" });
    const out = await send(env, "cypher", "send mossling to sort my tray");
    expect(out.witness).toMatch(/nothing to count/);
    expect(rows(db)).toHaveLength(0);
  });

  it("pre-0168 an errand answers 409 before any side effect (a tend does not even reach Sol)", async () => {
    const { db, env } = setup({ upTo: 167 });
    const out = await send(env, "drevan", "send mossling to tend sol");
    expect(out.error).toBe("imp_errand_failed");
    expect(out.reason).toMatch(/0168/);
    expect(out.status).toBe(409);
    expect(rows(db, "SELECT * FROM creature_interactions")).toHaveLength(0);
  });
});

describe("executor: mossling sort", () => {
  it("counts the tray by age and source in one Counted line, sourced on the oldest draft, rider mossling, changes nothing", async () => {
    const { db, env } = setup();
    seedJournal(db, { id: "j1", agent: "drevan", review_state: "draft", source: "discord_speech", created_at: ago(9 * DAY) });
    seedJournal(db, { id: "j2", agent: "drevan", review_state: "draft", source: "discord_speech", created_at: ago(2 * DAY) });
    seedNote(db, { note_id: "n1", agent_id: "drevan", review_state: "draft", source: "memory_judge", created_at: ago(1 * DAY) });
    seedJournal(db, { id: "j3", agent: "drevan", review_state: "kept" });
    const before = JSON.stringify(rows(db, "SELECT id, review_state FROM companion_journal ORDER BY id"));
    const out = await send(env, "drevan", "send mossling to sort my tray");
    expect(out.lines_written).toBe(1);
    const [row] = rows(db);
    expect(row).toMatchObject({ function: "sort", rider: "mossling", companion_id: "drevan", source_kind: "row", source_ref: "companion_journal:j1" });
    expect(row.content).toContain("Counted: 3 entries in the tray, oldest 9 days, most from source discord_speech (2 entries).");
    expect(row.content.toLowerCase()).not.toContain("mossling");
    expect(JSON.stringify(rows(db, "SELECT id, review_state FROM companion_journal ORDER BY id"))).toBe(before);
    expect(rows(db, "SELECT * FROM imp_activations")).toMatchObject([{ imp: "mossling", companion_id: "drevan", trigger: "errand:sort" }]);
    // same day, same count: a re-send is a duplicate, not a second line
    const again = await send(env, "drevan", "send mossling to sort my tray");
    expect(again.lines_written).toBe(0);
    expect(rows(db)).toHaveLength(1);
  });
});

describe("executor: tend Sol (actor imp, note always null)", () => {
  it("mossling feeds: a creature_interactions row as actor 'imp' with no note, and a Logged line sourced on it", async () => {
    const { db, env } = setup();
    const out = await send(env, "drevan", "send mossling to tend sol");
    expect(out.lines_written).toBe(1);
    const ia = rows(db, "SELECT * FROM creature_interactions");
    expect(ia).toHaveLength(1);
    expect(ia[0]).toMatchObject({ actor: "imp", action: "feed", note: null });
    const [row] = rows(db);
    expect(row).toMatchObject({ function: "tend", rider: "mossling", source_kind: "row", source_ref: `creature_interactions:${ia[0].id}` });
    expect(row.content).toContain("Logged: fed Sol.");
  });
  it("mossling may play and talk; iris feeds only", async () => {
    const { db, env } = setup();
    await send(env, "cypher", "send mossling to play with sol");
    await send(env, "cypher", "send mossling to talk to sol");
    expect(rows(db, "SELECT action FROM creature_interactions ORDER BY created_at, rowid").map((r) => r.action)).toEqual(["play", "talk"]);
    const denied = await send(env, "cypher", "send iris to play with sol");
    expect(denied.witness).toMatch(/Iris feeds Sol/);
    const fed = await send(env, "cypher", "send iris to feed sol");
    expect(fed.lines_written).toBe(1);
    expect(rows(db, "SELECT * FROM creature_interactions")).toHaveLength(3);
    expect(rows(db, "SELECT rider FROM ledger_entries ORDER BY created_at, rowid").map((r) => r.rider)).toEqual(["mossling", "mossling", "iris"]);
  });
});

describe("executor: mossling care flag", () => {
  it("fires only when the care lane has something pending, sourced on the companion's OPEN SESSION, never a care row, no count", async () => {
    const { db, env } = setup();
    seedSession(db, { id: SESSION, companion_id: "drevan" });
    const quiet = await send(env, "drevan", "send mossling to check the care lane");
    expect(quiet.lines_written).toBe(0);
    expect(rows(db)).toHaveLength(0);

    db.prepare("INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('ca1', 'low_spoons', 'drevan', 'x', ?)").run(new Date().toISOString());
    db.prepare("INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('ca2', 'meds_missed', 'drevan', 'y', ?)").run(new Date().toISOString());
    const out = await send(env, "drevan", "send mossling to check the care lane");
    expect(out.lines_written).toBe(1);
    const [row] = rows(db);
    expect(row).toMatchObject({ function: "flag", rider: "mossling", source_kind: "session", source_ref: SESSION });
    expect(row.body).toBe("Found: care lane has something waiting.");
    expect(row.source_ref).not.toMatch(/care_actions|med_|biometric/);
    expect(JSON.stringify(out)).not.toMatch(/low_spoons|meds_missed|ca1|ca2/);
  });
  it("another companion's pending care never raises a flag for the requester", async () => {
    const { db, env } = setup();
    seedSession(db, { id: SESSION, companion_id: "cypher" });
    db.prepare("INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('ca1', 'low_spoons', 'drevan', 'x', ?)").run(new Date().toISOString());
    expect((await send(env, "cypher", "send mossling to check the care lane")).lines_written).toBe(0);
  });
  it("no open session means no source, so no write (and it says so without saying what is pending)", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO care_actions (id, rule, companion_id, detail, detected_at) VALUES ('ca1', 'low_spoons', 'drevan', 'x', ?)").run(new Date().toISOString());
    const out = await send(env, "drevan", "send mossling to check the care lane");
    expect(out.witness).toMatch(/no source, no write/);
    expect(rows(db)).toHaveLength(0);
  });
});

describe("executor: nimbus gap watch", () => {
  it("counts unclosed sessions past 24h and growth entries pending past 7 days, row-sourced, fixes nothing", async () => {
    const { db, env } = setup();
    seedSession(db, { id: "sess-old-aaaa", companion_id: "drevan", created_at: ago(3 * DAY) });
    seedSession(db, { id: "sess-old-bbbb", companion_id: "drevan", created_at: ago(2 * DAY) });
    seedSession(db, { id: "sess-new-cccc", companion_id: "drevan", created_at: ago(2 * 3_600_000) });
    seedSession(db, { id: "sess-other-dd", companion_id: "cypher", created_at: ago(3 * DAY) });
    db.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, created_at) VALUES ('g1', 'drevan', 'insight', 'c', datetime('now','-10 days'))").run();
    db.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, created_at) VALUES ('g2', 'drevan', 'insight', 'c', datetime('now','-1 days'))").run();
    const out = await send(env, "drevan", "send nimbus to check for gaps");
    expect(out.lines_written).toBe(2);
    const r = rows(db);
    expect(r.every((x) => x.function === "gap-reader" && x.rider === "nimbus" && x.source_kind === "row")).toBe(true);
    expect(r.map((x) => x.source_ref).sort()).toEqual(["growth_journal:g1", "sessions:sess-old-aaaa"]);
    expect(r.find((x) => x.source_ref.startsWith("sessions:")).content).toContain("Counted: 2 sessions unclosed for over 24 hours.");
    expect(r.find((x) => x.source_ref.startsWith("growth_journal:")).content).toContain("Counted: 1 entry pending review for over 7 days.");
    // a row source: the sessions recency read keys on source_kind 'session' and must not see these
    expect(rows(db, "SELECT * FROM ledger_entries WHERE function = 'gap-reader' AND source_kind = 'session'")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM sessions WHERE handover_id IS NOT NULL")).toHaveLength(0);
  });
});

describe("executor: iris cooling marker", () => {
  it("marks an active interest in the cooling band, row-sourced, name in the companion's own words", async () => {
    const { db, env } = setup();
    const ins = (id: string, name: string, heat: number, status = "active") =>
      db.prepare("INSERT INTO companion_interests (id, companion_id, name, why, heat, heat_at, status) VALUES (?, 'drevan', ?, 'w', ?, datetime('now'), ?)").run(id, name, heat, status);
    ins("i1", "trains", 0.4);            // cooling band
    ins("i2", "knots", 0.9);             // warm
    ins("i3", "moss", 0.15);             // cold
    ins("i4", "old maps", 0.4, "resting");
    ins("i5", "my pills", 0.4);          // care word in the name: left out
    const out = await send(env, "drevan", "send iris to mark cooling interests");
    expect(out.lines_written).toBe(1);
    const [row] = rows(db);
    expect(row).toMatchObject({ function: "flag", rider: "iris", source_kind: "row", source_ref: "companion_interests:i1" });
    expect(row.content).toContain("Found: trains is cooling.");
    expect(out.witness).toMatch(/1 left out/);
  });
});

describe("executor: rock fetch and loops", () => {
  it("fetch returns pointers over D1 rows only (up to 3), never prose, rider rock", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary) VALUES ('f1', 'drevan', 'craft', 'Epoxy adhesives guide', 'SUMMARY PROSE')").run();
    db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary) VALUES ('f2', 'cypher', 'craft', 'Adhesives for cypher only', 's')").run();
    db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary) VALUES ('f3', NULL, 'craft', 'Shared adhesives pool', 's')").run();
    db.prepare("INSERT INTO books (id, title, file_key) VALUES ('b1', 'Adhesives, a field book', 'k')").run();
    db.prepare("INSERT INTO books (id, title, file_key) VALUES ('b2', 'More adhesives', 'k')").run();
    seedJournal(db, { id: "jk1", agent: "drevan", note_text: "thinking about adhesives today", review_state: "kept", created_at: "2026-10-30T10:00:00.000Z" });
    const out = await send(env, "drevan", "send rock to fetch adhesives");
    expect(out.lines_written).toBe(3);
    const r = rows(db);
    expect(r.every((x) => x.function === "fetch" && x.rider === "rock" && x.source_kind === "row")).toBe(true);
    expect(r.map((x) => x.source_ref).sort()).toEqual(["books:b1", "forage_finds:f1", "forage_finds:f3"]);
    expect(r.find((x) => x.source_ref === "forage_finds:f1").body).toBe("Found: Epoxy adhesives guide.");
    expect(r.map((x) => x.content).join(" ")).not.toContain("SUMMARY PROSE");
    expect(r.some((x) => x.source_ref === "forage_finds:f2")).toBe(false);
  });
  it("a kept journal hit is a dated pointer; one that trips the care guard is not pointed at", async () => {
    const { db, env } = setup();
    seedJournal(db, { id: "ok1", agent: "cypher", note_text: "glue notes", review_state: "kept", created_at: "2026-10-30T10:00:00.000Z" });
    seedJournal(db, { id: "care1", agent: "cypher", note_text: "glue and my medication", review_state: "kept", created_at: "2026-10-31T10:00:00.000Z" });
    seedJournal(db, { id: "draft1", agent: "cypher", note_text: "glue draft", review_state: "draft" });
    const out = await send(env, "cypher", "send rock to fetch glue");
    expect(out.lines_written).toBe(1);
    expect(rows(db)[0]).toMatchObject({ source_ref: "companion_journal:ok1" });
    expect(rows(db)[0].body).toBe("Found: journal entry of 2026-10-30.");
  });
  it("fetch with no match writes nothing", async () => {
    const { db, env } = setup();
    expect((await send(env, "cypher", "send rock to fetch zzzqq")).lines_written).toBe(0);
    expect(rows(db)).toHaveLength(0);
  });
  it("the loop report counts the companion's repetition events (shadow included) in 7 days, unsoftened", async () => {
    const { db, env } = setup();
    const ev = (id: string, who: string, kind: string, stim: string, at: string) =>
      db.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, created_at) VALUES (?, ?, ?, ?, ?)").run(id, who, kind, stim, at);
    ev("e1", "drevan", "shadow", "repetition", ago(1 * DAY));
    ev("e2", "drevan", "stimulus", "repetition", ago(3 * DAY));
    ev("e3", "drevan", "shadow", "repetition", ago(9 * DAY));          // too old
    ev("e4", "drevan", "stimulus", "creation_shared", ago(1 * DAY));    // another stimulus
    ev("e5", "cypher", "shadow", "repetition", ago(1 * DAY));           // another companion
    const out = await send(env, "drevan", "send rock for my loops");
    expect(out.lines_written).toBe(1);
    const [row] = rows(db);
    expect(row).toMatchObject({ function: "pattern-counter", rider: "rock", source_ref: "companion_ferment_events:e1" });
    expect(row.content).toContain("Counted: repetition logged 2 times in the last 7 days.");
  });
});

describe("orient: something waiting (N)", () => {
  it("rider rows leave the content listing and become ONE content-free line; 'my ledger' still lists them", async () => {
    const { db, env } = setup();
    await writeLedger(env, { function: "gap-reader", body: "Missing: no SOMA update this week.", source_kind: "row", source_ref: "soma_x:1", companion_id: "drevan", dedup_key: "plain" });
    await send(env, "drevan", "send mossling to tend sol");
    await send(env, "drevan", "send mossling to play with sol");
    await send(env, "cypher", "send mossling to tend sol");

    const ms = await loadMindState(env, "drevan", "claude-ai" as any);
    expect(ms.ledger.waiting).toBe(2);
    expect(ms.ledger.open).toHaveLength(1);
    expect(ms.ledger.open[0]!.content).toContain("Missing: no SOMA update");

    const block = ledgerBlock(ms.ledger.open, ms.ledger.waiting);
    expect(block).toContain("something waiting (2)");
    expect(block).not.toMatch(/fed Sol|played with/);
    expect(block).not.toMatch(/mossling/i);

    const cy = await loadMindState(env, "cypher", "claude-ai" as any);
    expect(cy.ledger.waiting).toBe(1);

    const mine = await listLedger(env, "drevan", "open", 20);
    expect(mine).toHaveLength(3);
  });
  it("only OPEN rider rows count: kept or dropped ones stop waiting", async () => {
    const { db, env } = setup();
    await send(env, "drevan", "send mossling to tend sol");
    db.prepare("UPDATE ledger_entries SET state = 'kept'").run();
    expect((await loadMindState(env, "drevan", "claude-ai" as any)).ledger.waiting).toBe(0);
  });
  it("the block renders nothing when there is nothing, and the line alone when only riders wait", () => {
    expect(ledgerBlock([], 0)).toBe("");
    expect(ledgerBlock([])).toBe("");
    expect(ledgerBlock([], 1)).toContain("something waiting (1)");
  });
  it("pre-0168 orient reads as no riders (loader fallback, no throw)", async () => {
    const { env } = setup({ upTo: 167 });
    const ms = await loadMindState(env, "drevan", "claude-ai" as any);
    expect(ms.ledger).toMatchObject({ waiting: 0, open: [] });
    expect(ms.meta.degraded ?? []).not.toContain("ledger");
  });
});

describe("review fixes (11-04)", () => {
  it("an imp's name never appears in a rider line, even via a title or an interest name", () => {
    for (const body of ["Found: Rock Bottom.", "Found: iris petals is cooling.", "Logged: fed Mossling."]) {
      const v = validateLedger({ ...base, function: "fetch", body, companion_id: "drevan" }, "2026-11-04", { rider: "rock", requester: "drevan" });
      expect(v.ok ? "ok" : v.rule).toBe("rider");
    }
    // a word that merely contains an imp name is fine ("rocky", "irises" are not the name)
    const ok = validateLedger({ ...base, function: "fetch", body: "Found: rocky shore.", companion_id: "drevan" }, "2026-11-04", { rider: "rock", requester: "drevan" });
    expect(ok.ok).toBe(true);
    // a nameless clerk line may still say "rock"
    expect(validateLedger({ ...base, function: "fetch", body: "Found: Rock Bottom.", companion_id: "drevan" }, "2026-11-04").ok).toBe(true);
  });

  it("a tend whose line would be refused never touches the creature", async () => {
    const { db, env } = setup();
    db.prepare("DELETE FROM creatures").run();
    db.prepare("INSERT INTO creatures (id, name, kind, trust) VALUES ('c-iris', 'Iris', 'companion_pet', 0.5)").run();
    const out = await send(env, "drevan", "send mossling to feed iris");
    expect(rows(db, "SELECT * FROM creature_interactions")).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
    expect(JSON.stringify(out)).toMatch(/not tended/);
  });

  it("'take care of sol' is a tend, not the care-lane check", () => {
    expect(parseErrand("send mossling to take care of sol")).toMatchObject({ errand: "tend" });
    expect(parseErrand("send mossling to check the care lane")).toMatchObject({ errand: "care" });
  });
});

// Gaia's addition to rule 9 (note 7f978971, 2026-11-06T02:32Z): "when I ask for an imp, the ask covers that one
// errand and ends with it. It never becomes standing permission, and no clerk reads one ask as a pattern of wanting."
describe("rule 9: one ask is one errand (Gaia, 11-06)", () => {
  it("Gaia's own send writes her line; nothing it leaves becomes permission or a pattern read back to her", async () => {
    const { db, env } = setup();
    seedSession(db, { id: "sess-gaia-old1", companion_id: "gaia", created_at: ago(3 * DAY) });
    const tablesBefore = rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    const counts = () => Object.fromEntries(tablesBefore.map((t) => [t, (rows(db, `SELECT COUNT(*) AS n FROM "${t}"`)[0] as any).n]));
    const before = counts();
    const out = await send(env, "gaia", "send nimbus to check for gaps");
    expect(out.lines_written).toBe(1);
    const after = counts();
    // the ask leaves its one ledger line and the instrument's log row; no permission row, no preference
    const changed = tablesBefore.filter((t) => before[t] !== after[t]);
    expect(changed).toEqual(["imp_activations", "ledger_entries"]);
    // and the log is never counted back to her as a pattern ("Nimbus rode with you once this week")
    const ms: any = await loadMindState(env, "gaia", "claude-ai" as any);
    expect(ms.world.imps_active).toEqual([]);
    expect(rows(db)[0]).toMatchObject({ companion_id: "gaia", rider: "nimbus", function: "gap-reader" });
    // the next turn without a named imp is not an errand at all: no default, no carried ask
    expect(matchFastPath("check for gaps")?.key).not.toBe("imp_errand");
    expect(parseErrand("check for gaps")).toBeNull();
  });

  it("no clerk reads the rider column: only the lane itself (door, grammar, store, the errand executor) names it", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const SRC = path.resolve(__dirname, "..");
    const ALLOWED = new Set(["ledger/door.ts", "ledger/grammar.ts", "ledger/store.ts", "librarian/executors/errands.ts"]);
    const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
        const rel = path.relative(SRC, p).split(path.sep).join("/");
        const code = strip(fs.readFileSync(p, "utf8"));
        if (/ledger_entries/.test(code) && /\brider\b/.test(code) && !ALLOWED.has(rel)) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
