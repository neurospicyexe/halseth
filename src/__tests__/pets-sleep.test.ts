// B64 Task 5: the nightly sleep pass. Pure clamp rules first (clampSleep, parseSleepOutput,
// buildSleepInput), then runSleepPass against the REAL schema (every migration incl. 0176) with an
// injected fake PetModel: no network anywhere in this file.
import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  clampSleep, parseSleepOutput, type NightAppraisal, type SleepOutput, type TraitRow, type QuirkRow,
} from "../pets/sleep-clamp.js";
import { buildSleepInput, buildSleepSystem, runSleepPass } from "../pets/sleep.js";
import type { PetModel } from "../pets/model.js";
import { personRegex } from "../webmind/sol-hoard.js";
import { tickCreatures } from "../handlers/creatures.js";

const DAY = 86_400_000;
const H = 3_600_000;
// Noon in Chicago on 2026-11-20 (UTC-6 in November).
const NOW = Date.parse("2026-11-20T18:00:00Z");
const NIGHT = "2026-11-20";
const iso = (ms: number) => new Date(ms).toISOString();
const PEOPLE = personRegex(["Corbin", "Raziel"]);

// ── pure fixtures ────────────────────────────────────────────────────────────
function ap(id: string, over: Partial<NightAppraisal> = {}): NightAppraisal {
  return {
    id, actor: "cypher", action: "feed", fit: "met", band: "dawn", valence: 0.8, friction: false,
    weight: 1, source: "live", day: NIGHT, tags: [], ...over,
  };
}
function nightOf(...as: NightAppraisal[]): Map<string, NightAppraisal> {
  return new Map(as.map((a) => [a.id, a]));
}
function trait(slug: string, over: Partial<TraitRow> = {}): TraitRow {
  return {
    id: `t_${slug}`, creature_id: "sol", slug, category: "preference", target_actor: null,
    perspective: "the early hand tastes right", entrenchment: 2, live_points: 2, live_days: "[]",
    origin: "live", status: "candidate", last_reinforced_at: iso(NOW - DAY), created_at: iso(NOW - 5 * DAY),
    ...over,
  };
}
function quirk(id: string, traitId: string, over: Partial<QuirkRow> = {}): QuirkRow {
  return {
    id, creature_id: "sol", trait_id: traitId, title: "Dawn Feeding", trigger_json: JSON.stringify({ time_band: "dawn" }),
    behavior: "waits on the rail", resolution_json: JSON.stringify({ kind: "visits", n: 2 }), target_actor: null,
    kind: "preference", status: "active", arc: JSON.stringify([{ night: "2026-10-01", kind: "promoted" }]),
    promoted_at: "2026-10-01T12:00:00.000Z", ...over,
  };
}
const QUIRK_BLOCK = {
  title: "Dawn Feeding", trigger: { action: "feed", time_band: "dawn" }, behavior: "waits on the rail at first light",
  resolution: { kind: "visits", n: 2 },
};
const state = (over: Partial<Parameters<typeof clampSleep>[1]> = {}): Parameters<typeof clampSleep>[1] => ({
  traits: [], quirks: [], people: PEOPLE, nowDay: NIGHT, nowMs: NOW, night: new Map(), creatureId: "sol", ...over,
});

describe("parseSleepOutput", () => {
  it("parses a ```json fenced answer", () => {
    const raw = "```json\n{\"items\":[{\"op\":\"CREATE\",\"slug\":\"dawn_feed\",\"evidence\":[\"a1\"]}]}\n```";
    expect(parseSleepOutput(raw)?.items).toHaveLength(1);
  });
  it("junk, prose, wrong shape and empty are null", () => {
    expect(parseSleepOutput("the crow dreams of walnuts")).toBeNull();
    expect(parseSleepOutput("{\"items\": 3}")).toBeNull();
    expect(parseSleepOutput("[]")).toBeNull();
    expect(parseSleepOutput("")).toBeNull();
    expect(parseSleepOutput("{\"items\":[{\"op\":\"CREATE\"}]}")).not.toBeNull(); // shape ok; the clamp drops the item
  });
});

