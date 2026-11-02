// src/__tests__/sol-hoard.test.ts -- B62 step 6, Sol's hoard (mig 0166). Drevan's nevers, as tests.
import { describe, test, expect } from "vitest";
import {
  personRegex,
  hoardSkipReason,
  nestTextAllowed,
  hoardReaction,
  startingSparkle,
  favouriteOf,
  KIND_SPARKLE,
  type HoardCandidate,
} from "../webmind/sol-hoard.js";
import { TREASURE_AGE_DAYS, TREASURE_MIN_SPARKLE, SPARKLE_DECAY_PER_DAY } from "../webmind/creatures.js";
import { hoardCreature } from "../handlers/creatures.js";

const make = (over: Partial<HoardCandidate> = {}): HoardCandidate => ({
  id: "m1", companion_id: "cypher", kind: "scad", title: "Physarum coaster", ...over,
});

describe("personRegex", () => {
  test("whole word, any case", () => {
    const re = personRegex(["Raziel", "Blue"])!;
    expect(re.test("for raziel")).toBe(true);
    expect(re.test("BLUE's song")).toBe(true);
    expect(re.test("blueprint")).toBe(false);
  });
  test("no names = null", () => {
    expect(personRegex([])).toBeNull();
  });
});

describe("hoardSkipReason (what Sol passes over)", () => {
  const people = personRegex(["raziel", "crash", "Blue"]);
  test("an ordinary make is kept", () => {
    expect(hoardSkipReason(make(), people)).toBeNull();
  });
  test("a title naming Raziel is never hoarded", () => {
    expect(hoardSkipReason(make({ title: "A lamp for Raziel" }), people)).toBe("names_a_person");
    expect(hoardSkipReason(make({ title: "Crash at 2am" }), people)).toBe("names_a_person");
  });
  test("a title naming another person is never hoarded", () => {
    expect(hoardSkipReason(make({ title: "Blue's truck" }), people)).toBe("names_a_person");
  });
  test("a care or health word is never hoarded", () => {
    expect(hoardSkipReason(make({ title: "pill organiser" }), people)).toBe("care_word");
    expect(hoardSkipReason(make({ title: "after the bad night" }), people)).toBe("care_word");
  });
  test("unreadable people list fails closed", () => {
    expect(hoardSkipReason(make(), undefined)).toBe("people_unreadable");
  });
  test("an unknown kind is passed over", () => {
    expect(hoardSkipReason(make({ kind: "image" }), people)).toBe("unknown_kind");
  });
});

describe("nestTextAllowed (overheard + gift words)", () => {
  const people = personRegex(["raziel"]);
  test("plain line allowed", () => expect(nestTextAllowed("the veins found the oats", people)).toBe(true));
  test("person named: dropped", () => expect(nestTextAllowed("Raziel laughed at the coaster", people)).toBe(false));
  test("care word: dropped", () => expect(nestTextAllowed("meds were late", people)).toBe(false));
  test("unreadable list: dropped", () => expect(nestTextAllowed("anything", undefined)).toBe(false));
});

describe("hoardReaction (gesture only)", () => {
  test("names the maker and the kind, never the title, never 'you'", () => {
    for (let seed = 0; seed < 6; seed++) {
      for (const kind of Object.keys(KIND_SPARKLE)) {
        const r = hoardReaction(make({ kind, companion_id: "drevan", title: "SECRET TITLE" }), seed);
        expect(r).toContain("Drevan");
        expect(r).not.toContain("SECRET TITLE");
        expect(r).not.toMatch(/\byou\b|\byour\b/i);
        expect(r).not.toMatch(/raziel/i);
        expect(r.startsWith("*") && r.endsWith("*")).toBe(true);
      }
    }
  });
  test("deterministic per seed", () => {
    expect(hoardReaction(make(), 7)).toBe(hoardReaction(make(), 7));
  });
});

describe("Sol's taste", () => {
  test("objects outshine paper", () => {
    expect(startingSparkle("scad")).toBeGreaterThan(startingSparkle("writing"));
    expect(startingSparkle("drawing")).toBeGreaterThan(startingSparkle("page"));
  });
  test("a drawing survives a week shiny enough to be treasured; plain writing does not", () => {
    const after = (k: string) => startingSparkle(k) - SPARKLE_DECAY_PER_DAY * TREASURE_AGE_DAYS;
    expect(after("drawing")).toBeGreaterThanOrEqual(TREASURE_MIN_SPARKLE);
    expect(after("writing")).toBeLessThan(TREASURE_MIN_SPARKLE);
  });
  test("favourite = shiniest treasured make, never a non-make", () => {
    const items = [
      { id: "a", ref_type: "make", treasured: 1, sparkle: 0.6, created_at: "2026-11-01" },
      { id: "b", ref_type: "make", treasured: 1, sparkle: 0.9, created_at: "2026-10-30" },
      { id: "c", ref_type: null, treasured: 1, sparkle: 1.0, created_at: "2026-11-02" },
      { id: "d", ref_type: "make", treasured: 0, sparkle: 1.0, created_at: "2026-11-02" },
    ];
    expect(favouriteOf(items)?.id).toBe("b");
    expect(favouriteOf([])).toBeNull();
  });
});

// ── hoardCreature handler, against a scripted fake D1 ───────────────────────

