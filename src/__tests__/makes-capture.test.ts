// Drevan's shelf (mig 0170): captureWriting, the gated forward capture of letters and night explorations,
// and the `keep as made` verb. Real schema via node:sqlite; R2 is an in-memory fake.

import { describe, it, expect, beforeAll } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { listMakes, createMake } from "../handlers/makes.js";
import { applyInterestAction } from "../handlers/interests.js";
import {
  captureWriting, captureLetter, captureExploration, captureGate, keepAsMade, parseKeepVerb, originKind,
  normalizeCreatedAt, explorationTitle, letterTitle,
} from "../webmind/makes-capture.js";
import { execMakeKeep } from "../librarian/executors/makes.js";
import { matchFastPath } from "../librarian/router.js";

// router.ts builds nothing at load, but index.ts (imported transitively by some paths) needs URLPattern.
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

class FakeBucket {
  store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    this.store.set(key, { bytes: new Uint8Array(value), contentType: opts?.httpMetadata?.contentType });
    return {};
  }
}
function setup(extra: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const bucket = new FakeBucket();
  const env: any = { DB, BUCKET: bucket, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...extra };
  return { db, env, bucket };
}
const T0 = Date.parse("2026-11-05T12:00:00.000Z");
const count = (db: any, sql: string, ...b: unknown[]) => (db.prepare(sql).get(...b) as any).n as number;

function seedJournal(db: any, id: string, agent: string, text: string, tags: string[] = [], created = "2026-11-03T03:04:05.678Z") {
  db.prepare("INSERT INTO companion_journal (id, agent, note_text, tags, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, agent, text, JSON.stringify(tags), created);
}
function seedGrowth(db: any, id: string, cid: string, content: string, over: { entry_type?: string; source?: string } = {}) {
  db.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, source) VALUES (?, ?, ?, ?, ?)")
    .run(id, cid, over.entry_type ?? "insight", content, over.source ?? "autonomous");
}
function seedNote(db: any, id: string, from: string, content: string, created = "2026-11-04 10:00:00") {
  db.prepare("INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at) VALUES (?, ?, 'cypher', ?, ?)").run(id, from, content, created);
}

describe("captureWriting", () => {
  it("creates a ready writing with R2 source, the ORIGINAL created_at in sqlite shape, and is idempotent on origin", async () => {
    const { db, env, bucket } = setup();
    const a = await captureWriting(env, { companion_id: "drevan", origin: "letter:j1", title: "Letter to Raziel, Nov 2", text: "dear you", created_at: "2026-11-03T03:04:05.678Z" }, T0);
    expect(a).toMatchObject({ ok: true, outcome: "created" });
    const row = db.prepare("SELECT * FROM companion_makes WHERE origin = 'letter:j1'").get() as any;
    expect(row).toMatchObject({ kind: "writing", status: "ready", created_at: "2026-11-03 03:04:05", companion_id: "drevan" });
    expect(bucket.store.get(row.source_key)!.bytes.byteLength).toBe(8);
    const b = await captureWriting(env, { companion_id: "drevan", origin: "letter:j1", title: "x", text: "changed", created_at: null }, T0);
    expect(b).toMatchObject({ ok: true, outcome: "exists", id: (a as any).id });
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_makes")).toBe(1);
  });

  it("sqlite-shaped source timestamps pass through unchanged", () => {
    expect(normalizeCreatedAt("2026-11-04 10:00:00")).toBe("2026-11-04 10:00:00");
    expect(normalizeCreatedAt("2026-11-04T10:00:00Z")).toBe("2026-11-04 10:00:00");
  });

  it("spends no daily cap and fires no stimulus", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 12; i++) {
      const r = await createMake(env, { companion_id: "drevan", kind: "writing", title: `t${i}`, source: "x" }, T0);
      expect(r.ok).toBe(true);
    }
    expect((await createMake(env, { companion_id: "drevan", kind: "writing", title: "over", source: "x" }, T0)) as any).toMatchObject({ ok: false, code: "daily_cap" });
    const before = count(db, "SELECT COUNT(*) AS n FROM companion_ferment_events");
    const r = await captureWriting(env, { companion_id: "drevan", origin: "growth:g1", title: "t", text: "words", created_at: "2026-11-05 12:00:00" }, T0);
    expect(r).toMatchObject({ ok: true, outcome: "created" });
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_ferment_events")).toBe(before);
  });

  it("refuses gaia", async () => {
    const { db, env } = setup();
    expect(await captureWriting(env, { companion_id: "gaia", origin: "note:n1", title: "t", text: "x", created_at: null }))
      .toEqual({ ok: false, outcome: "refused", reason: "gaia_keeps_lines" });
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_makes")).toBe(0);
  });

  it("an interest resolves only by exact name; a hit writes the made event with ref make:<id>; a miss is no interest", async () => {
    const { db, env } = setup();
    await applyInterestAction(env, { companion_id: "drevan", action: "born", name: "Trains", why: "the hum" } as any, T0);
    const miss = await captureWriting(env, { companion_id: "drevan", origin: "journal:a", title: "t", text: "rails", created_at: null, interest_name: "Train", why: "w" }, T0);
    expect((db.prepare("SELECT interest_id FROM companion_makes WHERE id = ?").get((miss as any).id) as any).interest_id).toBeNull();
    const hit = await captureWriting(env, { companion_id: "drevan", origin: "journal:b", title: "t", text: "rails", created_at: null, interest_name: "trains", why: "it hums" }, T0);
    expect((db.prepare("SELECT interest_id FROM companion_makes WHERE id = ?").get((hit as any).id) as any).interest_id).toBeTruthy();
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_interest_events WHERE kind = 'made' AND ref = ?", `make:${(hit as any).id}`)).toBe(1);
    const noWhy = await captureWriting(env, { companion_id: "drevan", origin: "journal:c", title: "t", text: "rails", created_at: null, interest_name: "Trains" }, T0);
    expect(noWhy).toMatchObject({ ok: false, reason: "why_required" });
  });
});

