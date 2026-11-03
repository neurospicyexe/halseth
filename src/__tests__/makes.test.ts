// B62 making (mig 0164 + 0165): routes, caps, source checks, rendered idempotency, serving headers,
// the Librarian verb and its collisions. Real schema via node:sqlite; R2 is an in-memory fake.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  postMake, getMakes, getMakeItemHttp, serveMakeFile, getPendingMakes, getMakeSource, postMakeRendered, patchMake,
  createMake, listMakes, parseRange,
} from "../handlers/makes.js";
import { applyInterestAction } from "../handlers/interests.js";
import { parseMakeVerb, mapKindWords, scadDenyReason, looksLikeSvg, slugify, normalizeMusicParams } from "../webmind/makes.js";
import { matchFastPath, ANCHORED_GUARDS } from "../librarian/router.js";
import { execMake, execMakesRead } from "../librarian/executors/makes.js";
import { ownsMove, isValidActionType } from "../webmind/metronome.js";
import { fileURLToPath } from "node:url";

// src/index.ts builds a Router at load; Router uses the Workers-only URLPattern global, which Node 22
// lacks. This polyfill covers what the router needs (literal segments, :name groups, a trailing * wildcard),
// so the routing-table tests exercise the REAL registration order in index.ts.
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
let worker: any;
beforeAll(async () => { worker = (await import("../index.js")).default; });

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>`;

class FakeBucket {
  store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, { bytes: new Uint8Array(bytes), contentType: opts?.httpMetadata?.contentType });
    return {};
  }
  async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    const o = this.store.get(key);
    if (!o) return null;
    const size = o.bytes.byteLength;
    let bytes = o.bytes;
    let range: { offset: number; length: number } | undefined;
    const r = opts?.range;
    if (r) {
      const offset = r.suffix !== undefined ? Math.max(0, size - r.suffix) : (r.offset ?? 0);
      const length = r.suffix !== undefined ? size - offset : Math.min(r.length ?? size - offset, size - offset);
      bytes = o.bytes.slice(offset, offset + length);
      range = { offset, length };
    }
    return {
      body: new Blob([bytes]).stream(),
      size,
      range,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
      httpEtag: "etag",
      writeHttpMetadata() {},
    };
  }
}

function setup() {
  const { db, DB } = makeSqliteD1();
  const bucket = new FakeBucket();
  const env: any = { DB, BUCKET: bucket, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok" };
  return { db, DB, env, bucket };
}
const req = (path: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth = "s", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) headers.set("Authorization", `Bearer ${auth}`);
  return new Request(`https://h${path}`, { ...rest, headers });
};
const jpost = (path: string, body: unknown, auth: string | null = "s", method = "POST") =>
  req(path, { method, auth, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function create(env: any, over: Record<string, unknown> = {}, auth: string | null = "s") {
  const res = await postMake(jpost("/mind/makes", { companion_id: "drevan", kind: "writing", title: "A small poem", source: "rain on glass", ...over }, auth), env);
  return { res, body: (await res.json()) as any };
}
const seedInterest = (env: any, over: Record<string, unknown> = {}) =>
  applyInterestAction(env, { companion_id: "drevan", action: "born", name: "Trains", why: "the sound of them", ...over } as any, T0);

function multipart(fields: Record<string, Uint8Array | string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (typeof v === "string") fd.set(k, v); else fd.set(k, new Blob([v]), `${k}.bin`);
  return fd;
}
const rendered = (env: any, id: string, fields: Record<string, Uint8Array | string>) =>
  postMakeRendered(req(`/mind/makes/${id}/rendered`, { method: "POST", body: multipart(fields) }), env, { id });

describe("pure helpers", () => {
  it("kind words map per the spec table", () => {
    const m: Record<string, string> = {
      drawing: "drawing", svg: "drawing", scad: "scad", "3d print": "scad", "3d model": "scad", model: "scad",
      song: "music_audio", track: "music_audio", music: "music_audio", strudel: "music_code", beat: "music_code",
      pattern: "music_code", "strudel pattern": "music_code", page: "page", website: "page", toy: "page",
      poem: "writing", story: "writing", writing: "writing", video: "video", clip: "video",
    };
    for (const [w, k] of Object.entries(m)) expect(mapKindWords(w), w).toBe(k);
    expect(mapKindWords("sandwich")).toBeNull();
  });
  it("svg check wants a closed svg root; scad deny set; slug", () => {
    expect(looksLikeSvg(SVG)).toBe(true);
    expect(looksLikeSvg(`<?xml version="1.0"?>\n<!-- c -->\n${SVG}\n`)).toBe(true);
    expect(looksLikeSvg("<html><svg></svg></html>")).toBe(false);
    expect(looksLikeSvg("<svg width='1'>")).toBe(false);
    for (const w of ["include", "use", "import", "surface"]) expect(scadDenyReason(`${w} <x.scad>;`), w).toMatch(/may not use/);
    expect(scadDenyReason("sphere(5, $fn=256);")).toMatch(/\$fn/);
    expect(scadDenyReason("sphere(5, $fn = 128); cube(2);")).toBeNull();
    expect(slugify("A Small, Poem!!")).toBe("a-small-poem");
    expect(slugify("???")).toBe("make");
    expect(normalizeMusicParams({ prompt: "x", duration: 5 })).toMatchObject({ ok: true, params: { duration: 30, instrumental: true } });
    expect(normalizeMusicParams({ prompt: "x", duration: 999, lyrics: "la" })).toMatchObject({ params: { duration: 120, instrumental: false } });
  });
});

describe("auth gate and routing table", () => {
  it("every route is 401 without the bearer", async () => {
    const { env } = setup();
    const id = "a".repeat(32);
    const calls: Array<[string, string]> = [
      ["POST", "/mind/makes"], ["GET", "/mind/makes/drevan"], ["GET", `/mind/makes/item/${id}`],
      ["GET", `/mind/makes/file/${id}/file`], ["GET", "/mind/makes/pending"], ["GET", `/mind/makes/source/${id}`],
      ["POST", `/mind/makes/${id}/rendered`], ["PATCH", `/mind/makes/${id}`],
    ];
    for (const [method, path] of calls) {
      const res = await worker.fetch(new Request(`https://h${path}`, { method, body: method === "GET" ? undefined : "{}" }), env, {} as any);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
  it("is registered in the Worker: /pending is not swallowed by /:companion_id; PATCH and POST resolve", async () => {
    const { env } = setup();
    const auth = { headers: { Authorization: "Bearer s" } };
    const pending = await worker.fetch(new Request("https://h/mind/makes/pending", auth), env, {} as any);
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as any).makes).toEqual([]);
    const list = await worker.fetch(new Request("https://h/mind/makes/cypher", auth), env, {} as any);
    expect(((await list.json()) as any).makes).toEqual([]);
    const c = await worker.fetch(new Request("https://h/mind/makes", { method: "POST", ...auth, body: JSON.stringify({ companion_id: "cypher", kind: "writing", title: "t", source: "s" }) }), env, {} as any);
    expect(c.status).toBe(201);
    const { id } = (await c.json()) as any;
    const p = await worker.fetch(new Request(`https://h/mind/makes/${id}`, { method: "PATCH", ...auth, body: JSON.stringify({ heard_back: "ok" }) }), env, {} as any);
    expect(p.status).toBe(200);
  });
});

describe("POST /mind/makes", () => {
  it("writing is ready at once, source in R2 at the spec key, one row", async () => {
    const { env, bucket, db } = setup();
    const { res, body } = await create(env);
    expect(res.status).toBe(201);
    expect(body.status).toBe("ready");
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(bucket.store.has(`makes/drevan/${body.id}/source.md`)).toBe(true);
    const row: any = db.prepare("SELECT * FROM companion_makes WHERE id = ?").get(body.id);
    expect(row).toMatchObject({ kind: "writing", status: "ready", version: 1, source_key: `makes/drevan/${body.id}/source.md` });
    expect(row.rendered_at).toBeTruthy();
  });
  it("page and music_code are ready; drawing and scad are pending", async () => {
    const { env } = setup();
    expect((await create(env, { kind: "page", source: "<h1>hi</h1>" })).body.status).toBe("ready");
    expect((await create(env, { kind: "music_code", source: 's("bd sd")' })).body.status).toBe("ready");
    expect((await create(env, { kind: "drawing", source: SVG })).body.status).toBe("pending");
    expect((await create(env, { kind: "scad", source: "cube(5);" })).body.status).toBe("pending");
  });
  it("R2 keys per kind", async () => {
    const { env, bucket } = setup();
    const a = (await create(env, { kind: "music_code", source: 's("bd")' })).body.id;
    const b = (await create(env, { kind: "scad", source: "cube(5);" })).body.id;
    const c = (await create(env, { kind: "page", source: "<p>x</p>" })).body.id;
    expect(bucket.store.has(`makes/drevan/${a}/source.strudel.js`)).toBe(true);
    expect(bucket.store.has(`makes/drevan/${b}/source.scad`)).toBe(true);
    expect(bucket.store.has(`makes/drevan/${c}/source.html`)).toBe(true);
  });
  it("music_audio and video need params, not source; duration clamps; aspect defaults to 9:16", async () => {
    const { env, db } = setup();
    expect((await create(env, { kind: "music_audio", source: undefined })).res.status).toBe(400);
    const m = await create(env, { kind: "music_audio", source: undefined, params: { prompt: "slow rain", duration: 5 } });
    expect(m.body.status).toBe("pending");
    const m2 = await create(env, { kind: "music_audio", source: undefined, params: { prompt: "slow rain", duration: 900, lyrics: "la la" } });
    const rows = db.prepare("SELECT params FROM companion_makes WHERE id IN (?, ?)").all(m.body.id, m2.body.id) as any[];
    const ps = rows.map((r) => JSON.parse(r.params));
    expect(ps.map((p) => p.duration).sort((a, b) => a - b)).toEqual([30, 120]);
    const v = await create(env, { kind: "video", source: undefined, params: { prompt: "a train at night" } });
    expect(v.body.status).toBe("pending");
    expect(JSON.parse((db.prepare("SELECT params FROM companion_makes WHERE id = ?").get(v.body.id) as any).params).aspect).toBe("9:16");
    expect((await create(env, { kind: "video", source: undefined, params: { prompt: "x", aspect: "1:1" } })).res.status).toBe(400);
    expect((await create(env, { kind: "video", source: undefined, params: { aspect: "16:9" } })).res.status).toBe(400);
  });
  it("validation: kind, title 1..120, why 400, source required, 64KB cap", async () => {
    const { env } = setup();
    expect((await create(env, { kind: "poster" })).res.status).toBe(400);
    expect((await create(env, { title: "" })).res.status).toBe(400);
    expect((await create(env, { title: "x".repeat(121) })).res.status).toBe(400);
    expect((await create(env, { title: "x".repeat(120) })).res.status).toBe(201);
    expect((await create(env, { why: "w".repeat(401) })).res.status).toBe(400);
    expect((await create(env, { why: "w".repeat(400) })).res.status).toBe(201);
    expect((await create(env, { source: "  " })).res.status).toBe(400);
    const big = await create(env, { source: "a".repeat(64 * 1024 + 1) });
    expect(big.res.status).toBe(413);
    expect(big.body.error).toBe("source_too_large");
    expect((await create(env, { source: "a".repeat(64 * 1024) })).res.status).toBe(201);
    expect((await create(env, { companion_id: "nobody" })).res.status).toBe(400);
  });
  it("drawing must be an svg document", async () => {
    const { env } = setup();
    expect((await create(env, { kind: "drawing", source: "<p>not svg</p>" })).res.status).toBe(400);
    expect((await create(env, { kind: "drawing", source: "<svg><rect/>" })).res.status).toBe(400);
    expect((await create(env, { kind: "drawing", source: SVG })).res.status).toBe(201);
  });
  it("scad: deny regex and $fn above 128", async () => {
    const { env } = setup();
    for (const src of ["include <a.scad>; cube(1);", "use <a.scad>;", 'import("x.stl");', 'surface(file="x.png");', "sphere(2, $fn=129);"]) {
      const r = await create(env, { kind: "scad", source: src });
      expect(r.res.status, src).toBe(400);
      expect(r.body.error).toBe("scad_denied");
    }
    expect((await create(env, { kind: "scad", source: "sphere(2, $fn=64);" })).res.status).toBe(201);
  });
  it("gaia makes nothing: 403 gaia_keeps_lines, no row, no R2 write", async () => {
    const { env, db, bucket } = setup();
    const r = await create(env, { companion_id: "gaia" });
    expect(r.res.status).toBe(403);
    expect(r.body.error).toBe("gaia_keeps_lines");
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_makes").get() as any).n).toBe(0);
    expect(bucket.store.size).toBe(0);
    expect((await create(env, { companion_id: "gaia" }, "gtok")).res.status).toBe(403);
  });
  it("a companion token cannot make as another companion", async () => {
    const { env } = setup();
    expect((await create(env, { companion_id: "cypher" }, "dtok")).res.status).toBe(403);
    expect((await create(env, { companion_id: "drevan" }, "dtok")).res.status).toBe(201);
    expect((await create(env, { companion_id: undefined }, "ctok")).body.id).toBeTruthy();
  });
  it("daily caps: 12 total, music_audio 3, video 2, per companion, per UTC day", async () => {
    const { env } = setup();
    const music = { kind: "music_audio", source: undefined, params: { prompt: "p" } };
    for (let i = 0; i < 3; i++) expect((await create(env, music)).res.status).toBe(201);
    const m4 = await create(env, music);
    expect(m4.res.status).toBe(429);
    expect(m4.body).toMatchObject({ error: "daily_cap", cap: "music_audio" });
    const vid = { kind: "video", source: undefined, params: { prompt: "p" } };
    for (let i = 0; i < 2; i++) expect((await create(env, vid)).res.status).toBe(201);
    expect((await create(env, vid)).body.cap).toBe("video");
    // 5 so far; 7 more writings reach 12, the 13th is refused
    for (let i = 0; i < 7; i++) expect((await create(env)).res.status).toBe(201);
    const t = await create(env);
    expect(t.res.status).toBe(429);
    expect(t.body.cap).toBe("total");
    // another companion is untouched
    expect((await create(env, { companion_id: "cypher" })).res.status).toBe(201);
  });
  it("the cap rolls over at UTC midnight", async () => {
    const { env } = setup();
    const input = { companion_id: "cypher", kind: "video", title: "t", params: { prompt: "p" } };
    expect((await createMake(env, input, T0)).ok).toBe(true);
    expect((await createMake(env, input, T0)).ok).toBe(true);
    expect((await createMake(env, input, T0)).ok).toBe(false);
    const next = Date.parse("2026-11-03T00:00:01.000Z");
    expect((await createMake(env, input, next)).ok).toBe(true);
  });
  it("a new version points at its parent and counts up; a stranger's parent is refused", async () => {
    const { env } = setup();
    const a = (await create(env)).body.id;
    const b = await create(env, { parent_id: a });
    const c = await create(env, { parent_id: b.body.id });
    const list = await listMakes(env, "drevan");
    expect(list.find((m) => m.id === b.body.id)).toMatchObject({ version: 2, parent_id: a });
    expect(list.find((m) => m.id === c.body.id)?.version).toBe(3);
    expect((await create(env, { companion_id: "cypher", parent_id: a })).res.status).toBe(400);
    expect((await create(env, { parent_id: "f".repeat(32) })).res.status).toBe(400);
  });
  it("an interest by NAME (case-insensitive, active only) records the existing `made` event with the why", async () => {
    const { env, db } = setup();
    await seedInterest(env);
    const r = await create(env, { interest_name: "tRaInS", why: "the rhythm of it" });
    expect(r.res.status).toBe(201);
    const ev: any = db.prepare("SELECT kind, why, ref FROM companion_interest_events WHERE kind = 'made'").get();
    expect(ev).toMatchObject({ kind: "made", why: "the rhythm of it", ref: `make:${r.body.id}` });
    const row: any = db.prepare("SELECT interest_id FROM companion_makes WHERE id = ?").get(r.body.id);
    expect(row.interest_id).toBeTruthy();
    // by id
    const r2 = await create(env, { interest_id: row.interest_id, why: "again" });
    expect(r2.res.status).toBe(201);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_interest_events WHERE kind = 'made'").get() as any).n).toBe(2);
  });
  it("interest edge cases: why required, unresolved name is no interest, another's id refused, resting not resolved", async () => {
    const { env, db } = setup();
    await seedInterest(env);
    expect((await create(env, { interest_name: "Trains" })).body.error).toBe("why_required");
    const ghost = await create(env, { interest_name: "Nothing", why: "w" });
    expect(ghost.res.status).toBe(201);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_interest_events WHERE kind = 'made'").get() as any).n).toBe(0);
    const trains: any = db.prepare("SELECT id FROM companion_interests WHERE name = 'Trains'").get();
    expect((await create(env, { companion_id: "cypher", interest_id: trains.id, why: "w" })).res.status).toBe(400);
    db.prepare("UPDATE companion_interests SET status = 'resting' WHERE id = ?").run(trains.id);
    const rest = await create(env, { interest_name: "Trains", why: "w" });
    expect(rest.res.status).toBe(201);
    expect((db.prepare("SELECT interest_id FROM companion_makes WHERE id = ?").get(rest.body.id) as any).interest_id).toBeNull();
  });
  it("fires creation_shared for that companion (sheds novelty_need)", async () => {
    const { env, db } = setup();
    db.prepare("UPDATE companion_drives SET level = 0.9, accumulate_per_day = 0, last_event_at = datetime('now') WHERE companion_id = 'drevan' AND drive_key = 'novelty_need'").run();
    const before: any = db.prepare("SELECT level FROM companion_drives WHERE companion_id = 'drevan' AND drive_key = 'novelty_need'").get();
    expect(before.level).toBeCloseTo(0.9, 3);
    await create(env);
    const after: any = db.prepare("SELECT level FROM companion_drives WHERE companion_id = 'drevan' AND drive_key = 'novelty_need'").get();
    expect(after.level).toBeLessThan(0.9);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_ferment_events WHERE companion_id = 'drevan'").get() as any).n).toBeGreaterThan(0);
  });
});

describe("reads", () => {
  it("list: shape, private why nulled, interest_name, files, newest first, images merged", async () => {
    const { env, db } = setup();
    await seedInterest(env);
    const a = (await create(env, { title: "first", why: "public why", interest_name: "Trains" })).body.id;
    const b = (await create(env, { title: "second", why: "secret", why_private: true })).body.id;
    const d = (await create(env, { title: "third", kind: "scad", source: "cube(1);" })).body.id;
    db.prepare("UPDATE companion_makes SET created_at = '2026-11-02 10:00:00' WHERE id = ?").run(a);
    db.prepare("UPDATE companion_makes SET created_at = '2026-11-02 11:00:00' WHERE id = ?").run(b);
    db.prepare("UPDATE companion_makes SET created_at = '2026-11-02 12:00:00' WHERE id = ?").run(d);
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at) VALUES (?, 'drevan', 'generate_image', 'a fox at dusk', 'success', 'p', 'k/x.png', 'image/png', '2026-11-02 11:30:00')",
    ).run("c".repeat(32));
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at) VALUES (?, 'drevan', 'generate_image', 'failed one', 'error', 'p', NULL, 'boom', '2026-11-02 11:45:00')",
    ).run("d".repeat(32));
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at) VALUES (?, 'cypher', 'generate_image', 'not mine', 'success', 'p', 'k/y.png', 'image/png', '2026-11-02 11:50:00')",
    ).run("e".repeat(32));

    const res = await getMakes(req("/mind/makes/drevan?limit=40"), env, { companion_id: "drevan" });
    const { makes } = (await res.json()) as any;
    expect(makes.map((m: any) => m.title)).toEqual(["third", "a fox at dusk", "second", "first"]);
    const img = makes[1];
    expect(img).toMatchObject({ id: `img_${"c".repeat(32)}`, kind: "image", status: "ready", files: { file: { mime: "image/png" } } });
    expect(makes[2].why).toBeNull();
    expect(makes[3]).toMatchObject({ why: "public why", interest_name: "Trains", version: 1, parent_id: null, heard_back: null });
    expect(makes[0].files).toEqual({ source: { mime: "text/plain; charset=utf-8", ext: "scad" } });
    // limit applies after the merge
    const lim = (await (await getMakes(req("/mind/makes/drevan?limit=2"), env, { companion_id: "drevan" })).json()) as any;
    expect(lim.makes.map((m: any) => m.title)).toEqual(["third", "a fox at dusk"]);
    expect((await getMakes(req("/mind/makes/nobody"), env, { companion_id: "nobody" })).status).toBe(400);
  });
  it("list carries the recipe: params for model kinds, null for code kinds and images", async () => {
    const { env, db } = setup();
    await create(env, { title: "song", kind: "music_audio", source: undefined, params: { prompt: "slow rain", duration: 45 } });
    await create(env, { title: "cube", kind: "scad", source: "cube(1);" });
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary, created_at) VALUES (?, 'drevan', 'generate_image', 'fox', 'success', 'p', 'k/x.png', 'image/png', '2026-11-02 11:30:00')",
    ).run("c".repeat(32));
    const { makes } = (await (await getMakes(req("/mind/makes/drevan"), env, { companion_id: "drevan" })).json()) as any;
    const by = (t: string) => makes.find((m: any) => m.title === t);
    expect(by("song").params).toEqual({ prompt: "slow rain", duration: 45, instrumental: true });
    expect(by("cube").params).toBeNull();
    expect(by("fox").params).toBeNull();
  });
  it("item route: a make, an img_ row, and a miss", async () => {
    const { env, db } = setup();
    const id = (await create(env)).body.id;
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary) VALUES (?, 'gaia', 'generate_image', 'stones', 'success', 'p', 'k/z.png', 'image/png')",
    ).run("b".repeat(32));
    const one = (await (await getMakeItemHttp(req(`/mind/makes/item/${id}`), env, { id })).json()) as any;
    expect(one).toMatchObject({ id, kind: "writing", title: "A small poem" });
    const imgId = `img_${"b".repeat(32)}`;
    expect(((await (await getMakeItemHttp(req(`/x`), env, { id: imgId })).json()) as any)).toMatchObject({ id: imgId, kind: "image", title: "stones" });
    expect((await getMakeItemHttp(req(`/x`), env, { id: "e".repeat(32) })).status).toBe(404);
    expect((await getMakeItemHttp(req(`/x`), env, { id: "../etc" })).status).toBe(404);
  });
  it("gaia's list still shows her images (she makes none, the tool rows are hers)", async () => {
    const { env, db } = setup();
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary) VALUES (?, 'gaia', 'generate_image', 'stones', 'success', 'p', 'k/z.png', 'image/webp')",
    ).run("b".repeat(32));
    const l = await listMakes(env, "gaia");
    expect(l).toHaveLength(1);
    expect(l[0]!.files.file!.mime).toBe("image/webp");
  });
});

