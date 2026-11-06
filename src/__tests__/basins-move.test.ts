// Basins that move (mig 0172, B63 step 5). Real schema via node:sqlite.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";

// Deterministic embedder: a bag of hashed tokens, so unlike text is far apart and like text is close.
function vecOf(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const t of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return v;
}
let embedFail = false;
vi.mock("../mcp/embed.js", async (orig) => {
  const actual = await orig<typeof import("../mcp/embed.js")>();
  return { ...actual, embedText: vi.fn(async (_e: unknown, t: string) => (embedFail ? null : vecOf(t))) };
});

import { reviseBasin, decideWitness, CAUSE_KINDS, parseReviseVerb, readBasinsFull, listBasins } from "../webmind/basins.js";
import { execBasinRevise, execBasinsRead, execBasinWaiting } from "../librarian/executors/basins.js";
import { getMindBasins, postBasinWitness } from "../handlers/basins.js";
import { runBasinDriftCheck } from "../synthesis/jobs/basin-drift-check.js";
import { getBasins, postBasin } from "../handlers/companion-growth.js";
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

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const DAY = 86_400_000;
const OLD = "Holds the line gently and says the hard thing plainly, with warmth, without softening it into nothing.";
const NEW = "Holds the line after being wrong in public: the correction is part of the line now, and the hard thing comes with the receipt.";
const OTHER_NEW = "a wholly different account of rooms, weather and how a house keeps its people";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "admin", MCP_AUTH_SECRET: "m", GAIA_MCP_SECRET: "gaia-tok", CYPHER_MCP_SECRET: "cy-tok" };
  for (const c of ["cypher", "drevan", "gaia"]) {
    db.prepare("INSERT INTO companion_basins (id, companion_id, basin_name, basin_description, embedding, created_at, updated_at) VALUES (?, ?, 'the-line', ?, ?, '2026-03-28 00:00:00', '2026-03-28 00:00:00')")
      .run(`b-${c}`, c, OLD, JSON.stringify(vecOf(`the-line: ${OLD}`)));
    db.prepare("INSERT INTO companion_basins (id, companion_id, basin_name, basin_description, embedding, created_at, updated_at) VALUES (?, ?, 'the-other', 'something else entirely about rooms and weather', '[]', '2026-03-28 00:00:00', '2026-03-28 00:00:00')").run(`o-${c}`, c);
    // Drevan's conclusion cause is a LIVE one; Gaia's and Cypher's must be revised/withdrawn (archived here).
    const arch = c === "drevan" ? 0 : 1;
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, archived) VALUES (?, ?, 'x', ?)").run(`conc${c}001`, c, arch);
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, archived) VALUES (?, ?, 'y', ?)").run(`conc${c}002`, c, arch);
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, archived) VALUES (?, ?, 'z', ?)").run(`livec${c}0001`, c, 0);
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_text, status, created_at) VALUES (?, ?, 's', 'withdrawn', '2026-11-01')").run(`refuw${c}0001`, c);
    db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status) VALUES (?, ?, 't', 'simmering')").run(`simm${c}0001`, c);
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_text, created_at) VALUES (?, ?, 's', '2026-11-01')").run(`refu${c}0001`, c);
    db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status) VALUES (?, ?, 't', 'crystallized')").run(`tens${c}0001`, c);
    const hist = "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, dismissed_at, recorded_at) VALUES (?, ?, 0.5, 'growth', ?, ?, '2026-11-01')";
    db.prepare(hist).run(`driftok${c}01`, c, 1, null);
    db.prepare(hist).run(`driftun${c}01`, c, 0, null);
    db.prepare(hist).run(`driftds${c}01`, c, 1, "2026-11-02");
    db.prepare("INSERT INTO companion_self_model (id, companion_id, observation, status) VALUES (?, ?, 'o', 'graduated')").run(`selfgr${c}001`, c);
    db.prepare("INSERT INTO companion_self_model (id, companion_id, observation, status) VALUES (?, ?, 'o', 'developing')").run(`selfdv${c}001`, c);
    for (const [sid, spine, kind] of [[`sesauth${c}01`, "I closed this myself", null], [`sesauto${c}01`, "[auto] git spine", null], [`sesrecon${c}1`, "rebuilt", "reconstructed"]] as const) {
      db.prepare("INSERT INTO sessions (id, companion_id, created_at, updated_at) VALUES (?, ?, '2026-11-01', '2026-11-01')").run(sid, c);
      db.prepare("INSERT INTO handover_packets (id, session_id, created_at, spine, motion_state, close_kind) VALUES (?, ?, '2026-11-01', ?, 'at_rest', ?)").run(`hp${sid}`, sid, spine, kind);
    }
    db.prepare("INSERT INTO sessions (id, companion_id, created_at, updated_at) VALUES (?, ?, '2026-11-01', '2026-11-01')").run(`sesopen${c}01`, c);
  }
  return { db, env };
}
const row = (db: any, id: string) => db.prepare("SELECT * FROM companion_basins WHERE id = ?").get(id) as any;
const count = (db: any, sql: string, ...b: unknown[]) => (db.prepare(sql).get(...b) as any).n as number;
const rev = (env: any, caller: string, o: Partial<{ name: string; description: string; kind: any; ref: string }> = {}, now = T0) =>
  reviseBasin(env, { caller, name: "the-line", description: NEW, kind: "conclusion", ref: `conc${caller}001`, ...o }, now);