describe("clampSleep caps and guards", () => {
  it("3 CREATEs -> only 2 kept", () => {
    const night = nightOf(ap("a1"), ap("a2"), ap("a3"));
    const out: SleepOutput = { items: ["one", "two", "three"].map((s, i) => ({
      op: "CREATE", slug: `slug_${s}`, category: "preference", perspective: "the early hand", evidence: [`a${i + 1}`],
    })) };
    const plan = clampSleep(out, state({ night }));
    expect(plan.traitInserts.map((t) => t.slug)).toEqual(["slug_one", "slug_two"]);
    expect(plan.counts.created).toBe(2);
    expect(plan.dropped.some((d) => d.why === "create_cap")).toBe(true);
  });
  it("a perspective naming a person (fixture regex) drops that item only", () => {
    const night = nightOf(ap("a1"), ap("a2"));
    const plan = clampSleep({ items: [
      { op: "CREATE", slug: "likes_corbin", category: "preference", perspective: "Corbin brings the good seeds", evidence: ["a1"] },
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light means food", evidence: ["a2"] },
    ] }, state({ night }));
    expect(plan.traitInserts.map((t) => t.slug)).toEqual(["dawn_feed"]);
  });
  it("an actor word in perspective is a name too (use the actor field)", () => {
    const plan = clampSleep({ items: [
      { op: "CREATE", slug: "x_feed", category: "preference", perspective: "drevan feeds him well", evidence: ["a1"] },
    ] }, state({ night: nightOf(ap("a1")) }));
    expect(plan.traitInserts).toHaveLength(0);
  });
  it("a care word in the quirk behavior drops the item", () => {
    const t = trait("dawn_feed", { entrenchment: 4.5, live_points: 4, live_days: JSON.stringify(["2026-11-17", "2026-11-18", "2026-11-19"]) });
    const plan = clampSleep({ items: [{
      op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"],
      quirk: { ...QUIRK_BLOCK, behavior: "waits for the medication" },
    }] }, state({ traits: [t], night: nightOf(ap("a1")) }));
    expect(plan.traitUpdates).toHaveLength(0);
    expect(plan.quirkInserts).toHaveLength(0);
  });
  it("delta +3 is clamped to +1", () => {
    const t = trait("dawn_feed", { entrenchment: 2 });
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 3, evidence: ["a1"] }] },
      state({ traits: [t], night: nightOf(ap("a1")) }));
    expect(plan.traitUpdates[0]!.entrenchment).toBe(3);
    expect(plan.evidence[0]!.delta).toBe(1);
  });
  it("two items on one slug in one night still move it at most 1", () => {
    const t = trait("dawn_feed", { entrenchment: 2 });
    const plan = clampSleep({ items: [
      { op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"] },
      { op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a2"] },
    ] }, state({ traits: [t], night: nightOf(ap("a1"), ap("a2")) }));
    expect(plan.traitUpdates[0]!.entrenchment).toBe(3);
  });
  it("evidence ids not in tonight's input are dropped; nothing left drops the item", () => {
    const plan = clampSleep({ items: [
      { op: "CREATE", slug: "ghost", category: "preference", perspective: "a thing", evidence: ["nope"] },
    ] }, state({ night: nightOf(ap("a1")) }));
    expect(plan.traitInserts).toHaveLength(0);
    expect(plan.dropped[0]!.why).toBe("no_evidence");
  });
  it("closed vocab: a trigger outside it drops the item", () => {
    const t = trait("dawn_feed", { entrenchment: 4, live_points: 4, live_days: JSON.stringify(["2026-11-17", "2026-11-18", "2026-11-19"]) });
    const plan = clampSleep({ items: [{
      op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"],
      quirk: { ...QUIRK_BLOCK, trigger: { action: "pet", time_band: "dawn" } },
    }] }, state({ traits: [t], night: nightOf(ap("a1")) }));
    expect(plan.traitUpdates).toHaveLength(0);
    expect(plan.dropped[0]!.why).toBe("bad_quirk");
  });
  it("CREATE on an existing slug becomes a reinforce (no UNIQUE failure); a faded one revives", () => {
    const live = trait("dawn_feed", { entrenchment: 2 });
    const faded = trait("dusk_talk", { entrenchment: 0, status: "faded" });
    const plan = clampSleep({ items: [
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light", evidence: ["a1"] },
      { op: "CREATE", slug: "dusk_talk", category: "preference", perspective: "low voices late", evidence: ["a2"] },
    ] }, state({ traits: [live, faded], night: nightOf(ap("a1"), ap("a2")) }));
    expect(plan.traitInserts).toHaveLength(0);
    const by = new Map(plan.traitUpdates.map((t) => [t.slug, t]));
    expect(by.get("dawn_feed")!.entrenchment).toBe(3);
    expect(by.get("dusk_talk")!.status).toBe("candidate");
    expect(by.get("dusk_talk")!.entrenchment).toBe(1);
  });
});