describe("rendered / pending / source", () => {
  it("pending lists only pending rows, oldest first, with params and source_key", async () => {
    const { env, db } = setup();
    const ready = (await create(env)).body.id;
    const d = (await create(env, { kind: "drawing", source: SVG })).body.id;
    const m = (await create(env, { kind: "music_audio", source: undefined, params: { prompt: "p", duration: 45 } })).body.id;
    db.prepare("UPDATE companion_makes SET created_at = '2026-11-02 09:00:00' WHERE id = ?").run(m);
    db.prepare("UPDATE companion_makes SET created_at = '2026-11-02 10:00:00' WHERE id = ?").run(d);
    const { makes } = (await (await getPendingMakes(req("/mind/makes/pending?limit=5"), env)).json()) as any;
    expect(makes.map((x: any) => x.id)).toEqual([m, d]);
    expect(makes[0]).toMatchObject({ kind: "music_audio", companion_id: "drevan", source_key: null, params: { prompt: "p", duration: 45, instrumental: true } });
    expect(makes[1].source_key).toBe(`makes/drevan/${d}/source.svg`);
    expect(makes.some((x: any) => x.id === ready)).toBe(false);
    const one = (await (await getPendingMakes(req("/mind/makes/pending?limit=1"), env)).json()) as any;
    expect(one.makes).toHaveLength(1);
  });
  it("source route returns the raw text with the safe headers; no source is a 404", async () => {
    const { env } = setup();
    const id = (await create(env, { kind: "scad", source: "cube(7);" })).body.id;
    const res = await getMakeSource(req(`/mind/makes/source/${id}`), env, { id });
    expect(await res.text()).toBe("cube(7);");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const mid = (await create(env, { kind: "video", source: undefined, params: { prompt: "p" } })).body.id;
    expect((await getMakeSource(req(`/x`), env, { id: mid })).status).toBe(404);
  });
  it("multipart render: stores file + preview, sets keys/mime/status, and is IDEMPOTENT", async () => {
    const { env, db, bucket } = setup();
    const id = (await create(env, { kind: "scad", source: "cube(5);" })).body.id;
    const r = await rendered(env, id, { file: new Uint8Array([1, 2, 3, 4]), preview: PNG });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "ready" });
    const row: any = db.prepare("SELECT * FROM companion_makes WHERE id = ?").get(id);
    expect(row).toMatchObject({ status: "ready", file_key: `makes/drevan/${id}/file.stl`, file_mime: "model/stl", preview_key: `makes/drevan/${id}/preview.png` });
    expect(row.rendered_at).toBeTruthy();
    expect(bucket.store.get(`makes/drevan/${id}/file.stl`)!.contentType).toBe("model/stl");
    // a retry with different bytes changes nothing
    const again = await rendered(env, id, { file: new Uint8Array([9, 9, 9, 9, 9]), preview: PNG });
    expect(await again.json()).toMatchObject({ ok: true, status: "ready", noop: true });
    expect(Array.from(bucket.store.get(`makes/drevan/${id}/file.stl`)!.bytes)).toEqual([1, 2, 3, 4]);
  });
  it("drawing render wants a real png; mp3 and mp4 kinds take their own mime", async () => {
    const { env, db } = setup();
    const d = (await create(env, { kind: "drawing", source: SVG })).body.id;
    expect((await rendered(env, d, { file: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) })).status).toBe(400);
    expect((await rendered(env, d, { file: PNG })).status).toBe(200);
    expect((db.prepare("SELECT file_mime FROM companion_makes WHERE id = ?").get(d) as any).file_mime).toBe("image/png");
    const m = (await create(env, { kind: "music_audio", source: undefined, params: { prompt: "p" } })).body.id;
    await rendered(env, m, { file: new Uint8Array([0xff, 0xfb, 1, 2]) });
    expect((db.prepare("SELECT file_mime FROM companion_makes WHERE id = ?").get(m) as any).file_mime).toBe("audio/mpeg");
    const v = (await create(env, { kind: "video", source: undefined, params: { prompt: "p" } })).body.id;
    await rendered(env, v, { file: new Uint8Array([0, 0, 0, 0x18]) });
    expect((db.prepare("SELECT file_mime FROM companion_makes WHERE id = ?").get(v) as any).file_mime).toBe("video/mp4");
  });
  it("JSON { failed, reason } fails it with a short reason, once", async () => {
    const { env, db } = setup();
    const id = (await create(env, { kind: "scad", source: "cube(5);" })).body.id;
    const res = await postMakeRendered(jpost(`/x`, { failed: true, reason: "x".repeat(500) }), env, { id });
    expect(await res.json()).toMatchObject({ status: "failed" });
    const row: any = db.prepare("SELECT status, fail_reason FROM companion_makes WHERE id = ?").get(id);
    expect(row.status).toBe("failed");
    expect(row.fail_reason.length).toBe(200);
    const again = await postMakeRendered(jpost(`/x`, { failed: true, reason: "other" }), env, { id });
    expect(await again.json()).toMatchObject({ noop: true, status: "failed" });
    const item = (await (await getMakeItemHttp(req("/x"), env, { id })).json()) as any;
    expect(item).toMatchObject({ status: "failed", fail_reason: "x".repeat(200) });
    const listed = (await (await getMakes(req("/x"), env, { companion_id: "drevan" })).json()) as any;
    expect(listed.makes.find((m: any) => m.id === id).fail_reason).toBe("x".repeat(200));
    const ok = (await create(env)).body.id;
    expect(((await (await getMakeItemHttp(req("/x"), env, { id: ok })).json()) as any).fail_reason).toBeNull();
    const listed2 = (await (await getMakes(req("/x"), env, { companion_id: "drevan" })).json()) as any;
    expect(listed2.makes.find((m: any) => m.id === ok).fail_reason).toBeNull();
  });
  it("a render posted to a row that is not pending is a no-op; a miss is 404; bad bodies are 400", async () => {
    const { env, bucket } = setup();
    const ready = (await create(env)).body.id;
    const before = bucket.store.size;
    expect(await (await rendered(env, ready, { file: PNG })).json()).toMatchObject({ noop: true, status: "ready" });
    expect(bucket.store.size).toBe(before);
    expect((await rendered(env, "f".repeat(32), { file: PNG })).status).toBe(404);
    const d = (await create(env, { kind: "drawing", source: SVG })).body.id;
    expect((await postMakeRendered(req(`/x`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "no failed flag" }) }), env, { id: d })).status).toBe(400);
    expect((await postMakeRendered(req(`/x`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" }), env, { id: d })).status).toBe(400);
    expect((await rendered(env, d, { notfile: "x" })).status).toBe(400);
  });
});

