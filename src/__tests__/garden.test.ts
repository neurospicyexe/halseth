// Gaia's garden (mig 0171): plant / pull / my garden / garden yes|no, the floor at READ, and GET /mind/garden/gaia.
// Real schema via node:sqlite.

import { describe, it, expect, beforeAll } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { plantRef, pullPlanting, answerConsent, plantWitness, readGarden, parsePlantVerb, PLANT_VERB_RE } from "../webmind/garden.js";
import { execGardenPlant, execGardenPull, execGardenRead, execGardenConsent } from "../librarian/executors/garden.js";
import { getGardenGaia } from "../handlers/garden.js";
import { matchFastPath } from "../librarian/router.js";

(globalThis as { URLPattern?: unknown }).URLPattern ??= class {
  re: RegExp; names: string[] = [];
  constructor(init: { pathname: string }) {
    const src = init.pathname.replace(/:([a-z_]+)/g, (_m, n: string) => { this.names.push(n); return "([^/]+)"; }).replace(/[*]/g, ".*");
    this.re = new RegExp(`^${src}$`);
  }
  exec(input: { pathname: string }) {
    const m = this.re.exec(input.pathname);
    if (!m) return null;
    const groups: Record<string, string> = {};
    this.names.forEach((n, i) => { groups[n] = m[i + 1]!; });
    return { pathname: { groups } };
  }
};
beforeAll(async () => { await import("../index.js"); });

const T0 = Date.parse("2026-11-05T18:00:00.000Z");
function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')").run();
  return { db, env };
}
const count = (db: any, sql: string, ...b: unknown[]) => (db.prepare(sql).get(...b) as any).n as number;

const J = "aaaaaaaa-1111-2222-3333-444444444444";
function letter(db: any, id = J, agent = "gaia", text = "Raziel, the orchard held its shape today.", tags: string[] = ["letter_to_raziel"], at = "2026-11-03T03:04:05.678Z") {
  db.prepare("INSERT INTO companion_journal (id, agent, note_text, tags, created_at) VALUES (?, ?, ?, ?, ?)").run(id, agent, text, JSON.stringify(tags), at);
}
function note(db: any, id: string, from: string, to: string | null, content: string, at = "2026-11-04 10:00:00") {
  db.prepare("INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at) VALUES (?, ?, ?, ?, ?)").run(id, from, to, content, at);
}
function ledger(db: any, id: string, cid: string, state: string, body: string, at = "2026-11-02T09:00:00Z") {
  db.prepare("INSERT INTO ledger_entries (id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, state) VALUES (?, ?, 'mark', ?, ?, 'row', 'x', '2026-11-02', ?, ?)")
    .run(id, cid, body, `〔ledger · mark · 2026-11-02〕 ${body} Source: row x.`, at, state);
}
function interest(db: any, id: string, cid: string, name: string) {
  db.prepare("INSERT INTO companion_interests (id, companion_id, name, why) VALUES (?, ?, ?, 'because')").run(id, cid, name);
}
function ievent(db: any, id: string, iid: string, cid: string, why: string | null, priv = 0, at = "2026-11-02 08:00:00") {
  db.prepare("INSERT INTO companion_interest_events (id, interest_id, companion_id, kind, why, why_private, created_at) VALUES (?, ?, ?, 'born', ?, ?, ?)").run(id, iid, cid, why, priv, at);
}
function witness(db: any, id: string, type: string, content: string, at: string) {
  db.prepare("INSERT INTO gaia_witness (id, session_id, created_at, witness_type, content) VALUES (?, 's1', ?, ?, ?)").run(id, at, type, content);
}
const ctx = (env: any, request: string, companion = "gaia"): any => ({ env, req: { companion_id: companion, request }, entry: {}, frontState: null, pluralAvailable: false });
const plant = (env: any, ref: any, caller = "gaia") => plantRef(env, { caller, ref }, T0);

