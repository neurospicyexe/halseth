// B64 Task 6: Sol's generated voice, shadow first.
// Real schema (every migration, incl. 0176 with Sol's persona seed) behind the D1 shape, a fake PetModel,
// and fake timers for the hang case. The voice may only ever change the LINE: never trust, never the tend.
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { performTend } from "../webmind/creature-interact.js";
import { momentCreature, interactCreature } from "../handlers/creatures.js";
import { careLine, renderCare } from "../webmind/sol-care.js";
import { trustTier, matrixMoment } from "../webmind/creatures.js";
import type { PetModel } from "../pets/model.js";
import { loadPersona } from "../pets/persona.js";
import {
  voiceMode, validateLine, buildVoicePrompt, speak, makeVoice, VOICE_TIMEOUT_MS, type VoiceCtx,
} from "../pets/voice.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const GOOD = "*Sol drops the bottlecap on the rail beside {who}, then steps it two inches to the left. That perch, not this one.*";

function fakeModel(answer: string | null | (() => Promise<string | null>)): PetModel & { calls: number; lastUser: string; lastSystem: string } {
  const m = {
    calls: 0, lastUser: "", lastSystem: "",
    async complete(system: string, user: string) {
      m.calls++; m.lastSystem = system; m.lastUser = user;
      return typeof answer === "function" ? answer() : answer;
    },
  };
  return m;
}