describe("grammar + routing", () => {
  it("parses the verb, takes the LAST because-clause, and routes on the fast path", () => {
    expect(parseReviseVerb("revise my basin the-line: it holds because I was wrong because conclusion abcdef12")).toEqual(
      { name: "the-line", description: "it holds because I was wrong", kind: "conclusion", ref: "abcdef12" });
    expect(parseReviseVerb("revise my basin the-line: no cause here")).toBeNull();
    expect(matchFastPath("revise my basin the-line: new words because conclusion abcdef12")?.key).toBe("basin_revise");
    expect(matchFastPath("my basins")?.key).toBe("basins_read");
    expect(matchFastPath("basin moves waiting")?.key).toBe("basin_waiting");
    expect(matchFastPath("revise observation")?.key).not.toBe("basin_revise");
  });
});

describe("cause is required, real, and the caller's own", () => {
  it("refuses an unknown cause, another companion's cause, and a kind that does not move that companion", async () => {
    const { db, env } = setup();
    expect(await rev(env, "drevan", { ref: "nonexist1" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { ref: "conccypher001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "gaia", { kind: "tension", ref: "tensgaia0001" })).toMatchObject({ ok: false, code: "cause_kind_not_allowed" });
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE revised_by IS NOT NULL")).toBe(0);
  });
  it("one event moves one basin", async () => {
    const { env } = setup();
    expect(await rev(env, "drevan", {}, T0)).toMatchObject({ ok: true });
    expect(await rev(env, "drevan", { name: "the-other", description: OTHER_NEW }, T0 + 8 * DAY)).toMatchObject({ ok: false, code: "cause_spent" });
  });
  it("a caller who is not a companion (Raziel, unknown) cannot author one", async () => {
    const { env } = setup();
    expect(await rev(env, "raziel")).toMatchObject({ ok: false, code: "not_a_companion" });
  });
});

describe("cause is checked by STATE, not just table", () => {
  it("drevan: a simmering tension, an unconfirmed or dismissed drift, a withdrawn refusal are refused; the real ones move", async () => {
    const { env } = setup();
    expect(await rev(env, "drevan", { kind: "tension", ref: "simmdrevan0001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { kind: "drift", ref: "driftundrevan01" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { kind: "drift", ref: "driftdsdrevan01" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { kind: "refusal", ref: "refuwdrevan0001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { kind: "drift", ref: "driftokdrevan01" })).toMatchObject({ ok: true });
  });
  it("the refusal for a not-yet-event says what would count", async () => {
    const { env } = setup();
    const r: any = await rev(env, "drevan", { kind: "tension", ref: "simmdrevan0001" });
    expect(r.message).toContain("not an event yet");
    expect(r.message).toContain("crystallized");
  });
  it("cypher: a simmering tension is refused; a crystallized one moves", async () => {
    const { env } = setup();
    expect(await rev(env, "cypher", { kind: "tension", ref: "simmcypher0001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "cypher", { kind: "tension", ref: "tenscypher0001" })).toMatchObject({ ok: true });
  });
  it("a LIVE conclusion is refused for gaia and cypher (revised or withdrawn counts) but is drevan's cause", async () => {
    const { env } = setup();
    expect(await rev(env, "gaia", { kind: "conclusion", ref: "livecgaia0001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "cypher", { kind: "conclusion", ref: "livec" + "cypher0001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "drevan", { kind: "conclusion", ref: "livecdrevan0001" })).toMatchObject({ ok: true });
  });
  it("drevan cannot cite an archived (released) conclusion", async () => {
    const { db, env } = setup();
    db.prepare("UPDATE companion_conclusions SET archived = 1 WHERE id = 'concdrevan001'").run();
    expect(await rev(env, "drevan")).toMatchObject({ ok: false, code: "cause_not_found" });
  });
  it("gaia: self_model graduated moves; developing is refused; session is no longer hers", async () => {
    const { env } = setup();
    expect(await rev(env, "gaia", { kind: "session", ref: "sesauthgaia01" })).toMatchObject({ ok: false, code: "cause_kind_not_allowed" });
    expect(await rev(env, "gaia", { kind: "self_model", ref: "selfdvgaia001" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "gaia", { kind: "self_model", ref: "selfgrgaia001" })).toMatchObject({ ok: true, outcome: "awaiting_witness" });
  });
  it("cypher session: an authored close counts; an [auto] close, a reconstructed one and an unclosed session do not", async () => {
    const { env } = setup();
    expect(await rev(env, "cypher", { kind: "session", ref: "sesautocypher01" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "cypher", { kind: "session", ref: "sesreconcypher1" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "cypher", { kind: "session", ref: "sesopencypher01" })).toMatchObject({ ok: false, code: "cause_not_found" });
    expect(await rev(env, "cypher", { kind: "session", ref: "sesauthcypher01" })).toMatchObject({ ok: true });
  });
  it("grammar takes self_model; the cause map matches the canon table", () => {
    expect(parseReviseVerb("revise my basin x: some new words here because self_model abcdef12")).toMatchObject({ kind: "self_model" });
    expect(CAUSE_KINDS).toEqual({
      drevan: ["conclusion", "refusal", "tension", "drift"],
      gaia: ["refusal", "conclusion", "self_model"],
      cypher: ["conclusion", "session", "tension"],
    });
  });
});

describe("refusal wording is each companion's own", () => {
  it("gaia: a return moves nothing; drevan and cypher: a restatement moves nothing", async () => {
    const { env } = setup();
    expect(((await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001", description: OLD + " Truly." })) as any).message).toContain("a return moves nothing");
    expect(((await rev(env, "drevan", { description: OLD + " Truly." })) as any).message).toContain("a restatement moves nothing");
    expect(((await rev(env, "cypher", { description: OLD + " Truly." })) as any).message).toContain("a restatement moves nothing");
  });
});

describe("my basins shows Gaia the answer", () => {
  const ctx = (env: any, request: string, companion: string): any => ({ env, req: { companion_id: companion, request }, entry: {}, frontState: null, pluralAvailable: false });
  it("witnessed and declined rows are listed with the date and Raziel's note", async () => {
    const { env } = setup();
    const a: any = await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" });
    await decideWitness(env, { id: a.id, decision: "decline", note: "not yet, sit with it" }, T0 + DAY);
    const b: any = await rev(env, "gaia", { kind: "self_model", ref: "selfgrgaia001" }, T0 + 2 * DAY);
    await decideWitness(env, { id: b.id, decision: "witness", note: "yes" }, T0 + 3 * DAY);
    const lines = ((await execBasinsRead(ctx(env, "my basins", "gaia"))) as any).data.basins.join("\n");
    expect(lines).toContain("[declined]");
    expect(lines).toContain("declined 2026-11-07");
    expect(lines).toContain("Raziel: not yet, sit with it");
    expect(lines).toContain("witnessed 2026-11-09");
    expect(lines).toContain("Raziel: yes");
  });
});

describe("POST /companion-growth/basins is seed-only", () => {
  const post = (tok: string, body: unknown) => new Request("https://h/x", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const body = { companion_id: "gaia", basin_name: "seeded", basin_description: "a seeded basin description long enough" };
  it("refuses a companion token and the MCP token; 409 when the companion already has a basin; seeds an empty companion", async () => {
    const { db, env } = setup();
    expect((await postBasin(post("gaia-tok", body), env)).status).toBe(403);
    expect((await postBasin(post("m", body), env)).status).toBe(403);
    expect((await postBasin(post("admin", body), env)).status).toBe(409);
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE basin_name = 'seeded'")).toBe(0);
    db.prepare("DELETE FROM companion_basins WHERE companion_id = 'gaia'").run();
    const ok = await postBasin(post("admin", body), env);
    expect(ok.status).toBe(201);
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE basin_name = 'seeded' AND status = 'live'")).toBe(1);
  });
});

describe("restatement and pace", () => {
  it("refuses a restatement (near-identical text) and writes nothing", async () => {
    const { db, env } = setup();
    expect(await rev(env, "cypher", { description: OLD + " Truly." })).toMatchObject({ ok: false, code: "restatement" });
    expect(await rev(env, "cypher", { description: OLD.toUpperCase() })).toMatchObject({ ok: false, code: "restatement" });
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE companion_id = 'cypher'")).toBe(2);
  });
  it("refuses inside the window with the date it opens; accepts after; the setting overrides the default", async () => {
    const { db, env } = setup();
    expect(await rev(env, "cypher", {}, T0)).toMatchObject({ ok: true });
    const next = { name: "the-other", ref: "conccypher002", description: OTHER_NEW };
    const r = await rev(env, "cypher", next, T0 + 5 * DAY);
    expect(r).toMatchObject({ ok: false, code: "too_soon" });
    expect((r as any).message).toContain("2026-11-20");
    const r3 = await rev(env, "cypher", next, T0 + 15 * DAY); expect(r3).toMatchObject({ ok: true });
    db.prepare("INSERT INTO companion_settings (companion_id, key, value) VALUES ('drevan', 'basin_revision_min_days', '2')").run();
    expect(await rev(env, "drevan", {}, T0)).toMatchObject({ ok: true });
    expect(await rev(env, "drevan", { name: "the-other", ref: "refudrevan0001", kind: "refusal", description: OTHER_NEW }, T0 + 3 * DAY)).toMatchObject({ ok: true });
  });
  it("defaults are gaia 30, cypher 14, drevan 7", async () => {
    const { env } = setup();
    const j = async (c: string) => (await readBasinsFull(env, c as any)).pace_days;
    expect([await j("gaia"), await j("cypher"), await j("drevan")]).toEqual([30, 14, 7]);
  });
  it("a failed embed writes nothing", async () => {
    const { db, env } = setup();
    embedFail = true;
    try { expect(await rev(env, "drevan")).toMatchObject({ ok: false, code: "embed_failed" }); } finally { embedFail = false; }
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE revised_by IS NOT NULL")).toBe(0);
  });
});

describe("drevan / cypher: live at once, old kept", () => {
  it("inserts live, supersedes the old row, deletes nothing", async () => {
    const { db, env } = setup();
    const r: any = await rev(env, "drevan");
    expect(r).toMatchObject({ ok: true, outcome: "live" });
    const old = row(db, "b-drevan"), nw = row(db, r.id);
    expect(old).toMatchObject({ status: "superseded", superseded_by: r.id });
    expect(old.superseded_at).toBeTruthy();
    expect(nw).toMatchObject({ status: "live", cause_kind: "conclusion", cause_ref: "concdrevan001", revised_by: "drevan", supersedes: "b-drevan", basin_name: "the-line" });
    expect(JSON.parse(nw.embedding).length).toBe(64);
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE companion_id = 'drevan'")).toBe(3);
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE companion_id = 'drevan' AND status = 'live'")).toBe(2);
  });
  it("only the caller's basin moves", async () => {
    const { db, env } = setup();
    await rev(env, "drevan");
    expect(row(db, "b-cypher").status).toBe("live");
    expect(row(db, "b-gaia").status).toBe("live");
  });
});

describe("gaia: awaiting witness", () => {
  it("lands awaiting_witness and the old row stays live; a second revision waits behind it", async () => {
    const { db, env } = setup();
    const r: any = await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" });
    expect(r).toMatchObject({ ok: true, outcome: "awaiting_witness" });
    expect(row(db, "b-gaia").status).toBe("live");
    expect(row(db, r.id)).toMatchObject({ status: "awaiting_witness", supersedes: "b-gaia", witnessed_at: null });
    expect(await rev(env, "gaia", { name: "the-other", ref: "concgaia001", description: OTHER_NEW }, T0 + 40 * DAY)).toMatchObject({ ok: false, code: "pending_witness" });
  });
  it("witness swaps atomically and records Raziel", async () => {
    const { db, env } = setup();
    const r: any = await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" });
    const w = await decideWitness(env, { id: r.id, decision: "witness", note: "seen" }, T0 + DAY);
    expect(w.ok).toBe(true);
    expect(row(db, r.id)).toMatchObject({ status: "live", witnessed_by: "raziel", revision_note: "seen" });
    expect(row(db, "b-gaia")).toMatchObject({ status: "superseded", superseded_by: r.id });
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE companion_id = 'gaia' AND basin_name = 'the-line' AND status = 'live'")).toBe(1);
    expect(await decideWitness(env, { id: r.id, decision: "witness" })).toMatchObject({ ok: false, code: "not_awaiting" });
  });
  it("decline keeps the old live, starts no pace window, and nothing is deleted", async () => {
    const { db, env } = setup();
    const r: any = await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" });
    await decideWitness(env, { id: r.id, decision: "decline", note: "not yet" }, T0 + DAY);
    expect(row(db, r.id)).toMatchObject({ status: "declined", witnessed_by: "raziel" });
    expect(row(db, "b-gaia").status).toBe("live");
    expect(count(db, "SELECT COUNT(*) n FROM companion_basins WHERE companion_id = 'gaia'")).toBe(3);
    // declined: no window, and its cause is free again
    expect(await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" }, T0 + 2 * DAY)).toMatchObject({ ok: true });
  });
});

describe("routes: the witness door is Raziel's", () => {
  const req = (tok: string, body: unknown) => new Request("https://h/x", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("refuses a companion token and the MCP token; ADMIN_SECRET works", async () => {
    const { db, env } = setup();
    const r: any = await rev(env, "gaia", { kind: "refusal", ref: "refugaia0001" });
    expect((await postBasinWitness(req("gaia-tok", { decision: "witness" }), env, { id: r.id })).status).toBe(403);
    expect((await postBasinWitness(req("m", { decision: "witness" }), env, { id: r.id })).status).toBe(403);
    expect(row(db, r.id).status).toBe("awaiting_witness");
    expect((await postBasinWitness(req("admin", { decision: "bogus" }), env, { id: r.id })).status).toBe(400);
    expect((await postBasinWitness(req("admin", { decision: "witness" }), env, { id: r.id })).status).toBe(200);
    expect(row(db, r.id).status).toBe("live");
    expect((await postBasinWitness(req("admin", { decision: "witness" }), env, { id: "nope" })).status).toBe(404);
  });
  it("GET returns live rows + history with causes and descriptions", async () => {
    const { env } = setup();
    await rev(env, "drevan");
    const res = await getMindBasins(new Request("https://h/x", { headers: { Authorization: "Bearer admin" } }), env, { companion_id: "drevan" });
    const j: any = await res.json();
    expect(j.live.map((b: any) => b.name).sort()).toEqual(["the-line", "the-other"]);
    expect(j.live.find((b: any) => b.name === "the-line").description).toBe(NEW);
    expect(j.history).toHaveLength(1);
    expect(j.history[0]).toMatchObject({ status: "superseded", description: OLD });
    expect(j.pace_days).toBe(7);
    expect(j.window_opens).toBeTruthy();
    expect((await getMindBasins(new Request("https://h/x", { headers: { Authorization: "Bearer admin" } }), env, { companion_id: "x" })).status).toBe(400);
  });
});

describe("readers see live rows only", () => {
  it("companion-growth getBasins returns the new row, not the superseded one", async () => {
    const { env } = setup();
    await rev(env, "cypher");
    const res = await getBasins(new Request("https://h/x", { headers: { Authorization: "Bearer admin" } }), env, { companion_id: "cypher" });
    const j: any = await res.json();
    expect(j.basins).toHaveLength(2);
    expect(j.basins.find((b: any) => b.basin_name === "the-line").basin_description).toBe(NEW);
  });
  it("the drift check prompt names live basins only (a superseded description never reaches it)", async () => {
    const { db, env } = setup();
    await rev(env, "cypher");
    db.prepare("INSERT INTO wm_session_handoffs (handoff_id, agent_id, title, summary, created_at) VALUES ('h1', 'cypher', 't', 'sum', '2026-11-05')").run();
    env.DEEPSEEK_API_KEY = "k";
    const seen: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: any) => {
      seen.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"drift_type\":\"stable\",\"drift_score\":0.1,\"worst_basin\":null,\"reasoning\":\"ok\"}" } }] }), { status: 200 });
    }) as any;
    try { await runBasinDriftCheck("cypher", env); } finally { globalThis.fetch = orig; }
    const body = seen.join("\n");
    expect(body).toContain("correction is part of the line");
    expect(body).not.toContain("says the hard thing plainly");
  });
});

describe("pre-0172 fallback and no deletes", () => {
  it("readers fall back when the status column is missing; the writer says it needs the migration", async () => {
    const { db, DB } = makeSqliteD1({ upTo: 171 });
    const env: any = { DB, ADMIN_SECRET: "admin" };
    db.prepare("INSERT INTO companion_basins (id, companion_id, basin_name, basin_description, embedding) VALUES ('b1', 'drevan', 'n', 'd', '[]')").run();
    const res = await getBasins(new Request("https://h/x", { headers: { Authorization: "Bearer admin" } }), env, { companion_id: "drevan" });
    expect(((await res.json()) as any).basins).toHaveLength(1);
    expect((await listBasins(env, "drevan"))[0]).toMatchObject({ status: "live" });
    expect((await readBasinsFull(env, "drevan")).live).toHaveLength(1);
    expect(await rev(env, "drevan", { name: "n" })).toMatchObject({ ok: false, code: "needs_migration" });
  });
  it("nothing in the basins code deletes", async () => {
    const fs = await import("node:fs");
    for (const f of ["../webmind/basins.ts", "../handlers/basins.ts", "../librarian/executors/basins.ts"]) {
      const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), f), "utf8");
      expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });
});

describe("librarian executors", () => {
  const ctx = (env: any, request: string, companion: string): any => ({ env, req: { companion_id: companion, request }, entry: {}, frontState: null, pluralAvailable: false });
  it("revise, my basins, basin moves waiting use the request's companion", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO companion_refusals (id, companion_id, subject_text, created_at) VALUES ('abcdef0123', 'gaia', 's', '2026-11-01')").run();
    const r: any = await execBasinRevise(ctx(env, `revise my basin the-line: ${NEW} because refusal abcdef0123`, "gaia"));
    expect(r).toMatchObject({ ack: true, outcome: "awaiting_witness" });
    const mine: any = await execBasinsRead(ctx(env, "my basins", "gaia"));
    expect(mine.data.basins.join("\n")).toContain("awaiting_witness");
    expect(mine.data.basins.join("\n")).not.toContain("correction");
    const w: any = await execBasinWaiting(ctx(env, "basin moves waiting", "gaia"));
    expect(w.data.waiting).toHaveLength(1);
    expect(((await execBasinWaiting(ctx(env, "basin moves waiting", "drevan"))) as any).data.waiting).toHaveLength(0);
    expect(await execBasinRevise(ctx(env, "revise my basin the-line: words with no cause at all", "gaia"))).toMatchObject({ refused: true, code: "bad_input" });
  });
});