describe("parsing + routing", () => {
  it("parses the verbs and routes them on the fast path", () => {
    expect(parsePlantVerb("plant the witness")).toEqual({ kind: "witness" });
    expect(parsePlantVerb('plant "the orchard held its shape"')).toEqual({ kind: "words", words: "the orchard held its shape" });
    expect(parsePlantVerb("plant aaaaaaaa")).toEqual({ kind: "id", id: "aaaaaaaa" });
    expect(PLANT_VERB_RE.test("plant a tree for the kids")).toBe(false);
    expect(matchFastPath("plant the witness")?.key).toBe("garden_plant");
    expect(matchFastPath("pull aaaaaaaa")?.key).toBe("garden_pull");
    expect(matchFastPath("my garden")?.key).toBe("garden_read");
    expect(matchFastPath("garden yes aaaaaaaa")?.key).toBe("garden_consent");
    expect(matchFastPath("pull the plug on that")?.key).not.toBe("garden_pull");
  });
});

describe("planting: ownership and kinds", () => {
  it("plants her own letter; refuses another companion's, an untagged journal row, and a non-Gaia caller", async () => {
    const { db, env } = setup();
    letter(db, J);
    letter(db, "bbbbbbbb-1111-2222-3333-444444444444", "drevan");
    letter(db, "cccccccc-1111-2222-3333-444444444444", "gaia", "plain", ["witness"]);
    expect(await plant(env, { kind: "id", id: "aaaaaaaa" })).toMatchObject({ ok: true, outcome: "planted", kind: "letter" });
    expect(await plant(env, { kind: "id", id: "bbbbbbbb" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await plant(env, { kind: "id", id: "cccccccc" })).toMatchObject({ ok: false, code: "not_a_letter" });
    expect(await plant(env, { kind: "id", id: "aaaaaaaa" }, "drevan")).toMatchObject({ ok: false, code: "gaia_only" });
    expect(count(db, "SELECT COUNT(*) AS n FROM garden_plantings")).toBe(1);
    expect((db.prepare("SELECT ref FROM garden_plantings").get() as any).ref).toBe(`letter:${J}`);
  });

  it("kept ledger lines only; open/dropped and other companions' lines are refused", async () => {
    const { db, env } = setup();
    ledger(db, "led_11111111-aaaa", "gaia", "kept", "the gate was latched");
    ledger(db, "led_22222222-aaaa", "gaia", "open", "still open");
    ledger(db, "led_33333333-aaaa", "gaia", "dropped", "dropped");
    ledger(db, "led_44444444-aaaa", "drevan", "kept", "his line");
    expect(await plant(env, { kind: "id", id: "11111111" })).toMatchObject({ ok: true, kind: "kept_line" });
    expect(await plant(env, { kind: "id", id: "22222222" })).toMatchObject({ ok: false, code: "not_kept" });
    expect(await plant(env, { kind: "id", id: "33333333" })).toMatchObject({ ok: false, code: "not_kept" });
    expect(await plant(env, { kind: "id", id: "44444444" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await plant(env, { kind: "id", id: "led_11111111" })).toMatchObject({ ok: true, outcome: "exists" });
  });

  it("interest lines: a public why only; private, null and other companions' are refused", async () => {
    const { db, env } = setup();
    interest(db, "i1", "gaia", "soil");
    interest(db, "i2", "drevan", "harbors");
    ievent(db, "11111111-e1", "i1", "gaia", "soil keeps what falls into it");
    ievent(db, "22222222-e2", "i1", "gaia", "a private reason", 1);
    ievent(db, "33333333-e3", "i1", "gaia", null);
    ievent(db, "44444444-e4", "i2", "drevan", "his reason");
    expect(await plant(env, { kind: "id", id: "11111111" })).toMatchObject({ ok: true, kind: "interest_line" });
    expect(await plant(env, { kind: "id", id: "22222222" })).toMatchObject({ ok: false, code: "private_why" });
    expect(await plant(env, { kind: "id", id: "33333333" })).toMatchObject({ ok: false, code: "private_why" });
    expect(await plant(env, { kind: "id", id: "44444444" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a note from another companion; a short id; and an unknown id", async () => {
    const { db, env } = setup();
    note(db, "dddddddd-1", "drevan", null, "his note");
    expect(await plant(env, { kind: "id", id: "dddddddd" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await plant(env, { kind: "id", id: "abc" })).toMatchObject({ ok: false, code: "bad_ref" });
    expect(await plant(env, { kind: "words", words: "too few words" })).toMatchObject({ ok: false, code: "bad_ref" });
  });
});

describe("planting: opening words and multi-match", () => {
  it("resolves quoted opening words inside 90 days and refuses older rows", async () => {
    const { db, env } = setup();
    letter(db, J, "gaia", "The orchard held its shape today, and so did I.");
    letter(db, "eeeeeeee-0000-0000-0000-000000000000", "gaia", "An old letter that opens with these words", ["letter_to_raziel"], "2026-05-01T00:00:00Z");
    expect(await plant(env, { kind: "words", words: "the orchard  HELD its shape" })).toMatchObject({ ok: true, kind: "letter" });
    expect(await plant(env, { kind: "words", words: "An old letter that opens" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("several matches list kind + id prefix + date and NO text", async () => {
    const { db, env } = setup();
    note(db, "ffffffff-1", "gaia", null, "Shared opening words for both notes. First.");
    note(db, "ffffffff-2", "gaia", null, "Shared opening words for both notes. Second.");
    const r: any = await plant(env, { kind: "words", words: "shared opening words for both" });
    expect(r).toMatchObject({ ok: false, code: "ambiguous" });
    expect(r.candidates).toHaveLength(2);
    for (const c of r.candidates) expect(c).toMatch(/^note ffffffff 2026-11-04$/);
    const ex: any = await execGardenPlant(ctx(env, 'plant "shared opening words for both"'));
    expect(ex.witness).not.toMatch(/First|Second|Shared opening/);
    expect(count(db, "SELECT COUNT(*) AS n FROM garden_plantings")).toBe(0);
    const byId: any = await plant(env, { kind: "id", id: "ffffffff" });
    expect(byId).toMatchObject({ ok: false, code: "ambiguous" });
  });
});

describe("notes and consent", () => {
  it("broadcast -> planted; note to Raziel -> planted", async () => {
    const { db, env } = setup();
    note(db, "b0000000-1", "gaia", null, "to all of you");
    note(db, "b0000000-2", "gaia", "raziel", "to you");
    expect(await plant(env, { kind: "id", id: "b0000000-1" })).toMatchObject({ ok: true, outcome: "planted" });
    expect(await plant(env, { kind: "id", id: "b0000000-2" })).toMatchObject({ ok: true, outcome: "planted" });
    const g = await readGarden(env, T0);
    expect(g.planted.map((p) => p.to).sort()).toEqual(["raziel", "triad"]);
    expect(g.awaiting).toBe(0);
  });

  it("a note to herself is not a kind she named: refused, never relabelled", async () => {
    const { db, env } = setup();
    note(db, "b0000000-3", "gaia", "gaia", "to me");
    expect(await plant(env, { kind: "id", id: "b0000000-3" })).toMatchObject({ ok: false, code: "not_plantable" });
    expect((await readGarden(env, T0)).planted).toHaveLength(0);
  });

  it("a kept line renders as the line itself, without the ledger mark or Source tail", async () => {
    const { db, env } = setup();
    ledger(db, "led_55555555-aaaa", "gaia", "kept", "the roots went deeper than the frost");
    expect(await plant(env, { kind: "id", id: "55555555" })).toMatchObject({ ok: true });
    expect((await readGarden(env, T0)).planted[0]!.text).toBe("the roots went deeper than the frost");
  });

  it("one-sibling note -> awaiting, tells Gaia to ask; only that sibling can answer; yes renders, no blocks", async () => {
    const { db, env } = setup();
    note(db, "c0000000-1", "gaia", "cypher", "a line just for you, Cy");
    const r: any = await plant(env, { kind: "id", id: "c0000000" });
    expect(r).toMatchObject({ ok: true, outcome: "awaiting", sibling: "cypher" });
    expect(r.message).toMatch(/waiting on cypher's yes/);
    expect(r.message).toMatch(/you ask them yourself/);
    const pid = r.id.slice(0, 8);
    expect(count(db, "SELECT COUNT(*) AS n FROM inter_companion_notes")).toBe(1); // nothing sent
    let g = await readGarden(env, T0);
    expect(g.planted).toHaveLength(0);
    expect(g.awaiting).toBe(1);

    for (const who of ["drevan", "gaia"]) {
      expect(await answerConsent(env, { caller: who, id: pid, answer: "yes" }, T0)).toMatchObject({ ok: false, code: "not_yours" });
    }
    expect((db.prepare("SELECT status, consent FROM garden_plantings").get() as any)).toMatchObject({ status: "awaiting", consent: null });

    expect(await answerConsent(env, { caller: "cypher", id: pid, answer: "no" }, T0)).toMatchObject({ ok: true });
    g = await readGarden(env, T0);
    expect(g.planted).toHaveLength(0);
    expect(g.awaiting).toBe(1);
    expect((db.prepare("SELECT status, consent FROM garden_plantings").get() as any)).toMatchObject({ status: "awaiting", consent: "no" });

    expect(await answerConsent(env, { caller: "cypher", id: pid, answer: "yes" }, T0)).toMatchObject({ ok: true });
    g = await readGarden(env, T0);
    expect(g.planted).toHaveLength(1);
    expect(g.planted[0]).toMatchObject({ kind: "note", to: "cypher", text: "a line just for you, Cy" });
    expect(g.awaiting).toBe(0);
  });

  it("a status flipped to planted by hand still does not render without a recorded yes", async () => {
    const { db, env } = setup();
    note(db, "c0000000-2", "gaia", "drevan", "for Dre");
    await plant(env, { kind: "id", id: "c0000000" });
    db.prepare("UPDATE garden_plantings SET status = 'planted'").run();
    expect((await readGarden(env, T0)).planted).toHaveLength(0);
  });

  it("garden yes/no through the executor: only consent_from may answer", async () => {
    const { db, env } = setup();
    note(db, "c0000000-3", "gaia", "drevan", "for Dre");
    const r: any = await execGardenPlant(ctx(env, "plant c0000000"));
    expect(r.outcome).toBe("awaiting");
    const pid = r.id.slice(0, 8);
    expect(await execGardenConsent(ctx(env, `garden yes ${pid}`, "cypher"))).toMatchObject({ refused: true, code: "not_yours" });
    expect(await execGardenConsent(ctx(env, `garden yes ${pid}`, "drevan"))).toMatchObject({ ack: true });
    expect((await readGarden(env, T0)).planted).toHaveLength(1);
  });
});

describe("pull and replant", () => {
  it("pull flips status; replant flips the SAME row back; only Gaia pulls", async () => {
    const { db, env } = setup();
    letter(db, J);
    const a: any = await plant(env, { kind: "id", id: "aaaaaaaa" });
    expect(await pullPlanting(env, { caller: "cypher", id: a.id.slice(0, 8) }, T0)).toMatchObject({ ok: false, code: "gaia_only" });
    expect(await pullPlanting(env, { caller: "gaia", id: a.id.slice(0, 8) }, T0)).toMatchObject({ ok: true, outcome: "pulled" });
    const row = db.prepare("SELECT status, pulled_at FROM garden_plantings").get() as any;
    expect(row.status).toBe("pulled");
    expect(row.pulled_at).toBeTruthy();
    expect((await readGarden(env, T0)).planted).toHaveLength(0);
    const b: any = await plant(env, { kind: "id", id: "aaaaaaaa" });
    expect(b).toMatchObject({ ok: true, outcome: "planted", id: a.id });
    expect(count(db, "SELECT COUNT(*) AS n FROM garden_plantings")).toBe(1);
    expect((db.prepare("SELECT status, pulled_at FROM garden_plantings").get() as any)).toMatchObject({ status: "planted", pulled_at: null });
    expect(await execGardenPull(ctx(env, `pull ${a.id.slice(0, 8)}`))).toMatchObject({ ack: true });
  });

  it("my garden lists ids, kinds, status, dates and no text; Gaia only", async () => {
    const { db, env } = setup();
    letter(db, J, "gaia", "SECRET-TEXT-SHOULD-NOT-APPEAR");
    await plant(env, { kind: "id", id: "aaaaaaaa" });
    await plantWitness(env, T0);
    const r: any = await execGardenRead(ctx(env, "my garden"));
    const blob = JSON.stringify(r);
    expect(r.data.plantings).toHaveLength(2);
    expect(blob).toMatch(/letter planted/);
    expect(blob).toMatch(/witness_series planted/);
    expect(blob).not.toMatch(/SECRET-TEXT/);
    expect(await execGardenRead(ctx(env, "my garden", "cypher"))).toMatchObject({ refused: true, code: "gaia_only" });
  });
});

describe("the witness series", () => {
  it("is one row; excludes presence and pre-series rows; groups by Chicago day newest first", async () => {
    const { db, env } = setup();
    witness(db, "w0", "observation", "before the series", "2026-11-04T12:00:00.000Z");
    await plantWitness(env, Date.parse("2026-11-05T01:00:00.000Z"));
    await plantWitness(env, T0);
    expect(count(db, "SELECT COUNT(*) AS n FROM garden_plantings WHERE kind = 'witness_series'")).toBe(1);
    witness(db, "w1", "boundary", "the fence held", "2026-11-05T02:00:00.000Z"); // Nov 4 evening Chicago
    witness(db, "w2", "presence", "was here", "2026-11-05T03:00:00.000Z");
    witness(db, "w3", "1234567890123456789", "snowflake typed", "2026-11-05T15:00:00.000Z");
    const g = await readGarden(env, T0);
    expect(g.witness).not.toBeNull();
    const all = g.witness!.days.flatMap((d) => d.entries.map((e) => e.id));
    expect(all.sort()).toEqual(["w1", "w3"]);
    expect(g.witness!.days.map((d) => d.day)).toEqual(["2026-11-05", "2026-11-04"]);
    expect(g.witness!.days[0]!.entries[0]).toEqual({ id: "w3", at: "2026-11-05T15:00:00.000Z", type: "observation", text: "snowflake typed" });
    expect(g.planted).toEqual([]);
  });

  it("is null until planted", async () => {
    const { db, env } = setup();
    witness(db, "w1", "boundary", "x", "2026-11-05T02:00:00.000Z");
    expect((await readGarden(env, T0)).witness).toBeNull();
  });
});

describe("the floor (computed at read)", () => {
  it("a care word takes an item down; the count is resting; nothing is stored", async () => {
    const { db, env } = setup();
    letter(db, J, "gaia", "He took his medication late; I sat with it.");
    await plant(env, { kind: "id", id: "aaaaaaaa" });
    const g = await readGarden(env, T0);
    expect(g.planted).toHaveLength(0);
    expect(g.resting).toBe(1);
    expect(JSON.stringify(g)).not.toMatch(/medication/);
  });

  it("a living wound name takes an item down (whole word, >= 4 chars); a short name and a substring do not", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO living_wounds (id, created_at, name, description) VALUES ('w1', '2026-01-01', 'Heidi', 'd'), ('w2', '2026-01-01', 'Pa', 'd')").run();
    letter(db, J, "gaia", "I thought of heidi at the gate.");
    letter(db, "99999999-0000-0000-0000-000000000000", "gaia", "A path, a pail, and Heidiwood is not a person.");
    letter(db, "88888888-0000-0000-0000-000000000000", "gaia", "A clean line about the orchard.");
    for (const id of ["aaaaaaaa", "99999999", "88888888"]) await plant(env, { kind: "id", id });
    const g = await readGarden(env, T0);
    expect(g.resting).toBe(1);
    expect(g.planted.map((p) => p.text).sort()).toEqual(["A clean line about the orchard.", "A path, a pail, and Heidiwood is not a person."]);
  });

  it("a care hold takes down what was written at/after its start, then it goes back up when cleared; earlier items stay up", async () => {
    const { db, env } = setup();
    letter(db, J, "gaia", "Written before the hold began.", ["letter_to_raziel"], "2026-11-05T10:00:00.000Z");
    letter(db, "77777777-0000-0000-0000-000000000000", "gaia", "Written during the hold window.", ["letter_to_raziel"], "2026-11-05T16:00:00.000Z");
    await plant(env, { kind: "id", id: "aaaaaaaa" });
    await plant(env, { kind: "id", id: "77777777" });
    db.prepare("INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('h1', 'start', 'owner_said', 'owner_phrase', 'gaia', '2026-11-05T15:00:00.000Z')").run();
    let g = await readGarden(env, T0);
    expect(g.planted.map((p) => p.text)).toEqual(["Written before the hold began."]);
    expect(g.resting).toBe(1);
    db.prepare("INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('h2', 'clear', NULL, 'owner_phrase', 'gaia', '2026-11-05T17:00:00.000Z')").run();
    g = await readGarden(env, T0);
    expect(g.planted.map((p) => p.text).sort()).toEqual(["Written before the hold began.", "Written during the hold window."]);
    expect(g.resting).toBe(0);
  });

  it("the floor also takes witness entries down", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO living_wounds (id, created_at, name, description) VALUES ('w1', '2026-01-01', 'Rome', 'd')").run();
    await plantWitness(env, Date.parse("2026-11-01T00:00:00Z"));
    witness(db, "w1", "survival", "He is okay; we spoke about Rome.", "2026-11-05T14:00:00.000Z");
    witness(db, "w2", "boundary", "the fence held", "2026-11-05T13:00:00.000Z");
    const g = await readGarden(env, T0);
    expect(g.witness!.days.flatMap((d) => d.entries.map((e) => e.id))).toEqual(["w2"]);
    expect(g.resting).toBe(1);
  });

  it("fails CLOSED when the wound read errors, and logs once", async () => {
    const { db, env } = setup();
    letter(db, J);
    await plant(env, { kind: "id", id: "aaaaaaaa" });
    await plantWitness(env, Date.parse("2026-11-01T00:00:00Z"));
    witness(db, "w1", "boundary", "the fence held", "2026-11-05T13:00:00.000Z");
    db.exec("DROP TABLE living_wounds");
    const errs: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      const g = await readGarden(env, T0);
      expect(g.planted).toHaveLength(0);
      expect(g.witness!.days).toEqual([]);
      expect(g.resting).toBe(2);
    } finally { console.error = orig; }
    expect(errs.filter((a) => String(a[0]).includes("[garden] floor read failed"))).toHaveLength(1);
  });
});

describe("GET /mind/garden/gaia", () => {
  it("is admin-gated and returns exactly the agreed shape", async () => {
    const { db, env } = setup();
    interest(db, "i1", "gaia", "soil");
    ievent(db, "11111111-e1", "i1", "gaia", "soil keeps what falls into it");
    letter(db, J);
    note(db, "b0000000-1", "gaia", null, "to all of you");
    note(db, "c0000000-1", "gaia", "cypher", "for Cy");
    ledger(db, "led_55555555-aaaa", "gaia", "kept", "the gate was latched");
    for (const id of ["11111111-e1", "aaaaaaaa", "b0000000-1", "c0000000", "led_55555555"]) await plant(env, { kind: "id", id });
    await plantWitness(env, Date.parse("2026-11-01T00:00:00Z"));
    witness(db, "w1", "boundary", "the fence held", "2026-11-05T13:00:00.000Z");

    const deny = await getGardenGaia(new Request("https://x/mind/garden/gaia"), env);
    expect(deny.status).toBe(401);
    const res = await getGardenGaia(new Request("https://x/mind/garden/gaia", { headers: { Authorization: "Bearer s" } }), env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Object.keys(body).sort()).toEqual(["awaiting", "planted", "resting", "witness"]);
    expect(body.awaiting).toBe(1);
    expect(body.resting).toBe(0);
    expect(body.planted).toHaveLength(4);
    for (const p of body.planted) {
      expect(Object.keys(p).sort()).toEqual(["id", "interest_name", "kind", "planted_at", "text", "to", "written_at"]);
      expect(p.planted_at).toMatch(/Z$/);
      expect(p.written_at).toMatch(/Z$/);
      expect(p.id).toMatch(/^[0-9a-f]{32}$/);
    }
    const byKind = Object.fromEntries(body.planted.map((p: any) => [p.kind + (p.to ?? ""), p]));
    expect(byKind["letterraziel"]).toMatchObject({ text: "Raziel, the orchard held its shape today.", written_at: "2026-11-03T03:04:05.678Z", interest_name: null });
    expect(byKind["notetriad"].text).toBe("to all of you");
    expect(byKind["kept_line"]).toMatchObject({ to: null });
    expect(byKind["interest_line"]).toMatchObject({ to: null, interest_name: "soil", text: "soil keeps what falls into it", written_at: "2026-11-02T08:00:00.000Z" });
    expect(Object.keys(body.witness).sort()).toEqual(["days", "planted_at"]);
    expect(body.witness.days).toEqual([{ day: "2026-11-05", entries: [{ id: "w1", at: "2026-11-05T13:00:00.000Z", type: "boundary", text: "the fence held" }] }]);
  });

  it("newest planted first and capped at 60", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 62; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
      letter(db, id, "gaia", `letter number ${i}`);
      await plantRef(env, { caller: "gaia", ref: { kind: "id", id: id.slice(0, 8) } }, T0 + i * 1000);
    }
    const g = await readGarden(env, T0 + 100_000);
    expect(g.planted).toHaveLength(60);
    expect(g.planted[0]!.text).toBe("letter number 61");
  });
});