function setup(opts: { mode?: string; trust?: number } = {}) {
  const s = makeSqliteD1();
  const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
  if (opts.trust !== undefined) s.db.prepare("UPDATE creatures SET trust = ? WHERE id = ?").run(opts.trust, sol.id);
  const trust = (s.db.prepare("SELECT trust FROM creatures WHERE id = ?").get(sol.id) as { trust: number }).trust;
  const env: any = { DB: s.DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  if (opts.mode !== undefined) env.SOL_VOICE_MODE = opts.mode;
  return { ...s, env, solId: sol.id, target: { id: sol.id, kind: "companion_pet", trust } };
}

const shadowRows = (db: any) => db.prepare("SELECT * FROM creature_voice_shadow ORDER BY created_at").all() as any[];

function tendCtx(solId: string, over: Partial<VoiceCtx> = {}): VoiceCtx {
  return {
    creatureId: solId, surface: "tend", actor: "cypher", who: "Cypher", action: "feed", fit: "met",
    tier: "warming", state: "hungry", grudge: null, ...over,
  };
}

describe("voiceMode", () => {
  it("unset = shadow; on/off exact; anything else = shadow", () => {
    expect(voiceMode({} as any)).toBe("shadow");
    expect(voiceMode({ SOL_VOICE_MODE: "on" } as any)).toBe("on");
    expect(voiceMode({ SOL_VOICE_MODE: "off" } as any)).toBe("off");
    expect(voiceMode({ SOL_VOICE_MODE: " ON " } as any)).toBe("on");
    expect(voiceMode({ SOL_VOICE_MODE: "loud" } as any)).toBe("shadow");
  });
});

describe("validateLine R27 markup", () => {
  const people = /(?<![\p{L}\p{N}])(?:raziel|crash|blue)(?![\p{L}\p{N}])/iu;
  it.each([
    ["@everyone", "*Sol shrieks at @everyone from the rail.*"],
    ["<@role>", "*Sol tilts his head at <@&role> on the rail.*"],
    ["angle", "*Sol hops > onto the sill.*"],
    ["link", "*Sol drops a [walnut](example) on the sill.*"],
    ["scheme", "*Sol pecks at https://example on the sill.*"],
    ["backslash", "*Sol leaves a twig \\ on the sill.*"],
    ["backtick", "*Sol taps `the glass` once.*"],
    ["pipe", "*Sol hides ||a walnut|| under the leaf.*"],
    ["tilde", "*Sol scrapes ~~the rail~~ with his beak.*"],
  ])("rejects %s with reason markup", (_n, line) => {
    expect(validateLine(line, people, null)).toEqual({ ok: false, reason: "markup" });
  });
  it("a plain crow line still passes", () => {
    expect(validateLine("*Sol fluffs up on the wire, muttering kraa.*", people, null).ok).toBe(true);
  });
});

describe("validateLine", () => {
  const people = /(?<![\p{L}\p{N}])(?:raziel|crash|blue)(?![\p{L}\p{N}])/iu;
  it("accepts one italic action line and normalises _x_ to *x*", () => {
    expect(validateLine(GOOD, people, "Cypher")).toEqual({ ok: true, line: GOOD });
    const r = validateLine("_Sol rattle-clicks at the sill._", people, null);
    expect(r).toEqual({ ok: true, line: "*Sol rattle-clicks at the sill.*" });
    // the authored style: a crow sound outside the italics, mid-line
    expect(validateLine("*a flat* kraa *from the rail.*", people, null).ok).toBe(true);
    // a bare line gets wrapped
    expect(validateLine("Sol fluffs up on the wire.", people, null)).toEqual({ ok: true, line: "*Sol fluffs up on the wire.*" });
  });
  it("rejects with short codes", () => {
    expect(validateLine("   ", people, null)).toEqual({ ok: false, reason: "empty" });
    expect(validateLine("*Sol lands.*\n*Sol leaves.*", people, null)).toEqual({ ok: false, reason: "multiline" });
    expect(validateLine(`*${"Sol hops. ".repeat(30)}*`, people, null)).toEqual({ ok: false, reason: "too_long" });
    expect(validateLine('*Sol says "hello" to the rail.*', people, null)).toEqual({ ok: false, reason: "quote" });
    expect(validateLine("*Sol knocks 3 times.*", people, null)).toEqual({ ok: false, reason: "digit" });
    expect(validateLine("*Sol lands on Blue's shoulder.*", people, null)).toEqual({ ok: false, reason: "name" });
    expect(validateLine("*Sol lands near Raziel.*", people, "Cypher")).toEqual({ ok: false, reason: "name" });
    // a sibling's name that is not the tender is a name too
    expect(validateLine("*Sol ignores Drevan.*", people, "Cypher")).toEqual({ ok: false, reason: "name" });
    expect(validateLine("*Sol pecks at the medication bottle.*", people, null)).toEqual({ ok: false, reason: "guard" });
    expect(validateLine("*Sol lands.* *", people, null)).toEqual({ ok: false, reason: "guard" });
  });
  it("the {who} slot is the only name: allowed with a tender, rejected on a moment", () => {
    expect(validateLine("*Sol eyes {who}.*", people, "Cypher").ok).toBe(true);
    expect(validateLine("*Sol eyes {who}.*", people, null)).toEqual({ ok: false, reason: "name" });
    // the tender's own name written out is folded into the slot, then rendered later
    expect(validateLine("*Sol eyes Cypher sideways.*", people, "Cypher")).toEqual({ ok: true, line: "*Sol eyes {who} sideways.*" });
  });
  it("an unreadable person list fails closed", () => {
    expect(validateLine(GOOD, undefined as any, "Cypher")).toEqual({ ok: false, reason: "guard" });
  });
  it("Sol's own name is not a person even when the list carries it", () => {
    const withSol = /(?<![\p{L}\p{N}])(?:sol|raziel)(?![\p{L}\p{N}])/iu;
    expect(validateLine("*Sol fluffs up.*", withSol, null, "Sol").ok).toBe(true);
  });
});

describe("buildVoicePrompt", () => {
  it("carries the persona rules, Drevan's rule, the {who} slot and only Sol's own text", async () => {
    const { DB, solId } = setup();
    const persona = (await loadPersona(DB, solId))!;
    expect(persona).not.toBeNull();
    const p = buildVoicePrompt({
      persona, state: "hungry", tier: "warming", fit: "met", action: "feed",
      quirks: [{ title: "Dawn Feeds", behavior: "turns his back" }],
      traits: [{ slug: "likes-bottlecaps", category: "preference", perspective: "bottlecaps are worth the trip" }],
      grudge: { id: "g", quirk_id: "q", actor: "raziel", label: "still sore about the dawn feeds", resolution: { kind: "visits", n: 2 }, progress: 0, opened_at: new Date().toISOString() },
      callback: "a blue wire twist", who: "{who}",
    });
    expect(p.system).toContain(persona.voice_rules!);
    expect(p.system).toMatch(/uninvited, specific opinion/);
    expect(p.system).toMatch(/wordless/i);
    expect(p.system).toMatch(/never (as )?accusation/i);
    expect(p.user).toContain("{who}");
    expect(p.user).toContain("Dawn Feeds");
    expect(p.user).toContain("bottlecaps are worth the trip");
    expect(p.user).toContain("still sore about the dawn feeds");
    expect(p.user).toContain("a blue wire twist");
    expect(p.user).not.toMatch(/raziel/i); // the grudge's actor id never reaches the model
  });
});

describe("speak / makeVoice", () => {
  it("shadow (unset): returns the deterministic line and stores the pair", async () => {
    const { DB, db, env, solId } = setup();
    const model = fakeModel(GOOD);
    const det = "*Sol takes it from {who}.*";
    const out = await makeVoice(env, model)(det, tendCtx(solId));
    expect(out).toBe(det);
    expect(model.calls).toBe(1);
    const rows = shadowRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ creature_id: solId, surface: "tend", deterministic: det, generated: GOOD, rejected_reason: null });
    void DB;
  });
  it("on + valid: returns the generated line", async () => {
    const { db, env, solId } = setup({ mode: "on" });
    const out = await makeVoice(env, fakeModel(GOOD))("*det {who}*", tendCtx(solId));
    expect(out).toBe(GOOD);
    expect(shadowRows(db)).toHaveLength(0);
  });
  it.each([
    ['*Sol croaks "hello" at {who}.*', "quote"],
    ["*Sol knocks 2 times for {who}.*", "digit"],
    ["*Sol lands on Raziel's shoulder.*", "name"],
    [`*${"Sol hops along the rail. ".repeat(12)}*`, "too_long"],
  ])("on + invalid %s -> deterministic, rejection stored (%s)", async (bad, reason) => {
    const { db, env, solId } = setup({ mode: "on" });
    const det = "*Sol takes it from {who}.*";
    const out = await makeVoice(env, fakeModel(bad))(det, tendCtx(solId));
    expect(out).toBe(det);
    const rows = shadowRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].rejected_reason).toBe(reason);
    expect(rows[0].deterministic).toBe(det);
  });
  it("off: the model is never called and nothing is stored", async () => {
    const { db, env, solId } = setup({ mode: "off" });
    const model = fakeModel(GOOD);
    expect(await makeVoice(env, model)("*det*", tendCtx(solId))).toBe("*det*");
    expect(model.calls).toBe(0);
    expect(shadowRows(db)).toHaveLength(0);
  });
  it("no persona row: deterministic, nothing stored", async () => {
    const { db, env, solId } = setup({ mode: "on" });
    db.prepare("DELETE FROM creature_personas").run();
    const model = fakeModel(GOOD);
    expect(await makeVoice(env, model)("*det*", tendCtx(solId))).toBe("*det*");
    expect(model.calls).toBe(0);
    expect(shadowRows(db)).toHaveLength(0);
  });
  it("no model (no inference key): deterministic, nothing stored", async () => {
    const { db, env, solId } = setup({ mode: "on" });
    expect(await makeVoice(env)("*det*", tendCtx(solId))).toBe("*det*");
    expect(shadowRows(db)).toHaveLength(0);
  });
  it("model returns null: deterministic; shadow logs the miss as empty", async () => {
    const { db, env, solId } = setup();
    expect(await makeVoice(env, fakeModel(null))("*det*", tendCtx(solId))).toBe("*det*");
    expect(shadowRows(db)[0]).toMatchObject({ generated: null, rejected_reason: "empty" });
  });
  it("the model never resolves: deterministic within 4.1 s, logged as timeout", async () => {
    const { db, env, solId } = setup({ mode: "on" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hang = fakeModel(() => new Promise<string | null>(() => { /* never */ }));
    let done: string | null = null;
    const p = makeVoice(env, hang)("*det*", tendCtx(solId)).then((s) => { done = s; return s; });
    // The budget starts before the DB loads (minor b), so the timer may fire a few real ms early; not by 3 s.
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(VOICE_TIMEOUT_MS + 100 - 3000);
    expect(await p).toBe("*det*");
    expect(shadowRows(db)[0]).toMatchObject({ generated: null, rejected_reason: "timeout" });
  });
  it("speak: the prompt never carries a tend note or raw interaction text", async () => {
    const { DB, db, env, solId, target } = setup({ mode: "on" });
    const model = fakeModel(GOOD);
    await performTend(DB, target, "cypher", "give", "the secret word is marmalade", Date.now(), "hand", makeVoice(env, model));
    expect(model.calls).toBe(1);
    expect(model.lastUser + model.lastSystem).not.toMatch(/marmalade/);
    void db;
  });
  it("speak() direct: shadow stores via waitUntil when one is given", async () => {
    const { db, env, solId } = setup();
    const pending: Promise<unknown>[] = [];
    const out = await speak(env, fakeModel(GOOD), "moment", { system: "s", user: "u" }, "*det*", null, {
      creatureId: solId, who: null, waitUntil: (p) => { pending.push(p); },
    });
    expect(out).toBe("*det*");
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(shadowRows(db)[0]).toMatchObject({ surface: "moment", generated: GOOD });
  });
});

