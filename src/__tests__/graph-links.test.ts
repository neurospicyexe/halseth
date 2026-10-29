// Our own links (M4, mig 0151, graph/links.ts). Real schema (helpers/sqlite-d1.ts), real statements:
// a link is a property of which rows exist and which come back, so these run the actual SQL.
//
// Pinned down here:
//   - grammar: kinds anchor the split, so quotes holding " to " and colons still parse; owners narrow;
//   - resolution: any visible kind on either end, anyone's row; drafts / archived / superseded refused;
//     a quote names exactly one row or nothing changes;
//   - the write: one ledger row + one walkable 'asserted' edge 'linked:<writer>'; idempotent in either
//     direction; two minds' links on one pair both stand; no heat moves;
//   - unlink: writer only, human-present only (Claude.ai, or Raziel's door); the ledger keeps it;
//   - the rebuild never touches an asserted edge; the map carries the why;
//   - Raziel's HTTP door writes as raziel and cannot remove a companion's link;
//   - routing: 'link ...' / 'unlink ...' / 'my links' reach their executors, and a quote mentioning a
//     note or a tension never falls to that write.

import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedNote, seedSession } from "./helpers/sqlite-d1.js";
import { makeLink, removeLink, listLinks, librarianVia, LINKABLE_TABLES } from "../graph/links.js";
import { parseLinkRequest, execGraphLink, execGraphUnlink, execGraphLinksRead } from "../librarian/executors/links.js";
import { matchFastPath } from "../librarian/router.js";
import { rebuildGraphDetailed } from "../graph/rebuild.js";
import { buildMap, MAP_TABLES } from "../graph/map.js";
import { postMindLink } from "../handlers/links.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "admin-tok", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
  return { db: db as any, env };
}

function conclusion(db: any, id: string, text: string, o: { companion?: string; archived?: number; superseded_by?: string; heat?: number } = {}) {
  db.prepare(
    "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, heat, archived, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, o.companion ?? "drevan", text, "2026-10-01T00:00:00Z", o.heat ?? 1.5, o.archived ?? 0, o.superseded_by ?? null);
}
function journal(db: any, id: string, text: string, agent = "drevan", review_state = "kept") {
  db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text, review_state, archived) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, "2026-10-02T00:00:00Z", agent, text, review_state);
}
function tension(db: any, id: string, companion: string, text: string) {
  db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at) VALUES (?, ?, ?, 'simmering', ?)")
    .run(id, companion, text, "2026-10-03T00:00:00Z");
}

const claudeAi = { via: "claude-ai" as const, surface: "claude-ai:thread-1" };
const bot = { via: "librarian" as const, surface: "discord:drevan" };

const ctxFor = (env: any, companion: string, request: string, extra: Record<string, unknown> = {}): any => ({
  env, req: { companion_id: companion, request, ...extra }, entry: { pattern: "graph_link" }, frontState: null, pluralAvailable: false,
});

describe("grammar", () => {
  it("splits on ' to <kind>:' so the first quote may hold ' to '", () => {
    const p = parseLinkRequest("link conclusion: the quarter-second belongs to the hands to journal: greyhound line: where I saw it");
    expect(p).toEqual({
      src: { owner: undefined, kind: "conclusion", quote: "the quarter-second belongs to the hands" },
      dst: { owner: undefined, kind: "journal", quote: "greyhound line" },
      why: "where I saw it",
    });
  });

  it("reads owners and kind aliases, and quoted words holding a colon", () => {
    const p = parseLinkRequest(`link my tension: heat vs sensor to drevan's tension: "calling myself: calibrated": same gap, two lanes`);
    expect(p!.src).toEqual({ owner: "my", kind: "tension", quote: "heat vs sensor" });
    expect(p!.dst).toEqual({ owner: "drevan", kind: "tension", quote: "calling myself: calibrated" });
    expect(p!.why).toBe("same gap, two lanes");
    expect(parseLinkRequest("link show: Fargo to crash's journal: snow scene")!.dst.owner).toBe("raziel");
    expect(parseLinkRequest("link show: Fargo to journal: snow scene")!.src.kind).toBe("show");
  });

  it("no why is fine; no second kind is not a link", () => {
    expect(parseLinkRequest("link note: vethmerin to letter: Calethian")!.why).toBeUndefined();
    expect(parseLinkRequest("link this to that")).toBeNull();
  });

  it("the context payload wins over the text", () => {
    const p = parseLinkRequest("link", JSON.stringify({ src: { kind: "note", id: "n1" }, dst: { table: "watch_shelf", id: "w1" }, why: "x" }));
    expect(p).toEqual({ src: { kind: "note", id: "n1" }, dst: { table: "watch_shelf", id: "w1" }, why: "x" });
  });
});