describe("clampSleep promotion", () => {
  const days3 = JSON.stringify(["2026-11-17", "2026-11-18", "2026-11-19"]);
  it("entrenchment reaching 5 with 4 live points across 3 days -> quirk row, trait graduated", () => {
    const t = trait("dawn_feed", { entrenchment: 4, live_points: 3, live_days: days3 });
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"], quirk: QUIRK_BLOCK }] },
      state({ traits: [t], night: nightOf(ap("a1")) }));
    expect(plan.counts.promoted).toBe(1);
    expect(plan.quirkInserts[0]!).toMatchObject({ trait_id: t.id, title: "Dawn Feeding", kind: "preference", status: "active" });
    expect(JSON.parse(plan.quirkInserts[0]!.trigger_json!)).toEqual({ action: "feed", time_band: "dawn" });
    expect(plan.traitUpdates[0]!.status).toBe("graduated");
  });
  it("the same climb on backfill evidence only -> not promoted, no live points added", () => {
    const t = trait("dawn_feed", { entrenchment: 4, live_points: 0, live_days: "[]", origin: "backfill" });
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["b1"], quirk: QUIRK_BLOCK }] },
      state({ traits: [t], night: nightOf(ap("b1", { source: "backfill", day: "2026-03-01" })) }));
    expect(plan.counts.promoted).toBe(0);
    expect(plan.traitUpdates[0]!).toMatchObject({ entrenchment: 5, live_points: 0, status: "candidate" });
    expect(JSON.parse(plan.traitUpdates[0]!.live_days)).toEqual([]);
  });
  it("backfill-only CREATE starts at 1 with origin backfill", () => {
    const plan = clampSleep({ items: [{ op: "CREATE", slug: "old_habit", category: "habit", perspective: "the old rail", evidence: ["b1"] }] },
      state({ night: nightOf(ap("b1", { source: "backfill" })) }));
    expect(plan.traitInserts[0]!).toMatchObject({ entrenchment: 1, origin: "backfill", live_points: 0 });
  });
  it("qualified but with no quirk block -> stays a candidate at 5", () => {
    const t = trait("dawn_feed", { entrenchment: 4, live_points: 3, live_days: days3 });
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"] }] },
      state({ traits: [t], night: nightOf(ap("a1")) }));
    expect(plan.counts.promoted).toBe(0);
    expect(plan.traitUpdates[0]!).toMatchObject({ entrenchment: 5, status: "candidate" });
  });
  it("8 active quirks -> no ninth promotion", () => {
    const t = trait("dawn_feed", { entrenchment: 4, live_points: 3, live_days: days3 });
    const quirks = Array.from({ length: 8 }, (_, i) => quirk(`q${i}`, `tq${i}`));
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"], quirk: QUIRK_BLOCK }] },
      state({ traits: [t], quirks, night: nightOf(ap("a1")) }));
    expect(plan.counts.promoted).toBe(0);
  });
});

describe("clampSleep eviction and decay", () => {
  it("a 16th active trait evicts the lowest (tie: oldest reinforced) to faded", () => {
    const traits = Array.from({ length: 15 }, (_, i) => trait(`t${i}`, {
      entrenchment: i < 2 ? 1 : 3, last_reinforced_at: iso(NOW - (i === 0 ? 3 : 2) * DAY),
    }));
    const plan = clampSleep({ items: [{ op: "CREATE", slug: "newcomer", category: "preference", perspective: "a new thing", evidence: ["a1"] }] },
      state({ traits, night: nightOf(ap("a1")) }));
    expect(plan.traitInserts).toHaveLength(1);
    const faded = plan.traitUpdates.filter((t) => t.status === "faded").map((t) => t.slug);
    expect(faded).toEqual(["t0"]);
  });
  it("a trait untouched 11 days loses 1; untouched 9 days does not", () => {
    const old = trait("stale", { entrenchment: 3, last_reinforced_at: iso(NOW - 11 * DAY) });
    const fresh = trait("fresh", { entrenchment: 3, last_reinforced_at: iso(NOW - 9 * DAY) });
    const plan = clampSleep({ items: [] }, state({ traits: [old, fresh] }));
    expect(plan.traitUpdates.map((t) => [t.slug, t.entrenchment])).toEqual([["stale", 2]]);
    expect(plan.counts.decayed).toBe(1);
  });
  it("decay to 0 fades the trait (never deletes); a graduated trait never time-decays", () => {
    const low = trait("low", { entrenchment: 1, last_reinforced_at: iso(NOW - 30 * DAY) });
    const grad = trait("grad", { entrenchment: 5, status: "graduated", last_reinforced_at: iso(NOW - 60 * DAY) });
    const plan = clampSleep({ items: [] }, state({ traits: [low, grad] }));
    expect(plan.traitUpdates).toHaveLength(1);
    expect(plan.traitUpdates[0]!).toMatchObject({ slug: "low", entrenchment: 0, status: "faded" });
  });
});