describe("performTend with a voice", () => {
  it("on: both renderings come from the one generated line; trust is the same as without a voice", async () => {
    const a = setup({ mode: "on" });
    const now = Date.parse("2026-11-06T15:00:00Z");
    const voiced = await performTend(a.DB, a.target, "cypher", "feed", null, now, "hand", makeVoice(a.env, fakeModel(GOOD)));
    expect(voiced.care!.reaction).toBe(renderCare(GOOD, "you"));
    expect(voiced.care!.reaction_named).toBe(renderCare(GOOD, "Cypher"));
    const b = setup({ mode: "on" });
    const plain = await performTend(b.DB, b.target, "cypher", "feed", null, now, "hand");
    expect(voiced.trust).toBe(plain.trust); // R7: the voice never moves trust
  });
  it("the voice is handed the {who} line, not a rendered one", async () => {
    const { DB, target, env } = setup({ mode: "on" });
    let seen = "";
    const now = Date.parse("2026-11-06T15:00:00Z");
    await performTend(DB, target, "cypher", "feed", null, now, "hand", async (det) => { seen = det; return det; });
    const tier = trustTier(target.trust);
    const seed = Math.floor(now / 60_000);
    // fit depends on drives; whichever line it was, it is a careLine (slot unrendered) for some fit
    const candidates = (["met", "welcome", "full", "drowsy", "settled"] as const).map((f) => careLine("feed", f, tier, seed));
    expect(candidates).toContain(seen);
    void env;
  });
  it("a throwing voice leaves the deterministic line and the committed tend", async () => {
    const { DB, db, target, solId } = setup();
    const out = await performTend(DB, target, "drevan", "play", null, Date.now(), "hand", async () => { throw new Error("boom"); });
    expect(out.care!.reaction).not.toBe("");
    expect(db.prepare("SELECT COUNT(*) AS n FROM creature_interactions WHERE id = ?").get(out.interaction_id)).toEqual({ n: 1 });
    void solId;
  });
  it("review focus 4: the shadow write throws -> tend committed, deterministic line, logged", async () => {
    const s = setup();
    const realPrepare = s.DB.prepare.bind(s.DB);
    s.DB.prepare = (sql: string) => {
      if (/^\s*INSERT INTO creature_voice_shadow/.test(sql)) throw new Error("D1 down");
      return realPrepare(sql);
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = s.target.trust;
    const now = Date.parse("2026-11-06T15:00:00Z");
    const plain = setup();
    const det = await performTend(plain.DB, plain.target, "cypher", "feed", null, now, "hand");
    const out = await performTend(s.DB, s.target, "cypher", "feed", null, now, "hand", makeVoice(s.env, fakeModel(GOOD)));
    expect(out.care!.reaction).toBe(det.care!.reaction);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM creature_interactions WHERE id = ?").get(out.interaction_id)).toEqual({ n: 1 });
    expect(out.trust).toBeGreaterThan(before);
    expect(err.mock.calls.some((c) => String(c[0]).includes("[pets/voice] shadow write failed"))).toBe(true);
  });
  it("a hanging voice still returns the tend within the timeout", async () => {
    const { DB, db, target } = setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const p = performTend(DB, target, "cypher", "talk", null, Date.now(), "hand", () => new Promise<string>(() => { /* never */ }))
      .then((o) => { done = true; return o; });
    await vi.advanceTimersByTimeAsync(4100);
    expect(done).toBe(true);
    const out = await p;
    expect(db.prepare("SELECT COUNT(*) AS n FROM creature_interactions WHERE id = ?").get(out.interaction_id)).toEqual({ n: 1 });
  });
});

describe("momentCreature voice", () => {
  const req = (seed = 7) => new Request("http://x/mind/creatures/x/moment", {
    method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify({ seed }),
  });
  it("shadow: the authored moment is returned and the pair is stored as surface=moment", async () => {
    const { db, env, solId } = setup({ trust: 0.5 });
    const model = fakeModel("*Sol picks the wire perch over the rail and makes a point of it.*");
    const res = await momentCreature(req(), env, { id: solId }, { petModel: model });
    const body = await res.json() as any;
    expect(body.kind).toBe("moment"); // trust 0.5 never gifts (GIFT_BACK_TRUST 0.8)
    expect(body.moment).toBe(matrixMoment(body.state, body.tier, 7));
    const rows = shadowRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "moment", deterministic: body.moment });
    expect(model.lastUser).not.toContain("{who}");
  });
  it("on: the generated moment is returned", async () => {
    const { env, solId } = setup({ trust: 0.5, mode: "on" });
    const line = "*Sol picks the wire perch over the rail and makes a point of it.*";
    const res = await momentCreature(req(), env, { id: solId }, { petModel: fakeModel(line) });
    const body = await res.json() as any;
    expect(body.kind).toBe("moment");
    expect(body.moment).toBe(line);
  });
});