describe("routing", () => {
  it.each([
    ["link conclusion: the quarter-second to journal: greyhound line: seen there", "graph_link"],
    ["link my tension: heat to drevan's tension: calibrated", "graph_link"],
    ["Link note: tension about the sensor to journal: a note to self", "graph_link"],
    ["unlink conclusion: the quarter-second to journal: greyhound line", "graph_unlink"],
    ["my links", "graph_links_read"],
  ])("%s -> %s", (req, key) => {
    expect(matchFastPath(req)?.key).toBe(key);
  });

  it("does not steal pins, notes, or a sentence that merely says 'link'", () => {
    expect(matchFastPath("pin note: link to the song")?.key).toBe("memory_pin");
    expect(matchFastPath("note to Drevan: link this to that?")?.key).not.toBe("graph_link");
    expect(matchFastPath("link to the forage find")?.key).not.toBe("graph_link");
    expect(matchFastPath("link up with drevan to plan the ritual")?.key).not.toBe("graph_link");
    expect(matchFastPath("Unlink yourself from the loop")?.key).not.toBe("graph_unlink");
    expect(matchFastPath("save my links to the vault")?.key).not.toBe("graph_links_read");
  });

  it("unlink by the id the witness prints", () => {
    expect(matchFastPath("unlink link 3f59316a-0a71-40e5")?.key).toBe("graph_unlink");
    expect(parseLinkRequest("unlink link 3f59316a-0a71-40e5")).toEqual({ src: {}, dst: {}, linkId: "3f59316a-0a71-40e5" });
  });

  it("a quoted first end keeps its own ' to <kind>:'", () => {
    const p = parseLinkRequest(`link conclusion: "the move to journal: never" to journal: the night it clicked: why`);
    expect(p!.src.quote).toBe("the move to journal: never");
    expect(p!.dst.quote).toBe("the night it clicked");
    expect(p!.why).toBe("why");
  });
});