describe("clampSleep quirk arc", () => {
  const g = trait("dawn_feed", { entrenchment: 5, status: "graduated" });
  const contradict = (days: string[]) => days.map((d) => ({ night: d, kind: "contradict", days: [d], evidence: [] }));
  it("contradicted on 5 distinct days within 21 -> softening, arc appended", () => {
    const q = quirk("q1", g.id, { arc: JSON.stringify([{ night: "2026-10-01", kind: "promoted" }, ...contradict(["2026-11-05", "2026-11-09", "2026-11-12", "2026-11-15"])]) });
    const plan = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1", { day: "2026-11-19" })) }));
    expect(plan.counts.softened).toBe(1);
    const u = plan.quirkUpdates[0]!;
    expect(u.status).toBe("softening");
    const arc = JSON.parse(u.arc);
    expect(arc.at(-2)).toMatchObject({ kind: "contradict", days: ["2026-11-19"], evidence: ["a1"] });
    expect(arc.at(-1)).toMatchObject({ kind: "softening", night: NIGHT });
  });
  it("4 days within 21 (a fifth older) -> still active", () => {
    const q = quirk("q1", g.id, { arc: JSON.stringify(contradict(["2026-10-20", "2026-11-09", "2026-11-12", "2026-11-15"])) });
    const plan = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1", { day: "2026-11-19" })) }));
    expect(plan.counts.softened).toBe(0);
    expect(plan.quirkUpdates[0]!.status).toBe("active");
  });
  it("backfill contradiction never counts toward the arc", () => {
    const q = quirk("q1", g.id, { arc: JSON.stringify(contradict(["2026-11-05", "2026-11-09", "2026-11-12", "2026-11-15"])) });
    const plan = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["b1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("b1", { source: "backfill", day: "2026-11-19" })) }));
    expect(plan.counts.softened).toBe(0);
  });
  it("softening + one supporting night -> re-hardens to active", () => {
    const q = quirk("q1", g.id, { status: "softening", arc: JSON.stringify([...contradict(["2026-11-01"]), { night: "2026-11-10", kind: "softening" }]) });
    const plan = clampSleep({ items: [{ op: "REINFORCE", slug: "dawn_feed", delta: 1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1")) }));
    expect(plan.quirkUpdates[0]!.status).toBe("active");
    expect(JSON.parse(plan.quirkUpdates[0]!.arc).at(-1).kind).toBe("rehardened");
  });
  it("softening + contradiction 14+ days later -> retired (row kept, never deleted)", () => {
    const q = quirk("q1", g.id, { status: "softening", arc: JSON.stringify([{ night: "2026-11-05", kind: "softening" }]) });
    const plan = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1")) }));
    expect(plan.counts.retired).toBe(1);
    expect(plan.quirkUpdates[0]!.status).toBe("retired");
  });
  it("softening + contradiction only 10 days later -> still softening", () => {
    const q = quirk("q1", g.id, { status: "softening", arc: JSON.stringify([{ night: "2026-11-10", kind: "softening" }]) });
    const plan = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1")) }));
    expect(plan.quirkUpdates[0]!.status).toBe("softening");
  });
});

describe("LAUNCH CHECK: an opinion about an absent party is a draft, not a record", () => {
  it("(1) an aversion toward drevan backed only by cypher's appraisals -> dropped, nothing written", () => {
    const night = nightOf(ap("c1", { actor: "cypher" }), ap("c2", { actor: "cypher" }));
    const plan = clampSleep({ items: [{
      op: "CREATE", slug: "late_feeder", category: "aversion", target_actor: "drevan",
      perspective: "the late one never comes", evidence: ["c1", "c2"],
    }] }, state({ night }));
    expect(plan.traitInserts).toHaveLength(0);
    expect(plan.evidence).toHaveLength(0);
  });
  it("mixed evidence keeps only X's own appraisals", () => {
    const night = nightOf(ap("c1", { actor: "cypher" }), ap("d1", { actor: "drevan" }));
    const plan = clampSleep({ items: [{
      op: "CREATE", slug: "dusk_bringer", category: "preference", target_actor: "drevan",
      perspective: "the dusk one brings walnuts", evidence: ["c1", "d1"],
    }] }, state({ night }));
    expect(plan.evidence[0]!.appraisal_ids).toEqual(["d1"]);
  });
  it("(2) a drevan-targeted trait at 5 with drevan's live points on only 2 days -> not promoted", () => {
    const t = trait("dusk_bringer", { target_actor: "drevan", entrenchment: 4, live_points: 4, live_days: JSON.stringify(["2026-11-18"]) });
    const plan = clampSleep({ items: [{
      op: "REINFORCE", slug: "dusk_bringer", delta: 1, evidence: ["d1"],
      quirk: { ...QUIRK_BLOCK, trigger: { actor: "drevan", time_band: "dusk" } },
    }] }, state({ traits: [t], night: nightOf(ap("d1", { actor: "drevan", day: "2026-11-19" })) }));
    expect(plan.traitUpdates[0]!.entrenchment).toBe(5);
    expect(plan.counts.promoted).toBe(0);
  });
  it("a quirk trigger aimed at another actor than the trait's target drops the item", () => {
    const t = trait("dusk_bringer", { target_actor: "drevan", entrenchment: 4, live_points: 4, live_days: JSON.stringify(["2026-11-16", "2026-11-17", "2026-11-18"]) });
    const plan = clampSleep({ items: [{
      op: "REINFORCE", slug: "dusk_bringer", delta: 1, evidence: ["d1"],
      quirk: { ...QUIRK_BLOCK, trigger: { actor: "gaia" } },
    }] }, state({ traits: [t], night: nightOf(ap("d1", { actor: "drevan" })) }));
    expect(plan.counts.promoted).toBe(0);
    expect(plan.traitUpdates).toHaveLength(0);
  });
  it("buildSleepInput carries only tends that happened: no line about who did not come", () => {
    const input = buildSleepInput(
      [ap("c1", { actor: "cypher" }), ap("c2", { actor: "cypher", action: "talk", fit: "welcome" })], [], [],
      { creature_id: "sol", species: "crow", body_json: null, voice_rules: "Third person.", sample_lines: null },
    );
    expect(input).toContain("c1");
    expect(input).not.toMatch(/drevan|gaia|raziel/i);
    expect(input).not.toMatch(/absent|no visits|missing|never came|0 tends/i);
  });
  it("the system prompt states the absent-party rule, the closed vocab, voice rules and JSON-only", () => {
    const sys = buildSleepSystem({ creature_id: "sol", species: "crow", body_json: null, voice_rules: "He never speaks words.", sample_lines: null });
    expect(sys).toContain("actor in [raziel,cypher,drevan,gaia,imp]");
    expect(sys).toContain("He never speaks words.");
    expect(sys).toMatch(/draft, not a record/);
    expect(sys).toMatch(/JSON only/);
  });
});

// ── runSleepPass against the real schema ─────────────────────────────────────
function setup() {
  const s = makeSqliteD1();
  const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
  s.db.prepare("INSERT INTO pk_roster (member_id, system_id, name, name_norm) VALUES ('m1', 'sys', 'Corbin', 'corbin')").run();
  return { ...s, solId: sol.id };
}
let seq = 0;
function seedAppr(db: any, creatureId: string, over: { id?: string; actor?: string; action?: string; fit?: string | null; weight?: number; source?: string; createdMs?: number; tags?: string[] } = {}) {
  const id = over.id ?? `ap${++seq}`;
  const actor = over.actor ?? "cypher";
  const action = over.action ?? "feed";
  db.prepare(
    "INSERT INTO creature_appraisals (id, creature_id, interaction_id, actor, action, via, fit, valence, arousal, friction, tags, weight, source, created_at) VALUES (?, ?, ?, ?, ?, 'hand', ?, 0.8, 0.6, 0, ?, ?, ?, ?)",
  ).run(id, creatureId, `i_${id}`, actor, action, over.fit === undefined ? "met" : over.fit,
    JSON.stringify(over.tags ?? [action, actor, "met", "dawn"]), over.weight ?? 1, over.source ?? "live", iso(over.createdMs ?? NOW - 6 * H));
  return id;
}
const fake = (answer: string | null | (() => Promise<string | null>)): PetModel & { calls: number } => {
  const m = {
    calls: 0,
    async complete() { m.calls++; return typeof answer === "function" ? answer() : answer; },
  };
  return m;
};
const counts = (db: any) => ({
  traits: (db.prepare("SELECT COUNT(*) n FROM creature_traits").get() as any).n,
  evidence: (db.prepare("SELECT COUNT(*) n FROM creature_trait_evidence").get() as any).n,
  quirks: (db.prepare("SELECT COUNT(*) n FROM creature_quirks").get() as any).n,
  unprocessed: (db.prepare("SELECT COUNT(*) n FROM creature_appraisals WHERE processed_at IS NULL").get() as any).n,
});
const lastSleep = (db: any, id: string) =>
  (db.prepare("SELECT json_extract(state_json, '$.last_sleep_at') v FROM creatures WHERE id = ?").get(id) as any).v;
const env = (DB: unknown) => ({ DB, ADMIN_SECRET: "admin-tok", MCP_AUTH_SECRET: "mcp-tok" }) as never;

describe("runSleepPass", () => {
  it("gate: unprocessed weight 2.5 -> ran:false reason too_little, model never called", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId, { weight: 1 }); seedAppr(db, solId, { weight: 1 }); seedAppr(db, solId, { weight: 0.5 });
    const m = fake("{\"items\":[]}");
    const r = await runSleepPass(env(DB), solId, m, NOW);
    expect(r).toMatchObject({ ran: false, reason: "too_little" });
    expect(m.calls).toBe(0);
  });
  it("a fenced answer writes traits + evidence, marks appraisals processed (ISO), stamps last_sleep_at; second run within 20h -> rested", async () => {
    const { db, DB, solId } = setup();
    const ids = [seedAppr(db, solId), seedAppr(db, solId), seedAppr(db, solId)];
    const trustBefore = (db.prepare("SELECT trust, last_interaction_at FROM creatures WHERE id = ?").get(solId) as any);
    const m = fake("```json\n" + JSON.stringify({ items: [{
      op: "CREATE", slug: "dawn_feed", category: "preference", target_actor: null, perspective: "first light means food",
      evidence: ids, reason: "three early feeds",
    }] }) + "\n```");
    const r = await runSleepPass(env(DB), solId, m, NOW);
    expect(r).toMatchObject({ ran: true, reason: "slept", created: 1 });
    const t = db.prepare("SELECT * FROM creature_traits").get() as any;
    expect(t).toMatchObject({ slug: "dawn_feed", entrenchment: 1, origin: "live", status: "candidate" });
    expect(t.live_points).toBeCloseTo(1);
    expect(JSON.parse(t.live_days)).toEqual([NIGHT]);
    expect(t.created_at).toBe(iso(NOW));
    const ev = db.prepare("SELECT * FROM creature_trait_evidence").get() as any;
    expect(JSON.parse(ev.appraisal_ids).sort()).toEqual([...ids].sort());
    expect(ev.night).toBe(NIGHT);
    expect(counts(db).unprocessed).toBe(0);
    expect((db.prepare("SELECT processed_at FROM creature_appraisals LIMIT 1").get() as any).processed_at).toBe(iso(NOW));
    expect(lastSleep(db, solId)).toBe(iso(NOW));
    // R7: the sleep pass never touches trust.
    expect(db.prepare("SELECT trust, last_interaction_at FROM creatures WHERE id = ?").get(solId)).toEqual(trustBefore);

    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    const again = await runSleepPass(env(DB), solId, m, NOW + 19 * H);
    expect(again).toMatchObject({ ran: false, reason: "rested" });
    expect(m.calls).toBe(1);
  });
  it("junk from the model -> null, zero writes, appraisals stay unprocessed, no stamp (review focus 2)", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    const errs = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await runSleepPass(env(DB), solId, fake("Sol dreams of walnuts and Corbin."), NOW);
    errs.mockRestore();
    expect(r).toMatchObject({ ran: false, reason: "invalid_output" });
    expect(counts(db)).toEqual({ traits: 0, evidence: 0, quirks: 0, unprocessed: 3 });
    expect(lastSleep(db, solId)).toBeNull();
  });
  it("model null (timeout / no key) -> model_failed, zero writes", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    const r = await runSleepPass(env(DB), solId, fake(null), NOW);
    expect(r).toMatchObject({ ran: false, reason: "model_failed" });
    expect(counts(db).unprocessed).toBe(3);
  });
  it("a roster name in one item drops that item; the rest of the night lands", async () => {
    const { db, DB, solId } = setup();
    const ids = [seedAppr(db, solId), seedAppr(db, solId), seedAppr(db, solId)];
    const r = await runSleepPass(env(DB), solId, fake(JSON.stringify({ items: [
      { op: "CREATE", slug: "corbin_seeds", category: "preference", perspective: "Corbin brings seeds", evidence: [ids[0]] },
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light means food", evidence: [ids[1], ids[2]] },
    ] })), NOW);
    expect(r.ran).toBe(true);
    expect((db.prepare("SELECT slug FROM creature_traits").all() as any[]).map((x) => x.slug)).toEqual(["dawn_feed"]);
    expect(JSON.stringify(db.prepare("SELECT * FROM creature_traits").all())).not.toMatch(/corbin/i);
  });
  it("people list unreadable -> fail closed: nothing written, nothing processed", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    db.exec("DROP TABLE pk_roster");
    const m = fake(JSON.stringify({ items: [] }));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runSleepPass(env(DB), solId, m, NOW);
    quiet.mockRestore();
    expect(r).toMatchObject({ ran: false, reason: "people_unreadable" });
    expect(m.calls).toBe(0);
    expect(counts(db).unprocessed).toBe(3);
  });
  it("a valid empty night still marks appraisals processed and stamps the night", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    const r = await runSleepPass(env(DB), solId, fake("{\"items\":[]}"), NOW);
    expect(r).toMatchObject({ ran: true, created: 0 });
    expect(counts(db).unprocessed).toBe(0);
    expect(lastSleep(db, solId)).toBe(iso(NOW));
  });
  it("LAUNCH CHECK (1) end to end: an aversion toward drevan from cypher's tends writes no trait", async () => {
    const { db, DB, solId } = setup();
    const ids = [seedAppr(db, solId, { actor: "cypher" }), seedAppr(db, solId, { actor: "cypher" }), seedAppr(db, solId, { actor: "cypher" })];
    const r = await runSleepPass(env(DB), solId, fake(JSON.stringify({ items: [{
      op: "CREATE", slug: "late_feeder", category: "aversion", target_actor: "drevan", perspective: "the late one never comes", evidence: ids,
    }] })), NOW);
    expect(r.created).toBe(0);
    expect(counts(db).traits).toBe(0);
    expect(counts(db).evidence).toBe(0);
  });
  it("the model's input never carries a note or raw text, and no absent-actor line", async () => {
    const { db, DB, solId } = setup();
    db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, note) VALUES ('i_x', ?, 'cypher', 'give', 'a secret note about Corbin')").run(solId);
    seedAppr(db, solId); seedAppr(db, solId); seedAppr(db, solId);
    let seen = "";
    const m: PetModel = { async complete(_s, u) { seen = u; return "{\"items\":[]}"; } };
    await runSleepPass(env(DB), solId, m, NOW);
    expect(seen).not.toMatch(/secret|Corbin/);
    expect(seen).not.toMatch(/drevan|gaia|absent|no visits/i);
  });
});