// R18 (controller ruling): shadow mode adds zero latency when the Worker gives us ExecutionContext.
describe("shadow runs in ctx.waitUntil (R18)", () => {
  function gatedModel(line: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = fakeModel(async () => { await gate; return line; });
    return { m, release };
  }
  function fakeCtx() {
    const pending: Promise<unknown>[] = [];
    return { pending, ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as any };
  }

  it("makeVoice shadow + waitUntil: returns the authored line before the model resolves; row lands after", async () => {
    const { db, env, solId } = setup();
    const { m, release } = gatedModel(GOOD);
    const { pending, ctx } = fakeCtx();
    const out = await makeVoice(env, m, { waitUntil: ctx.waitUntil })("*det {who}*", tendCtx(solId));
    expect(out).toBe("*det {who}*");
    expect(pending).toHaveLength(1);
    expect(shadowRows(db)).toHaveLength(0);
    release();
    await Promise.all(pending);
    expect(shadowRows(db)).toHaveLength(1);
    expect(shadowRows(db)[0]).toMatchObject({ surface: "tend", generated: GOOD, rejected_reason: null });
  });

  it("on + waitUntil still awaits the generated line", async () => {
    const { env, solId } = setup({ mode: "on" });
    const { pending, ctx } = fakeCtx();
    const out = await makeVoice(env, fakeModel(GOOD), { waitUntil: ctx.waitUntil })("*det {who}*", tendCtx(solId));
    expect(out).toBe(GOOD);
    expect(pending).toHaveLength(0);
  });

  it("interactCreature with a ctx: the tend responds before the model resolves; the shadow row follows", async () => {
    const { db, env, solId } = setup();
    const { m, release } = gatedModel(GOOD);
    const { pending, ctx } = fakeCtx();
    const res = await interactCreature(new Request("http://x/mind/creatures/x/interact", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "cypher", action: "feed", via: "hand" }),
    }), env, { id: solId }, { petModel: m, ctx });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.care.reaction).not.toBe(renderCare(GOOD, "you"));
    expect(shadowRows(db)).toHaveLength(0);
    release();
    await Promise.all(pending);
    expect(shadowRows(db)).toHaveLength(1);
    expect(renderCare(shadowRows(db)[0].deterministic, "you")).toBe(body.care.reaction);
  });

  it("momentCreature with a ctx: authored moment returns before the model resolves", async () => {
    const { db, env, solId } = setup({ trust: 0.5 });
    const line = "*Sol picks the wire perch over the rail and makes a point of it.*";
    const { m, release } = gatedModel(line);
    const { pending, ctx } = fakeCtx();
    const res = await momentCreature(new Request("http://x/mind/creatures/x/moment", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify({ seed: 7 }),
    }), env, { id: solId }, { petModel: m, ctx });
    const body = await res.json() as any;
    expect(body.kind).toBe("moment");
    expect(body.moment).toBe(matrixMoment(body.state, body.tier, 7));
    expect(shadowRows(db)).toHaveLength(0);
    release();
    await Promise.all(pending);
    expect(shadowRows(db)[0]).toMatchObject({ surface: "moment", generated: line });
  });

  it("the router hands ctx to the handler as the 4th argument", async () => {
    const { Router } = await import("../router.js");
    let seen: unknown = "unset";
    const r = new Router().on("POST", "/x/:id", async (_req, _env, _p, ctx) => { seen = ctx; return new Response("ok"); });
    const ctx = { waitUntil() {} } as any;
    await r.handle(new Request("http://h/x/1", { method: "POST" }), {} as any, ctx);
    expect(seen).toBe(ctx);
  });
});