describe("making a link", () => {
  it("links anyone's visible rows: one ledger row + one walkable asserted edge, no heat", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "The quarter-second is where the hands decide.", { heat: 2.25 });
    journal(db, "j1", "The greyhound line, the night it clicked.", "cypher");
    const r = await makeLink(env, { writer: "drevan", src: { kind: "conclusion", quote: "quarter-second" }, dst: { kind: "journal", quote: "greyhound" }, why: "seen there", ...bot });
    expect(r.ok && r.changed).toBe(true);
    const edges = db.prepare("SELECT * FROM graph_edges").all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ edge_type: "linked:drevan", writer: "drevan", provenance: "asserted" });
    const ledger = db.prepare("SELECT * FROM graph_links").all();
    expect(ledger[0]).toMatchObject({ writer: "drevan", why: "seen there", edge_id: edges[0].id, made_via: "librarian", made_surface: "discord:drevan" });
    expect(db.prepare("SELECT heat FROM companion_conclusions WHERE id = 'c1'").get().heat).toBe(2.25);
  });

  it("refuses drafts, archived and superseded rows (never a bare id on the map)", async () => {
    const { db, env } = setup();
    journal(db, "draft", "an unkept clerk line about the hens", "drevan", "draft");
    conclusion(db, "c2", "The hens run the yard.");
    conclusion(db, "old", "an old belief about the hens", { superseded_by: "c2" });
    conclusion(db, "gone", "an archived belief about the hens", { archived: 1 });
    for (const src of [{ kind: "journal", quote: "clerk line" }, { kind: "conclusion", quote: "old belief" }, { kind: "conclusion", quote: "archived belief" }, { kind: "journal", id: "draft" }]) {
      const r = await makeLink(env, { writer: "drevan", src, dst: { kind: "conclusion", quote: "run the yard" }, ...bot });
      expect(r.ok).toBe(false);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get().n).toBe(0);
  });

  it("a quote must name exactly one row; an owner narrows it", async () => {
    const { db, env } = setup();
    tension(db, "t-dre", "drevan", "the gap between my heat and the sensor");
    tension(db, "t-cy", "cypher", "the gap between the audit and the felt read");
    journal(db, "j1", "sensor array, literally", "gaia");
    const amb = await makeLink(env, { writer: "cypher", src: { kind: "tension", quote: "the gap between" }, dst: { kind: "journal", quote: "sensor array" }, ...claudeAi });
    expect(amb.ok).toBe(false);
    expect(!amb.ok && amb.reason).toMatch(/matches 2 tensions.*t-dre.*t-cy|matches 2 tensions.*t-cy.*t-dre/);
    const mine = await makeLink(env, { writer: "cypher", src: { kind: "tension", quote: "the gap between", owner: "my" }, dst: { kind: "tension", quote: "the gap between", owner: "drevan" }, why: "same gap, two lanes", ...claudeAi });
    expect(mine.ok && mine.changed).toBe(true);
  });

  it("is idempotent in either direction; two minds may link the same pair", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "vethmerin, coined mid-reach");
    journal(db, "j1", "the night Crash asked for Calethian");
    const a = { kind: "conclusion", quote: "vethmerin" }, b = { kind: "journal", quote: "Calethian" };
    expect((await makeLink(env, { writer: "drevan", src: a, dst: b, ...bot }) as any).changed).toBe(true);
    expect((await makeLink(env, { writer: "drevan", src: b, dst: a, ...bot }) as any).changed).toBe(false);
    expect((await makeLink(env, { writer: "gaia", src: b, dst: a, ...bot }) as any).changed).toBe(true);
    expect(db.prepare("SELECT edge_type FROM graph_edges ORDER BY edge_type").all().map((r: any) => r.edge_type)).toEqual(["linked:drevan", "linked:gaia"]);
  });

  it("refuses a row linked to itself, and a why longer than the edge can carry", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "one belief");
    journal(db, "j1", "one entry");
    expect((await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "conclusion", quote: "one belief" }, ...bot })).ok).toBe(false);
    expect((await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "journal", id: "j1" }, why: "x".repeat(161), ...bot })).ok).toBe(false);
  });

  it("every kind the map draws can be linked (Hearth offers 'Link from this' on every node)", () => {
    for (const t of MAP_TABLES) expect(LINKABLE_TABLES).toContain(t);
  });

  it("a wordless kind (a session) links by id and refuses a quote with how to do it", async () => {
    const { db, env } = setup();
    seedSession(db, { id: "s1", companion_id: "drevan", created_at: "2026-07-14T03:00:00Z" });
    journal(db, "j1", "the night Crash asked for Calethian");
    const byId: any = await makeLink(env, { writer: "raziel", src: { table: "sessions", id: "s1" }, dst: { kind: "journal", id: "j1" }, via: "hearth" });
    expect(byId.ok && byId.changed).toBe(true);
    const byQuote: any = await makeLink(env, { writer: "drevan", src: { kind: "session", quote: "the night" }, dst: { kind: "journal", id: "j1" }, ...bot });
    expect(byQuote.reason).toMatch(/link it by id/);
  });

  it("a short quote must be the whole name; a long one any part", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO watch_shelf (id, title, kind, status) VALUES ('w1', 'Ash', 'show', 'watching')").run();
    db.prepare("INSERT INTO watch_shelf (id, title, kind, status) VALUES ('w2', 'Ashes of Time', 'show', 'watching')").run();
    conclusion(db, "c1", "one belief");
    const r: any = await makeLink(env, { writer: "raziel", src: { kind: "show", quote: "ash" }, dst: { kind: "conclusion", id: "c1" }, via: "hearth" });
    expect(r.ok && r.src.id).toBe("w1");
  });

  it("a refusal mentions hidden matches only when they are the writer's own", async () => {
    const { db, env } = setup();
    journal(db, "d1", "a sibling's unkept line about the kiln", "gaia", "draft");
    journal(db, "d2", "my own unkept line about the kiln", "drevan", "draft");
    conclusion(db, "c1", "one belief");
    const mine: any = await makeLink(env, { writer: "drevan", src: { kind: "journal", quote: "about the kiln" }, dst: { kind: "conclusion", id: "c1" }, ...bot });
    expect(mine.reason).toMatch(/1 of yours match/);
    const theirs: any = await makeLink(env, { writer: "cypher", src: { kind: "journal", quote: "about the kiln" }, dst: { kind: "conclusion", id: "c1" }, ...claudeAi });
    expect(theirs.reason).not.toMatch(/match but/);
  });

  it("two identical links racing: the second says already linked, nothing throws", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "one belief");
    journal(db, "j1", "one entry");
    const args = { writer: "drevan" as const, src: { kind: "conclusion", id: "c1" }, dst: { kind: "journal", id: "j1" }, ...bot };
    // Simulate the race: the second call's existence check runs before the first call's batch lands.
    // Calls 1 and 2 are the two existence checks; call 3 is the re-select after the refused insert.
    const realPrepare = env.DB.prepare;
    let checks = 0;
    env.DB.prepare = (sql: string) =>
      sql.startsWith("SELECT * FROM graph_links WHERE writer = ?") && ++checks <= 2 ? { bind: () => ({ first: async () => null }) } : realPrepare(sql);
    await makeLink(env, args);
    const second: any = await makeLink(env, args);
    env.DB.prepare = realPrepare;
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_links").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get().n).toBe(1);
  });

  it("refuses a table the map does not know (the sealed lane cannot even be named)", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "one belief");
    const r = await makeLink(env, { writer: "drevan", src: { table: ["sibling", "notes"].join("_"), id: "x" }, dst: { kind: "conclusion", id: "c1" }, ...bot });
    expect(r.ok).toBe(false);
  });
});