describe("tickCreatures runs the sleep pass and never fails on it", () => {
  const tickReq = () => new Request("https://h.example/mind/creatures/tick", {
    method: "POST", headers: { Authorization: "Bearer admin-tok" },
  });
  it("a throwing model -> tick still 200, sleep.ran false", async () => {
    const { db, DB, solId } = setup();
    seedAppr(db, solId, { createdMs: Date.now() - H }); seedAppr(db, solId, { createdMs: Date.now() - H }); seedAppr(db, solId, { createdMs: Date.now() - H });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const quietLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await tickCreatures(tickReq(), env(DB), { petModel: { complete: async () => { throw new Error("boom"); } } });
    quiet.mockRestore(); quietLog.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sleep).toMatchObject({ ran: false, creature_id: solId });
    expect(counts(db).unprocessed).toBe(3);
  });
  it("a good model -> sleep result in the tick response", async () => {
    const { db, DB, solId } = setup();
    const ids = [1, 2, 3].map(() => seedAppr(db, solId, { createdMs: Date.now() - H }));
    const res = await tickCreatures(tickReq(), env(DB), { petModel: fake(JSON.stringify({ items: [
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light means food", evidence: ids },
    ] })) });
    const body = await res.json() as any;
    expect(body.sleep).toMatchObject({ ran: true, reason: "slept", created: 1, reinforced: 0, decayed: 0, promoted: 0, softened: 0, retired: 0 });
  });
});