describe("forward capture gate", () => {
  it("MAKES_CAPTURE: unset = drevan, off = none, list", () => {
    expect([...captureGate({})]).toEqual(["drevan"]);
    expect(captureGate({ MAKES_CAPTURE: "off" }).size).toBe(0);
    expect([...captureGate({ MAKES_CAPTURE: "drevan, cypher" })].sort()).toEqual(["cypher", "drevan"]);
  });

  const letter = (agent: string, tags: string[]) => ({ id: "j" + agent + tags.join(""), agent, tags: JSON.stringify(tags), note_text: "dear raziel", created_at: "2026-11-05T01:00:00.000Z" });

  it("captures drevan's letter with a Chicago-dated title; cypher is outside the default gate", async () => {
    const { db, env } = setup();
    await captureLetter(env, letter("drevan", ["metronome", "letter_to_raziel"]));
    await captureLetter(env, letter("cypher", ["letter_to_raziel"]));
    const rows = db.prepare("SELECT companion_id, title, origin FROM companion_makes").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companion_id: "drevan", title: "Letter to Raziel, Nov 4" }); // 01:00Z is Nov 4 evening in Chicago
    expect(rows[0].origin).toMatch(/^letter:/);
  });

  it("gate off captures nothing", async () => {
    const { db, env } = setup({ MAKES_CAPTURE: "off" });
    await captureLetter(env, letter("drevan", ["letter_to_raziel"]));
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_makes")).toBe(0);
  });

  it("guardian / steward / gaia letters and machine tags are never captured", async () => {
    const { db, env } = setup({ MAKES_CAPTURE: "drevan,cypher,gaia,guardian,steward" });
    await captureLetter(env, letter("guardian", ["guardian", "letter_to_raziel"]));
    await captureLetter(env, letter("steward", ["briefing", "letter_to_raziel"]));
    await captureLetter(env, letter("gaia", ["vibecheck", "letter_to_raziel"]));
    await captureLetter(env, letter("drevan", ["drift_floor", "letter_to_raziel"]));
    await captureLetter(env, letter("drevan", ["clearing", "letter_to_raziel"]));
    await captureLetter(env, letter("drevan", ["note"]));
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_makes")).toBe(0);
  });

  it("a capture failure never throws", async () => {
    const { env } = setup();
    env.DB = { prepare: () => { throw new Error("boom"); } };
    await expect(captureLetter(env, letter("drevan", ["letter_to_raziel"]))).resolves.toBeUndefined();
  });

  it("night exploration: autonomous insight only; heading or short first line is the title", async () => {
    const { db, env } = setup();
    seedGrowth(db, "g1", "drevan", "## What the tide keeps\n\nbody");
    await captureExploration(env, { id: "g1", companion_id: "drevan", entry_type: "insight", source: "autonomous", content: "## What the tide keeps\n\nbody" });
    await captureExploration(env, { id: "g2", companion_id: "drevan", entry_type: "learning", source: "autonomous", content: "x" });
    await captureExploration(env, { id: "g3", companion_id: "drevan", entry_type: "insight", source: "conversation", content: "x" });
    const rows = db.prepare("SELECT title, origin FROM companion_makes").all() as any[];
    expect(rows.map((r) => ({ ...r }))).toEqual([{ title: "What the tide keeps", origin: "growth:g1" }]);
    expect(explorationTitle("A long first sentence that ends with a period.\nmore", "2026-11-05T18:00:00Z")).toBe("Night exploration, Nov 5");
    expect(explorationTitle("**Short line**\nmore", null)).toBe("Short line");
    expect(letterTitle("2026-11-05T18:00:00Z")).toBe("Letter to Raziel, Nov 5");
  });
});