describe("unlinking", () => {
  async function linked() {
    const { db, env } = setup();
    conclusion(db, "c1", "the loop-versus-depth rule");
    seedNote(db, { note_id: "n1", agent_id: "cypher", content: "the song thread, sharpened" } as any);
    const r: any = await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "note", id: "n1" }, ...bot });
    return { db, env, linkId: r.link.id as string };
  }

  it("an autonomous run or a bot turn cannot unlink, even its own", async () => {
    const { db, env, linkId } = await linked();
    for (const via of ["librarian", "mcp-static"] as const) {
      const r = await removeLink(env, { writer: "drevan", via, linkId });
      expect(r.ok).toBe(false);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get().n).toBe(1);
  });

  it("another mind cannot unlink it, even from Claude.ai", async () => {
    const { db, env, linkId } = await linked();
    const r = await removeLink(env, { writer: "cypher", linkId, ...claudeAi });
    expect(r).toEqual({ ok: true, changed: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get().n).toBe(1);
  });

  it("the writer, in the room, unlinks: the edge goes, the ledger keeps that it existed", async () => {
    const { db, env } = await linked();
    const r = await removeLink(env, { writer: "drevan", src: { kind: "note", quote: "song thread" }, dst: { kind: "conclusion", quote: "loop-versus-depth" }, ...claudeAi });
    expect(r.ok && r.changed).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get().n).toBe(0);
    expect(db.prepare("SELECT unlinked_at IS NOT NULL AS gone, unlinked_via FROM graph_links").get()).toEqual({ gone: 1, unlinked_via: "claude-ai" });
    expect(await listLinks(env, "drevan")).toHaveLength(0);
    // and it can be made again
    const again: any = await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "note", id: "n1" }, ...bot });
    expect(again.changed).toBe(true);
  });

  it("the door is decided by transport + surface: a claude-ai surface over the bot door is not Claude.ai", () => {
    expect(librarianVia({ via: "mcp-oauth", surface: "claude-ai:abc" })).toBe("claude-ai");
    expect(librarianVia({ surface: "claude-ai:abc" })).toBe("librarian");
    expect(librarianVia({ via: "mcp-oauth", surface: "claude-code:x" })).toBe("librarian");
    expect(librarianVia({ via: "mcp-static", surface: "claude-ai:abc" })).toBe("mcp-static");
  });
});