// ── Controller rulings (second commit): CAS on the night, and never locked after retirement ─────────
describe("CAS: two passes racing the same gate", () => {
  it("one writes, the other writes nothing (reason raced)", async () => {
    const { db, DB, solId } = setup();
    const ids = [seedAppr(db, solId), seedAppr(db, solId), seedAppr(db, solId)];
    const answer = JSON.stringify({ items: [
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light means food", evidence: ids },
    ] });
    // Barrier: neither model call returns until both passes have read the gate.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const m: PetModel = { async complete() { if (++arrived === 2) release(); await both; return answer; } };
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const [a, b] = await Promise.all([runSleepPass(env(DB), solId, m, NOW), runSleepPass(env(DB), solId, m, NOW + 1000)]);
    quiet.mockRestore();
    expect([a.reason, b.reason].sort()).toEqual(["raced", "slept"]);
    expect(counts(db)).toEqual({ traits: 1, evidence: 1, quirks: 0, unprocessed: 0 });
    // The stamp is the winner's, not overwritten by the loser.
    const winner = a.reason === "slept" ? NOW : NOW + 1000;
    expect(lastSleep(db, solId)).toBe(iso(winner));
  });
  it("same clock on both racers still lets only one through", async () => {
    const { db, DB, solId } = setup();
    const ids = [seedAppr(db, solId), seedAppr(db, solId), seedAppr(db, solId)];
    const answer = JSON.stringify({ items: [
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light means food", evidence: ids },
    ] });
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const m: PetModel = { async complete() { if (++arrived === 2) release(); await both; return answer; } };
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const rs = await Promise.all([runSleepPass(env(DB), solId, m, NOW), runSleepPass(env(DB), solId, m, NOW)]);
    quiet.mockRestore();
    expect(rs.map((r) => r.reason).sort()).toEqual(["raced", "slept"]);
    expect(counts(db).evidence).toBe(1);
  });
});