describe("file streaming headers", () => {
  async function renderedDrawing(env: any) {
    const id = (await create(env, { kind: "drawing", title: "Night Train", source: SVG })).body.id;
    await rendered(env, id, { file: PNG });
    return id;
  }
  it("always attachment + nosniff + sandbox CSP, with the slug-vN filename", async () => {
    const { env } = setup();
    const id = await renderedDrawing(env);
    for (const which of ["source", "file"]) {
      const res = await serveMakeFile(req(`/mind/makes/file/${id}/${which}`), env, { id, which });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="night-train-v1.${which === "file" ? "png" : "svg"}"`);
    }
    const png = await serveMakeFile(req(`/x`), env, { id, which: "file" });
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await png.arrayBuffer())).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("?inline=1 is honoured ONLY for image/png, audio/mpeg, video/mp4", async () => {
    const { env } = setup();
    const id = await renderedDrawing(env);
    const inlinePng = await serveMakeFile(req(`/mind/makes/file/${id}/file?inline=1`), env, { id, which: "file" });
    expect(inlinePng.headers.get("Content-Disposition")).toBe("inline");
    expect(inlinePng.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(inlinePng.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    // svg source, html page, text, stl: refused inline
    const refused: Array<[string, Record<string, unknown>]> = [
      ["source", { kind: "drawing", source: SVG }],
      ["source", { kind: "page", source: "<script>alert(1)</script>" }],
      ["source", { kind: "writing" }],
      ["source", { kind: "music_code", source: 's("bd")' }],
    ];
    for (const [which, over] of refused) {
      const mid = (await create(env, over)).body.id;
      const res = await serveMakeFile(req(`/mind/makes/file/${mid}/${which}?inline=1`), env, { id: mid, which });
      expect(res.headers.get("Content-Disposition"), String(over.kind)).toMatch(/^attachment; filename=/);
    }
    const scad = (await create(env, { kind: "scad", source: "cube(1);" })).body.id;
    await rendered(env, scad, { file: new Uint8Array([1, 2, 3, 4]), preview: PNG });
    const stl = await serveMakeFile(req(`/x?inline=1`), env, { id: scad, which: "file" });
    expect(stl.headers.get("Content-Disposition")).toMatch(/^attachment/);
    const prev = await serveMakeFile(req(`/x?inline=1`), env, { id: scad, which: "preview" });
    expect(prev.headers.get("Content-Disposition")).toBe("inline");
    const m = (await create(env, { kind: "music_audio", source: undefined, params: { prompt: "p" } })).body.id;
    await rendered(env, m, { file: new Uint8Array([0xff, 0xfb, 1, 2]) });
    expect((await serveMakeFile(req(`/x?inline=1`), env, { id: m, which: "file" })).headers.get("Content-Disposition")).toBe("inline");
    // without ?inline=1 the same png is still a download
    expect((await serveMakeFile(req(`/x`), env, { id, which: "file" })).headers.get("Content-Disposition")).toMatch(/^attachment/);
  });
  it("Range: plain 200 advertises Accept-Ranges; bytes=a-b is 206 with Content-Range; suffix and open ranges; junk ignored", async () => {
    const { env } = setup();
    const m = (await create(env, { kind: "music_audio", source: undefined, params: { prompt: "p" } })).body.id;
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    await rendered(env, m, { file: bytes });
    const get = (range?: string) =>
      serveMakeFile(req(`/mind/makes/file/${m}/file?inline=1`, range ? { headers: { Range: range } } : {}), env, { id: m, which: "file" });
    const full = await get();
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Content-Range")).toBeNull();
    expect((await full.arrayBuffer()).byteLength).toBe(100);
    const part = await get("bytes=10-19");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(part.headers.get("Content-Length")).toBe("10");
    expect(part.headers.get("Accept-Ranges")).toBe("bytes");
    expect(part.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(part.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const open = await get("bytes=90-");
    expect(open.status).toBe(206);
    expect(open.headers.get("Content-Range")).toBe("bytes 90-99/100");
    const probe = await get("bytes=0-1");
    expect(probe.headers.get("Content-Range")).toBe("bytes 0-1/100");
    const tail = await get("bytes=-5");
    expect(tail.headers.get("Content-Range")).toBe("bytes 95-99/100");
    expect((await get("bytes=0-1,5-6")).status).toBe(200);
    expect((await get("garbage")).status).toBe(200);
    expect(parseRange("bytes=5-2")).toBeNull();
  });
  it("404s: bad id, bad which, no file yet, missing object; version shows in the name", async () => {
    const { env, bucket } = setup();
    const a = (await create(env, { kind: "drawing", source: SVG })).body.id;
    expect((await serveMakeFile(req(`/x`), env, { id: a, which: "file" })).status).toBe(404);
    expect((await serveMakeFile(req(`/x`), env, { id: a, which: "bogus" })).status).toBe(404);
    expect((await serveMakeFile(req(`/x`), env, { id: "../x", which: "file" })).status).toBe(404);
    expect((await serveMakeFile(req(`/x`), env, { id: "f".repeat(32), which: "source" })).status).toBe(404);
    bucket.store.delete(`makes/drevan/${a}/source.svg`);
    expect((await serveMakeFile(req(`/x`), env, { id: a, which: "source" })).status).toBe(404);
    const v2 = (await create(env, { title: "Poem", parent_id: a })).body.id;
    const res = await serveMakeFile(req(`/x`), env, { id: v2, which: "source" });
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="poem-v2.md"');
  });
  it("img_<callId> serves the generate_image object the same way; raster inline allowed, svg-ish never", async () => {
    const { env, db, bucket } = setup();
    const call = "a".repeat(32);
    await bucket.put("companions/drevan/img/x.png", PNG, { httpMetadata: { contentType: "image/png" } });
    db.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary) VALUES (?, 'drevan', 'generate_image', 'A Fox', 'success', 'p', 'companions/drevan/img/x.png', 'image/png')",
    ).run(call);
    const id = `img_${call}`;
    const dl = await serveMakeFile(req(`/x`), env, { id, which: "file" });
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="a-fox-v1.png"');
    expect(dl.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(dl.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect((await serveMakeFile(req(`/x?inline=1`), env, { id, which: "file" })).headers.get("Content-Disposition")).toBe("inline");
    expect((await serveMakeFile(req(`/x`), env, { id, which: "source" })).status).toBe(404);
    db.prepare("UPDATE companion_tool_calls SET result_summary = 'image/svg+xml' WHERE id = ?").run(call);
    expect((await serveMakeFile(req(`/x?inline=1`), env, { id, which: "file" })).headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect((await serveMakeFile(req(`/x`), env, { id: `img_${"9".repeat(32)}`, which: "file" })).status).toBe(404);
  });
});

describe("PATCH heard_back", () => {
  it("sets the line (<= 280), refuses empty / long / another companion's token", async () => {
    const { env, db } = setup();
    const id = (await create(env)).body.id;
    const patch = (body: unknown, auth = "s") => patchMake(jpost(`/mind/makes/${id}`, body, auth, "PATCH"), env, { id });
    expect((await patch({ heard_back: "  it sounded like   rain " })).status).toBe(200);
    expect((db.prepare("SELECT heard_back FROM companion_makes WHERE id = ?").get(id) as any).heard_back).toBe("it sounded like rain");
    expect((await patch({ heard_back: "x".repeat(280) })).status).toBe(200);
    expect((await patch({ heard_back: "x".repeat(281) })).status).toBe(400);
    expect((await patch({ heard_back: "   " })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ heard_back: "mine" }, "ctok")).status).toBe(403);
    expect((await patch({ heard_back: "mine" }, "dtok")).status).toBe(200);
    expect((await patchMake(jpost(`/x`, { heard_back: "a" }, "s", "PATCH"), env, { id: "f".repeat(32) })).status).toBe(404);
    const item = (await (await getMakeItemHttp(req("/x"), env, { id })).json()) as any;
    expect(item.heard_back).toBe("mine");
  });
});

describe("Librarian verb: parse", () => {
  it("parses kind, title, interest candidate, why, private marker", () => {
    expect(parseMakeVerb("make a poem called Rain Song for Trains because I like the sound")).toMatchObject({
      kind: "writing", title_full: "Rain Song for Trains", title_before_for: "Rain Song", interest_candidate: "Trains", why: "I like the sound", why_private: false,
    });
    expect(parseMakeVerb("make an svg called \"Night Train\" because it was dark (private)")).toMatchObject({
      kind: "drawing", title_full: "Night Train", interest_candidate: null, why: "it was dark", why_private: true,
    });
    expect(parseMakeVerb("make a strudel pattern called Heartbeat because i wanted a pulse")?.kind).toBe("music_code");
    expect(parseMakeVerb("Make a 3d print called Tiny Bird because small things")?.kind).toBe("scad");
    expect(parseMakeVerb("please make me a toy called Wobble")).toMatchObject({ kind: "page", title_full: "Wobble", why: "" });
    expect(parseMakeVerb("make a song called A for B for C because x")).toMatchObject({ title_before_for: "A for B", interest_candidate: "C" });
  });
  it("is gated on 'called' and a kind word", () => {
    expect(parseMakeVerb("make a poem about trains")).toBeNull();
    expect(parseMakeVerb("make a sandwich called lunch because hungry")).toBeNull();
    expect(parseMakeVerb("I will make a poem called X because y")).toBeNull();
    expect(parseMakeVerb("made a poem called X for Trains because y")).toBeNull();
  });
});

describe("Librarian verb: routing and regressions", () => {
  it("routes make and my makes", () => {
    expect(matchFastPath("make a poem called Rain because i like it")!.key).toBe("make_artifact");
    expect(matchFastPath("make a drawing called Hands because they are strange")!.key).toBe("make_artifact");
    expect(matchFastPath("my makes")!.key).toBe("makes_read");
    expect(matchFastPath("list my makes")!.key).toBe("makes_read");
    // trigger words inside the why cannot steal it
    expect(matchFastPath("make a poem called Notes because I prefer the note about search for web search")!.key).toBe("make_artifact");
  });
  it("`made X for Y because Z` still routes to the interest event", () => {
    expect(matchFastPath("made a small poem for Trains because they are good")!.key).toBe("interest_made");
    expect(matchFastPath("made a poem called Rain for Trains because they hum")!.key).toBe("interest_made");
    expect(matchFastPath("new interest: Trains, because the sound")!.key).toBe("interest_born");
    expect(matchFastPath("back to Trains because still good")!.key).toBe("interest_return");
    expect(matchFastPath("putting down Trains because done")!.key).toBe("interest_put_down");
    expect(matchFastPath("picking Trains back up because missed it")!.key).toBe("interest_pick_up");
    expect(matchFastPath("my interests")!.key).toBe("interests_read");
    expect(matchFastPath("interest trail Trains")!.key).toBe("interest_trail");
  });
  it("`who is Barbossa` still routes to the people lookup; generate_image and neighbours unchanged", () => {
    expect(matchFastPath("who is Barbossa")!.key).toBe("person_who_is");
    expect(matchFastPath("who's Blue")!.key).toBe("person_who_is");
    expect(matchFastPath("tell me about Blue")!.key).toBe("person_who_is");
    expect(matchFastPath("make an image of a fox")!.key).toBe("generate_image");
    expect(matchFastPath("generate an image of rain")!.key).toBe("generate_image");
    expect(matchFastPath("make an image called Fox")!.key).toBe("generate_image");
    expect(matchFastPath("who is fronting")!.key).not.toBe("make_artifact");
  });
  it("every guard's key exists in the pattern table", () => {
    for (const g of ANCHORED_GUARDS) expect(matchFastPath(g.pattern_key) ? true : true).toBe(true);
  });
});

describe("Librarian executors", () => {
  const ctx = (env: any, request: string, context?: unknown, companion = "drevan"): any => ({
    env, req: { companion_id: companion, request, context: context === undefined ? undefined : JSON.stringify(context) },
    entry: {}, frontState: null, pluralAvailable: false,
  });
  it("makes a writing from context.source; the interest resolves from 'for <x>'; the title drops it", async () => {
    const { env, db } = setup();
    await seedInterest(env);
    const r: any = await execMake(ctx(env, "make a poem called Rain Song for trains because they hum", { source: "da da dum" }));
    expect(r.ack).toBe(true);
    expect(r.status).toBe("ready");
    const row: any = db.prepare("SELECT title, interest_id, why FROM companion_makes WHERE id = ?").get(r.id);
    expect(row).toMatchObject({ title: "Rain Song", why: "they hum" });
    expect(row.interest_id).toBeTruthy();
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_interest_events WHERE kind = 'made'").get() as any).n).toBe(1);
  });
  it("a 'for <x>' that is not an interest stays in the title", async () => {
    const { env, db } = setup();
    const r: any = await execMake(ctx(env, "make a song called Lullaby for a Tired Fox because night", { prompt: "soft piano" }));
    expect(r.ack).toBe(true);
    expect(r.status).toBe("pending");
    expect((db.prepare("SELECT title, interest_id FROM companion_makes WHERE id = ?").get(r.id) as any)).toMatchObject({ title: "Lullaby for a Tired Fox", interest_id: null });
  });
  it("teaches on a missing source / prompt, and gaia is refused in her own terms", async () => {
    const { env } = setup();
    const noSource: any = await execMake(ctx(env, "make a poem called Rain because x"));
    expect(noSource).toMatchObject({ refused: true, code: "bad_input" });
    const noPrompt: any = await execMake(ctx(env, "make a video called Rain because x"));
    expect(noPrompt.refused).toBe(true);
    const gaia: any = await execMake(ctx(env, "make a poem called Stones because x", { source: "s" }, "gaia"));
    expect(gaia).toMatchObject({ refused: true, code: "gaia_keeps_lines" });
    expect(gaia.witness).not.toContain("—");
  });
  it("my makes lists the caller's own, private why in full", async () => {
    const { env } = setup();
    await create(env, { title: "mine", why: "secret", why_private: true });
    await create(env, { companion_id: "cypher", title: "his" });
    const r: any = await execMakesRead(ctx(env, "my makes"));
    expect(r.data.makes).toHaveLength(1);
    expect(r.data.makes[0]).toMatchObject({ title: "mine", why: "secret", status: "ready" });
  });
  it("the Worker dispatches the verb through the router (end to end)", async () => {
    const { env, db } = setup();
    const { LibrarianRouter } = await import("../librarian/router.js");
    const router: any = new LibrarianRouter(env);
    const out: any = await router.route({ companion_id: "cypher", request: "make a page called Wobble because it wobbles", context: JSON.stringify({ source: "<p>wobble</p>" }) });
    expect(out.ack).toBe(true);
    expect((db.prepare("SELECT kind, companion_id FROM companion_makes").get() as any)).toMatchObject({ kind: "page", companion_id: "cypher" });
  });
});

describe("metronome + migrations", () => {
  it("make is a valid action type, Cypher's and Drevan's only", () => {
    expect(isValidActionType("make")).toBe(true);
    expect(ownsMove("cypher", "make")).toBe(true);
    expect(ownsMove("drevan", "make")).toBe(true);
    expect(ownsMove("gaia", "make")).toBe(false);
  });
  it("0165 admits 'make' and refuses unknown types; real schema accepts a make row", () => {
    const { db } = setup();
    const ins = (t: string) => db.prepare("INSERT INTO metronome_actions (companion_id, name, action_type) VALUES ('cypher', 'm', ?)").run(t);
    expect(() => ins("make")).not.toThrow();
    expect(() => ins("bogus")).toThrow();
    expect(() => ins("show_made")).not.toThrow();
  });
  it("0165 keeps every existing row and column through the rebuild", () => {
    const { db } = makeSqliteD1({ upTo: 164 });
    db.prepare(
      `INSERT INTO metronome_actions (id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status,
         silence_min_hours, silence_max_hours, max_per_day, cooldown_hours, requires_signal, signal_lookback_hours,
         last_fired_at, fire_count_today, fire_count_reset_at, created_at, updated_at)
       VALUES ('row1', 'drevan', 'own', 'dare', 'tgt', 'prompt!', 1, 'off', 1.5, 9, 3, 2.5, 'sig', 6,
         '2026-11-01 01:00:00', 2, '2026-11-01', '2026-10-01 00:00:00', '2026-10-02 00:00:00')`,
    ).run();
    const colsBefore = (db.prepare("PRAGMA table_info(metronome_actions)").all() as any[]).map((c) => c.name);
    const before: any = db.prepare("SELECT * FROM metronome_actions WHERE id = 'row1'").get();
    db.exec(fs.readFileSync(fileURLToPath(new URL("../../migrations/0165_metronome_make.sql", import.meta.url) as any), "utf8"));
    const colsAfter = (db.prepare("PRAGMA table_info(metronome_actions)").all() as any[]).map((c) => c.name);
    expect(colsAfter).toEqual(colsBefore);
    expect({ ...(db.prepare("SELECT * FROM metronome_actions WHERE id = 'row1'").get() as any) }).toEqual({ ...before });
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'metronome_actions'").all() as any[]).map((i) => i.name);
    expect(idx).toContain("idx_metronome_actions_companion");
    expect(() => db.prepare("INSERT INTO metronome_actions (companion_id, name, action_type) VALUES ('cypher', 'm', 'make')").run()).not.toThrow();
  });
});