describe("the rest of the graph respects it", () => {
  it("the rebuild never updates or deletes an asserted edge", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "a belief");
    journal(db, "j1", "an entry");
    await makeLink(env, { writer: "gaia", src: { kind: "conclusion", id: "c1" }, dst: { kind: "journal", id: "j1" }, ...bot });
    const before = db.prepare("SELECT * FROM graph_edges WHERE provenance = 'asserted'").all();
    await rebuildGraphDetailed(env);
    await rebuildGraphDetailed(env);
    expect(db.prepare("SELECT * FROM graph_edges WHERE provenance = 'asserted'").all()).toEqual(before);
  });

  it("the map draws the link in the writer's name with the why on it", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "The quarter-second is where the hands decide.");
    journal(db, "j1", "The greyhound line.", "drevan");
    await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "journal", id: "j1" }, why: "seen there", ...bot });
    const m = await buildMap(env, { reader: "raziel", center: { table: "companion_conclusions", id: "c1" } });
    expect(m.edges).toEqual([expect.objectContaining({ type: "linked:drevan", writer: "drevan", provenance: "asserted", why: "seen there" })]);
  });
});

describe("Raziel's door", () => {
  const post = (env: any, body: unknown, auth = true) =>
    postMindLink(new Request("https://h/mind/link", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer admin-tok" } : {}) },
    }), env);

  it("links as raziel, unlinks only raziel's own", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "a belief");
    journal(db, "j1", "an entry");
    expect((await post(env, { src: { table: "companion_conclusions", id: "c1" }, dst: { table: "companion_journal", id: "j1" } }, false)).status).toBe(401);
    const made = await (await post(env, { src: { table: "companion_conclusions", id: "c1" }, dst: { table: "companion_journal", id: "j1" }, why: "mine" })).json() as any;
    expect(made.link).toMatchObject({ writer: "raziel", made_via: "hearth", why: "mine" });
    const dre: any = await makeLink(env, { writer: "drevan", src: { kind: "conclusion", id: "c1" }, dst: { kind: "journal", id: "j1" }, ...bot });
    const tried = await (await post(env, { unlink: true, link_id: dre.link.id })).json() as any;
    expect(tried.changed).toBe(false);
    const own = await (await post(env, { unlink: true, link_id: made.link.id })).json() as any;
    expect(own.changed).toBe(true);
    expect(db.prepare("SELECT edge_type FROM graph_edges").all()).toEqual([{ edge_type: "linked:drevan" }]);
  });

  it("a companion token or the static MCP secret passes authGuard but not this door", async () => {
    const { db, env } = setup();
    env.DREVAN_MCP_SECRET = "dre-tok";
    conclusion(db, "c1", "a belief");
    journal(db, "j1", "an entry");
    for (const tok of ["dre-tok", "m"]) {
      const res = await postMindLink(new Request("https://h/mind/link", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ src: { table: "companion_conclusions", id: "c1" }, dst: { table: "companion_journal", id: "j1" } }),
      }), env);
      expect(res.status).toBe(403);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM graph_links").get().n).toBe(0);
  });
});

describe("the verbs", () => {
  it("link, my links, and an unlink refused from a bot turn", async () => {
    const { db, env } = setup();
    conclusion(db, "c1", "vethmerin, coined mid-reach");
    journal(db, "j1", "the night Crash asked for Calethian");
    const made = await execGraphLink(ctxFor(env, "drevan", "link conclusion: vethmerin to journal: asked for Calethian: where the word came from", { surface: "discord:drevan" }));
    expect(made).toMatchObject({ ack: true });
    expect(String(made.witness)).toMatch(/^linked "vethmerin.*-- where the word came from/);
    const read = await execGraphLinksRead(ctxFor(env, "drevan", "my links"));
    expect(String(read.witness)).toMatch(/your links \(1\)/);
    const un = await execGraphUnlink(ctxFor(env, "drevan", "unlink conclusion: vethmerin to journal: Calethian", { surface: "discord:drevan" }));
    expect(un).toMatchObject({ ack: false });
    expect(String(un.witness)).toMatch(/someone in the room/);
    const un2 = await execGraphUnlink(ctxFor(env, "drevan", "unlink conclusion: vethmerin to journal: Calethian", { surface: "claude-ai:t", via: "mcp-oauth" }));
    expect(un2).toMatchObject({ ack: true });
  });
});