describe("never locked: a retired quirk's trait fades and the slug can grow again", () => {
  it("pure: retiring sets the trait faded; a later CREATE revives the same row at 1 with reset live points/days", () => {
    const g = trait("dawn_feed", { entrenchment: 5, status: "graduated", live_points: 6, live_days: JSON.stringify(["2026-09-01", "2026-09-02", "2026-09-03"]) });
    const q = quirk("q1", g.id, { status: "softening", arc: JSON.stringify([{ night: "2026-11-05", kind: "softening" }]) });
    const p1 = clampSleep({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ["a1"] }] },
      state({ traits: [g], quirks: [q], night: nightOf(ap("a1")) }));
    expect(p1.quirkUpdates[0]!.status).toBe("retired");
    const faded = p1.traitUpdates.find((t) => t.id === g.id)!;
    expect(faded.status).toBe("faded");

    const p2 = clampSleep({ items: [{ op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light again", evidence: ["b1"] }] },
      state({ traits: [faded], quirks: [], nowDay: "2026-12-01", nowMs: NOW + 11 * DAY, night: nightOf(ap("b1", { source: "backfill", day: "2026-11-30" })) }));
    expect(p2.traitInserts).toHaveLength(0);
    expect(p2.traitUpdates[0]!).toMatchObject({ id: g.id, status: "candidate", entrenchment: 1, live_points: 0, origin: "backfill", perspective: "first light again" });
    expect(JSON.parse(p2.traitUpdates[0]!.live_days)).toEqual([]);
  });
  it("end to end: retire -> trait faded -> next night CREATE same slug revives the row; quirk stays retired", async () => {
    const { db, DB, solId } = setup();
    db.prepare(
      "INSERT INTO creature_traits (id, creature_id, slug, category, perspective, entrenchment, live_points, live_days, origin, status, last_reinforced_at, created_at) VALUES ('tg', ?, 'dawn_feed', 'preference', 'first light', 5, 6, '[\"2026-09-01\"]', 'live', 'graduated', ?, ?)",
    ).run(solId, iso(NOW - 60 * DAY), iso(NOW - 90 * DAY));
    db.prepare(
      "INSERT INTO creature_quirks (id, creature_id, trait_id, title, trigger_json, behavior, resolution_json, kind, status, arc, promoted_at) VALUES ('q1', ?, 'tg', 'Dawn Feeding', '{\"time_band\":\"dawn\"}', 'waits on the rail', '{\"kind\":\"visits\",\"n\":2}', 'preference', 'softening', ?, ?)",
    ).run(solId, JSON.stringify([{ night: "2026-11-01", kind: "softening" }]), iso(NOW - 60 * DAY));
    const ids1 = [seedAppr(db, solId), seedAppr(db, solId), seedAppr(db, solId)];
    const r1 = await runSleepPass(env(DB), solId, fake(JSON.stringify({ items: [{ op: "DECAY", slug: "dawn_feed", delta: -1, evidence: ids1 }] })), NOW);
    expect(r1).toMatchObject({ ran: true, retired: 1 });
    expect((db.prepare("SELECT status FROM creature_traits WHERE id = 'tg'").get() as any).status).toBe("faded");
    expect((db.prepare("SELECT status FROM creature_quirks WHERE id = 'q1'").get() as any).status).toBe("retired");

    const later = NOW + 21 * H;
    const ids2 = [1, 2, 3].map(() => seedAppr(db, solId, { createdMs: later - H }));
    const r2 = await runSleepPass(env(DB), solId, fake(JSON.stringify({ items: [
      { op: "CREATE", slug: "dawn_feed", category: "preference", perspective: "first light again", evidence: ids2 },
    ] })), later);
    expect(r2).toMatchObject({ ran: true, created: 1 });
    const rows = db.prepare("SELECT * FROM creature_traits WHERE slug = 'dawn_feed'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "tg", status: "candidate", entrenchment: 1, origin: "live", perspective: "first light again" });
    expect(rows[0].live_points).toBeCloseTo(1);
    expect(JSON.parse(rows[0].live_days)).toEqual([chicagoDayOf(later - H)]);
    const qq = db.prepare("SELECT status, arc FROM creature_quirks WHERE id = 'q1'").get() as any;
    expect(qq.status).toBe("retired");
    expect(JSON.parse(qq.arc).map((e: any) => e.kind)).toEqual(["softening", "contradict", "retired"]);
  });
});

function chicagoDayOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