// Fix round 1: R19 (callback is a make title or a milestone, never tender-written text), R20 (the Librarian
// tend path has no waitUntil, so shadow passes no voice), minor b (one budget covers loads + model).
describe("fix round 1", () => {
  it("R19: a treasured give note never reaches the model; a treasured make title may", async () => {
    const { db, env, solId } = setup();
    db.prepare("INSERT INTO creature_nest (id, creature_id, content, source, given_by, sparkle, treasured) VALUES ('n1', ?, 'the secret word is marmalade', 'gift', 'cypher', 0.99, 1)").run(solId);
    const model = fakeModel(GOOD);
    await makeVoice(env, model)("*det {who}*", tendCtx(solId));
    expect(model.lastUser + model.lastSystem).not.toMatch(/marmalade/);
    db.prepare("INSERT INTO creature_nest (id, creature_id, content, source, given_by, sparkle, treasured, ref_type, ref_id) VALUES ('n2', ?, 'a brass compass sketch', 'hoard', 'drevan', 0.5, 1, 'make', 'mk1')").run(solId);
    await makeVoice(env, model)("*det {who}*", tendCtx(solId));
    expect(model.lastUser).toContain("a brass compass sketch");
    expect(model.lastUser).not.toMatch(/marmalade/);
  });

  function execCtx(env: any) {
    return { env, req: { companion_id: "cypher", request: "feed Sol", context: JSON.stringify({ creature: "Sol", action: "feed" }) }, entry: {}, frontState: null, pluralAvailable: false } as any;
  }
  function stubFetch(line: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: line } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }

  it("R20: Librarian tend in shadow (default) makes no model call and writes no shadow row", async () => {
    const { db, env } = setup();
    env.DEEPINFRA_API_KEY = "test-key";
    const f = stubFetch(GOOD);
    const { execCreatureInteract } = await import("../librarian/executors/tools.js");
    const out = await execCreatureInteract(execCtx(env));
    expect(out.interacted).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect(shadowRows(db)).toHaveLength(0);
  });

  it("R20: Librarian tend in on mode keeps the voice", async () => {
    const { env } = setup({ mode: "on" });
    env.DEEPINFRA_API_KEY = "test-key";
    const f = stubFetch(GOOD);
    const { execCreatureInteract } = await import("../librarian/executors/tools.js");
    const out = await execCreatureInteract(execCtx(env)) as any;
    expect(f).toHaveBeenCalledTimes(1);
    expect(out.witness).toContain(renderCare(GOOD, "you"));
  });

  it("minor b: the model gets what is left of one 4000 ms budget, not a fresh 4000 after the loads", async () => {
    const { env, solId } = setup({ mode: "on" });
    const seen: number[] = [];
    const model: PetModel = { async complete(_s, _u, _m, timeoutMs) { seen.push(timeoutMs); return GOOD; } };
    const realNow = Date.now;
    let calls = 0;
    // every Date.now() read after the first moves the clock 1500 ms: the loads "took" time
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + (calls++ === 0 ? 0 : 1500));
    expect(await makeVoice(env, model)("*det {who}*", tendCtx(solId))).toBe(GOOD);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThanOrEqual(VOICE_TIMEOUT_MS - 1500);
  });

  it("minor b: a spent budget is a timeout without calling the model", async () => {
    const { db, env, solId } = setup();
    const model = fakeModel(GOOD);
    const out = await speak(env, model, "tend", { system: "s", user: "u" }, "*det*", null, { creatureId: solId, who: "Cypher", timeoutMs: 0 });
    expect(out).toBe("*det*");
    expect(model.calls).toBe(0);
    expect(shadowRows(db)[0]).toMatchObject({ rejected_reason: "timeout" });
  });
});