describe("keep as made", () => {
  it("parses refs, title, interest, why", () => {
    expect(parseKeepVerb("keep as made abcdef12-3456 called My Poem for Trains because it hums")).toMatchObject({
      ref: { kind: "id", id: "abcdef12-3456" }, title: "My Poem for Trains", title_before_for: "My Poem", interest_candidate: "Trains", why: "it hums",
    });
    expect(parseKeepVerb('keep as made "the tide keeps what the moon lets go" called Tide')).toMatchObject({ ref: { kind: "words" }, title: "Tide" });
    expect(parseKeepVerb("keep this as made")!.ref).toEqual({ kind: "this" });
    expect(matchFastPath('keep as made "the tide keeps what the moon lets go"')!.key).toBe("make_keep");
    expect(matchFastPath("keep this as made")!.key).toBe("make_keep");
  });

  it("captures an own journal row by id prefix, keeping its original date; letters use the letter origin and title", async () => {
    const { db, env } = setup();
    seedJournal(db, "deadbeef-0000-0000-0000-000000000001", "drevan", "dear raziel, rain", ["letter_to_raziel"]);
    const r = await keepAsMade(env, { companion_id: "drevan", ref: { kind: "id", id: "deadbeef" } }, T0);
    expect(r).toMatchObject({ ok: true, outcome: "created", title: "Letter to Raziel, Nov 2" });
    const again = await keepAsMade(env, { companion_id: "drevan", ref: { kind: "id", id: "deadbeef-0000" } }, T0);
    expect(again).toMatchObject({ ok: true, outcome: "exists", id: (r as any).id });
    const row = db.prepare("SELECT origin, created_at FROM companion_makes").get() as any;
    expect({ ...row }).toEqual({ origin: "letter:deadbeef-0000-0000-0000-000000000001", created_at: "2026-11-03 03:04:05" });
  });

  it("OWNERSHIP: another companion's row is never reachable, by id or by words", async () => {
    const { db, env } = setup();
    seedJournal(db, "cafef00d-0000-0000-0000-000000000002", "cypher", "the tide keeps what the moon lets go");
    seedGrowth(db, "feedface-0000", "cypher", "something cypher explored tonight");
    seedNote(db, "0badc0de-0000", "cypher", "a position note from cypher here");
    for (const ref of [{ kind: "id" as const, id: "cafef00d" }, { kind: "id" as const, id: "feedface" }, { kind: "id" as const, id: "0badc0de" },
      { kind: "words" as const, words: "the tide keeps what the moon" }]) {
      const r = await keepAsMade(env, { companion_id: "drevan", ref }, T0);
      expect(r, JSON.stringify(ref)).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(count(db, "SELECT COUNT(*) AS n FROM companion_makes")).toBe(0);
  });

  it("quoted opening words: one match captures; several return candidates with NO text; none says so; 60-day window", async () => {
    const { db, env } = setup();
    seedJournal(db, "aaaaaaaa-1", "drevan", "The tide   keeps what the moon lets go, always.", [], "2026-10-20T00:00:00Z");
    seedNote(db, "bbbbbbbb-2", "drevan", "Position: the harbor is a verb, not a place");
    const one = await keepAsMade(env, { companion_id: "drevan", ref: { kind: "words", words: "the tide keeps what the moon" } }, T0);
    expect(one).toMatchObject({ ok: true, outcome: "created" });
    seedJournal(db, "cccccccc-3", "drevan", "Position: the harbor is a verb, not a place either", [], "2026-11-01T00:00:00Z");
    const many: any = await keepAsMade(env, { companion_id: "drevan", ref: { kind: "words", words: "position: the harbor is a verb" } }, T0);
    expect(many).toMatchObject({ ok: false, code: "ambiguous" });
    expect(many.candidates).toHaveLength(2);
    expect(JSON.stringify(many)).not.toMatch(/harbor|verb|tide/i);
    expect(many.candidates[0]).toMatch(/^(journal|note) [0-9a-f]{8} \d{4}-\d{2}-\d{2}$/);
    const none = await keepAsMade(env, { companion_id: "drevan", ref: { kind: "words", words: "nothing here matches at all" } }, T0);
    expect(none).toMatchObject({ ok: false, code: "not_found" });
    seedJournal(db, "dddddddd-4", "drevan", "an ancient line from long ago in the archive", [], "2026-01-01T00:00:00Z");
    expect(await keepAsMade(env, { companion_id: "drevan", ref: { kind: "words", words: "an ancient line from long" } }, T0)).toMatchObject({ ok: false, code: "not_found" });
    expect(await keepAsMade(env, { companion_id: "drevan", ref: { kind: "words", words: "three short words" } }, T0)).toMatchObject({ ok: false, code: "bad_ref" });
  });

  it("refuses care/health-tagged and machine-tagged journal rows; gaia refused", async () => {
    const { db, env } = setup();
    seedJournal(db, "11111111-a", "drevan", "meds log", ["care"]);
    seedJournal(db, "22222222-b", "drevan", "a drift note", ["drift_floor"]);
    seedJournal(db, "33333333-c", "drevan", "bad night", ["bad night"]);
    expect(await keepAsMade(env, { companion_id: "drevan", ref: { kind: "id", id: "11111111" } })).toMatchObject({ ok: false });
    expect(await keepAsMade(env, { companion_id: "drevan", ref: { kind: "id", id: "22222222" } })).toMatchObject({ ok: false, code: "machine_or_private_tag" });
    expect(await keepAsMade(env, { companion_id: "drevan", ref: { kind: "id", id: "33333333" } })).toMatchObject({ ok: false, code: "care_or_health_tag" });
    expect(await keepAsMade(env, { companion_id: "gaia", ref: { kind: "id", id: "11111111" } })).toMatchObject({ ok: false, code: "gaia_keeps_lines" });
  });

  it("the executor: caller identity from the request, interest only when it is theirs, shelf carries origin_kind", async () => {
    const { db, env } = setup();
    await applyInterestAction(env, { companion_id: "drevan", action: "born", name: "Harbors", why: "doors" } as any, T0);
    seedNote(db, "eeeeeeee-5", "drevan", "Position: a harbor is a verb");
    seedGrowth(db, "ffffffff-6", "drevan", "Why the lamp matters\nbody text");
    const ctx = (request: string, companion = "drevan", context?: unknown): any => ({
      env, req: { companion_id: companion, request, context: context === undefined ? undefined : JSON.stringify(context) },
      entry: {}, frontState: null, pluralAvailable: false,
    });
    const r: any = await execMakeKeep(ctx("keep as made eeeeeeee called Harbor Note for Harbors because it names the door"));
    expect(r).toMatchObject({ ack: true, title: "Harbor Note", existed: false });
    const again: any = await execMakeKeep(ctx("keep as made eeeeeeee"));
    expect(again).toMatchObject({ ack: true, existed: true });
    expect(await execMakeKeep(ctx("keep as made ffffffff", "cypher"))).toMatchObject({ refused: true, code: "not_found" });
    await execMakeKeep(ctx("keep this as made", "drevan", { ref: "ffffffff" }));
    const shelf = await listMakes(env, "drevan", { limit: 10 });
    expect(shelf.map((m) => [m.title, m.origin_kind]).sort()).toEqual([["Harbor Note", "kept"], ["Why the lamp matters", "exploration"]]);
    expect(shelf.find((m) => m.title === "Harbor Note")!.interest_name).toBe("Harbors");
    const bare: any = await execMakeKeep(ctx("keep this as made"));
    expect(bare).toMatchObject({ refused: true, code: "bad_ref" });
  });

  it("originKind derives from the prefix", () => {
    expect(originKind("letter:1")).toBe("letter");
    expect(originKind("growth:1")).toBe("exploration");
    expect(originKind("journal:1")).toBe("kept");
    expect(originKind("note:1")).toBe("kept");
    expect(originKind(null)).toBeNull();
  });
});