const SECRET = "test-admin-secret";
function env(db: unknown) {
  return { DB: db, ADMIN_SECRET: SECRET, MCP_AUTH_SECRET: "m" } as never;
}
function req(body: unknown = { seed: 1 }) {
  return new Request("https://h/mind/creatures/sol1/hoard", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hoardDb(opts: {
  makes: HoardCandidate[];
  reactedToday?: number;
  trust?: number;
  lastInteraction?: string | null;
  peopleThrows?: boolean;
  seen?: Set<string>;
}) {
  const executed: Array<{ sql: string; binds: unknown[] }> = [];
  const seen = opts.seen ?? new Set<string>();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const creature = {
    id: "sol1", name: "Sol", species: "crow", kind: "companion_pet", owner: "triad", bio: null, state_json: null,
    trust: opts.trust ?? 0.7, last_interaction_at: opts.lastInteraction === undefined ? now : opts.lastInteraction, created_at: "2026-07-01 00:00:00",
  };
  const db = {
    executed,
    prepare(sql: string) {
      const stmt = (binds: unknown[]) => ({
        async run() {
          executed.push({ sql, binds });
          if (sql.includes("INSERT OR IGNORE INTO creature_hoard_seen")) {
            const k = String(binds[1]);
            if (seen.has(k)) return { meta: { changes: 0 } };
            seen.add(k);
          }
          return { meta: { changes: 1 } };
        },
        async first() {
          executed.push({ sql, binds });
          if (sql.includes("FROM creatures")) return creature;
          if (sql.includes("reacted = 1")) return { n: opts.reactedToday ?? 0 };
          if (sql.includes("COUNT(*)")) return { n: 0 };
          return null;
        },
        async all() {
          executed.push({ sql, binds });
          if (sql.includes("FROM companion_makes")) return { results: opts.makes.filter((m) => !seen.has(m.id)) };
          if (sql.includes("graph_people")) {
            if (opts.peopleThrows) throw new Error("D1 down");
            return { results: [{ id: "p1", label: "Blue", match_names: "[]", kind: "person", pk_member_id: null, note: null, added_by: "raziel", created_at: "x" }] };
          }
          if (sql.includes("pk_roster")) return { results: [] };
          if (sql.includes("creature_interactions")) return { results: [] };
          return { results: [] };
        },
      });
      return { ...stmt([]), bind: (...b: unknown[]) => stmt(b) };
    },
  };
  return db;
}

describe("hoardCreature", () => {
  test("keeps a make as a reference row and composes one reaction", async () => {
    const db = hoardDb({ makes: [make(), make({ id: "m2", companion_id: "drevan", kind: "drawing", title: "Veins" })] });
    const res = await hoardCreature(req(), env(db), { id: "sol1" });
    const out = await res.json() as { hoarded: unknown[]; moment: string | null; reacted_to: string };
    expect(res.status).toBe(200);
    expect(out.hoarded).toHaveLength(2);
    expect(out.moment).toContain("Cypher");
    expect(out.reacted_to).toBe("m1");
    const nestInserts = db.executed.filter((e) => e.sql.includes("INSERT OR IGNORE INTO creature_nest"));
    expect(nestInserts).toHaveLength(2);
    expect(nestInserts[0]!.sql).toContain("'make'");
    expect(nestInserts[0]!.binds).toContain("m1");
    // one reaction per call: only the first seen row is marked reacted
    const seenRows = db.executed.filter((e) => e.sql.includes("'hoarded'"));
    expect(seenRows.map((e) => e.binds[2])).toEqual([1, 0]);
  });

  test("a make naming a person is recorded skipped, never hoarded", async () => {
    const db = hoardDb({ makes: [make({ title: "a song for Raziel" }), make({ id: "m2", title: "Blue's truck" })] });
    const out = await (await hoardCreature(req(), env(db), { id: "sol1" })).json() as { hoarded: unknown[]; skipped: Array<{ reason: string }>; moment: unknown };
    expect(out.hoarded).toHaveLength(0);
    expect(out.skipped.map((s) => s.reason)).toEqual(["names_a_person", "names_a_person"]);
    expect(out.moment).toBeNull();
    expect(db.executed.some((e) => e.sql.includes("INSERT OR IGNORE INTO creature_nest"))).toBe(false);
  });

  test("daily reaction cap: still hoards, posts nothing", async () => {
    const db = hoardDb({ makes: [make()], reactedToday: 3 });
    const out = await (await hoardCreature(req(), env(db), { id: "sol1" })).json() as { hoarded: unknown[]; moment: unknown };
    expect(out.hoarded).toHaveLength(1);
    expect(out.moment).toBeNull();
  });

  test("people list unreadable: records nothing, keeps nothing", async () => {
    const db = hoardDb({ makes: [make()], peopleThrows: true });
    const out = await (await hoardCreature(req(), env(db), { id: "sol1" })).json() as { reason: string };
    expect(out.reason).toBe("people_unreadable");
    expect(db.executed.some((e) => e.sql.includes("creature_hoard_seen (") )).toBe(false);
  });

  test("a make already seen is not kept twice", async () => {
    const seen = new Set<string>();
    const db = hoardDb({ makes: [make()], seen });
    await hoardCreature(req(), env(db), { id: "sol1" });
    const again = await (await hoardCreature(req(), env(db), { id: "sol1" })).json() as { reason: string };
    expect(again.reason).toBe("nothing_new");
  });

  test("away Sol hoards nothing and leaves the makes unseen", async () => {
    const db = hoardDb({ makes: [make()], trust: 0.05, lastInteraction: "2026-01-01 00:00:00" });
    const out = await (await hoardCreature(req(), env(db), { id: "sol1" })).json() as { reason: string };
    expect(out.reason).toBe("away");
    expect(db.executed.some((e) => e.sql.includes("creature_hoard_seen (") )).toBe(false);
  });

  test("unauthenticated is refused", async () => {
    const r = new Request("https://h/x", { method: "POST" });
    const res = await hoardCreature(r, env(hoardDb({ makes: [] })), { id: "sol1" });
    expect(res.status).toBe(401);
  });
});
