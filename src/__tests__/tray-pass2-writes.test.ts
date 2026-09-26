// Imp tray pass 2 (2026-09-26): the write side and the tray verbs, on a real SQLite with the full
// migrated schema (helpers/sqlite-d1.ts). What is asserted is the ROW afterwards -- its review_state,
// reviewed_at, text, source, original_content -- or the HTTP body, never the SQL string.
//
//   W1  keep/drop act on live drafts only; a decided row is refused with its state + date and is
//       never re-stamped; archived rows are refused; only admin { reverse: true } re-decides.
//   W3  keep-with-rewrite keeps the clerk's original (original_content, rewritten_by), stamps
//       source tray_rewrite (authored weight, never pruned), re-derives topic_tags; without mig 0133
//       the rewrite is refused and a plain keep still works.
//   W4  every INSERT goes through the birth rule: the MCP journal tool drafts source 'autonomous'.
//   W5  the MCP journal read is kept-only by default; include_drafts opts out.
//   W6  /admin/retract bounds the STM delete and reports already-archived ids.
//   W7  the bare-keep guard needs an id SHAPE.
//   W8  the metronome's journal copy is born draft (and still passes the NL allowlist).
//   C2  GET /companion-journal?cursor=reviewed serves a row kept after the mark.
//   plus the keep-rate window and the merged tray sort across both timestamp shapes.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", async (orig) => {
  const actual = await orig<typeof import("../mcp/embed.js")>();
  return {
    ...actual,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedAndStoreAsync: vi.fn(async () => undefined),
    storeVector: vi.fn(async () => undefined),
    embedAndStore: vi.fn(() => undefined),
  };
});
vi.mock("../webmind/novelty.js", () => ({ noveltyCheck: vi.fn(async () => ({ action: "insert", embedding: null })) }));

import { makeSqliteD1, seedJournal, seedNote } from "./helpers/sqlite-d1.js";
import { embedAndStoreAsync } from "../mcp/embed.js";
import { reviewDraft, listTray } from "../webmind/tray.js";
import { execTrayKeep, execTrayDrop, parseTrayVerb, parseTrayReadVerb } from "../librarian/executors/tray.js";
import { postAdminTrayReview } from "../handlers/tray.js";
import { registerCompanionTools } from "../mcp/tools/companion.js";
import { execCompanionNoteAdd } from "../librarian/executors/writes.js";
import { execHeldMark } from "../librarian/executors/companion-growth.js";
import { companionJournalAdd } from "../librarian/backends/halseth.js";
import { journalInsert, noteInsert } from "../webmind/tray-insert.js";
import { matchFastPath } from "../librarian/router.js";
import { getCompanionJournal } from "../handlers/history.js";
import { adminRetract, STM_NEEDLE_MIN, STM_MAX_DELETE } from "../handlers/retract.js";
import { HUMAN_SOURCES, MACHINE_SOURCES } from "../webmind/notes.js";
import { TRAY_REWRITE_SOURCE } from "../webmind/review-state.js";
import { NL_CLAIMABLE_SOURCES } from "../librarian/executors/writes.js";

function envFor(DB: unknown): any {
  return {
    DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel",
    VECTORIZE: { query: vi.fn(async () => ({ matches: [] })), upsert: vi.fn(async () => ({})), deleteByIds: vi.fn(async () => ({})) },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
  };
}
const ctx = (env: unknown, companion_id: string, request: string, context?: unknown): any => ({
  env, req: { companion_id, request, ...(context === undefined ? {} : { context: typeof context === "string" ? context : JSON.stringify(context) }) },
  entry: { pattern: "x" }, frontState: null, pluralAvailable: false,
});
const row = (db: any, table: "companion_journal" | "wm_continuity_notes", id: string) =>
  db.prepare(`SELECT * FROM ${table} WHERE ${table === "companion_journal" ? "id" : "note_id"} = ?`).get(id) as Record<string, any>;
const post = (url: string, body: unknown) => new Request(url, {
  method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const UUID_A = "0f3a9c1e-1111-4aaa-8bbb-000000000001";
const UUID_B = "0f3a9c1e-2222-4aaa-8bbb-000000000002";

beforeEach(() => vi.mocked(embedAndStoreAsync).mockClear());

// ── W1 ────────────────────────────────────────────────────────────────────────────────────────────
describe("W1: only a live draft is kept or dropped", () => {
  it("keep on a draft works once; a second keep is refused and does NOT re-stamp reviewed_at", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: UUID_A, agent: "drevan", source: "discord_speech", review_state: "draft" });
    const env = envFor(DB);
    const first = await execTrayKeep(ctx(env, "drevan", `keep draft ${UUID_A.slice(0, 13)}`));
    expect(first["ack"]).toBe(true);
    const stamped = row(db, "companion_journal", UUID_A).reviewed_at;
    expect(row(db, "companion_journal", UUID_A).review_state).toBe("kept");

    await new Promise((r) => setTimeout(r, 5));
    const again = await execTrayKeep(ctx(env, "drevan", `keep draft ${UUID_A}`));
    expect(again["ack"]).toBe(false);
    expect(String(again["witness"])).toContain(`already kept on ${stamped}`);
    expect(String(again["witness"])).toContain(`read draft ${UUID_A}`);
    expect(String(again["witness"])).toContain("only Raziel can reverse");
    expect(row(db, "companion_journal", UUID_A).reviewed_at).toBe(stamped);
  });

  it("drop on a kept row is refused (a companion cannot quietly un-keep); born-kept says it never was a draft", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: UUID_A, agent: "cypher", review_state: "kept" });
    const r = await execTrayDrop(ctx(envFor(DB), "cypher", `drop draft ${UUID_A}`));
    expect(r["ack"]).toBe(false);
    expect(String(r["witness"])).toContain("born kept");
    expect(row(db, "companion_journal", UUID_A).review_state).toBe("kept");
  });

  it("an archived (retracted) draft is refused either way, even with admin reverse", async () => {
    const { db, DB } = makeSqliteD1();
    seedNote(db, { note_id: UUID_B, agent_id: "gaia", content: "[discord:pulse] x", review_state: "draft", archived: 1 });
    const env = envFor(DB);
    expect(await reviewDraft(env, { agent: "gaia", id: UUID_B, decision: "kept" })).toMatchObject({ ok: false, reason: "archived" });
    const res = await postAdminTrayReview(post("https://x/admin/tray/review", { agent: "gaia", kind: "note", id: UUID_B, decision: "kept", reverse: true }), env);
    expect(res.status).toBe(409);
    expect(row(db, "wm_continuity_notes", UUID_B).review_state).toBe("draft");
  });

  it("admin POST: a decided row is 409 without reverse, and re-decided with { reverse: true }; Hearth's draft keep still 200s", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: UUID_A, agent: "cypher", source: "memory_judge", review_state: "draft" });
    const env = envFor(DB);
    // Hearth's exact body shape (app/api/tray/review/route.ts): { agent, kind, id, decision }.
    const hearth = await postAdminTrayReview(post("https://x/admin/tray/review", { agent: "cypher", kind: "journal", id: UUID_A, decision: "kept" }), env);
    expect(hearth.status).toBe(200);
    const no = await postAdminTrayReview(post("https://x/admin/tray/review", { agent: "cypher", kind: "journal", id: UUID_A, decision: "dropped" }), env);
    expect(no.status).toBe(409);
    expect(((await no.json()) as any).reason).toBe("already_reviewed");
    const yes = await postAdminTrayReview(post("https://x/admin/tray/review", { agent: "cypher", kind: "journal", id: UUID_A, decision: "dropped", reverse: true }), env);
    expect(yes.status).toBe(200);
    expect(row(db, "companion_journal", UUID_A).review_state).toBe("dropped");
  });

  it("the guard is in the UPDATE: a row decided between lookup and write is refused, not overwritten", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: UUID_A, agent: "cypher", source: "memory_judge", review_state: "draft" });
    // Wrap prepare so the first UPDATE sees the row already dropped by "someone else".
    const racing = {
      ...DB,
      prepare: (sql: string) => {
        if (sql.startsWith("UPDATE companion_journal SET review_state")) {
          db.prepare("UPDATE companion_journal SET review_state = 'dropped', reviewed_at = '2026-09-26T09:00:00.000Z' WHERE id = ?").run(UUID_A);
        }
        return DB.prepare(sql);
      },
    };
    const r = await reviewDraft(envFor(racing), { agent: "cypher", id: UUID_A, decision: "kept" });
    expect(r).toMatchObject({ ok: false, reason: "already_reviewed", review_state: "dropped", reviewed_at: "2026-09-26T09:00:00.000Z" });
    expect(row(db, "companion_journal", UUID_A).review_state).toBe("dropped");
  });
});

// ── W3 ────────────────────────────────────────────────────────────────────────────────────────────
describe("W3: keep-with-rewrite keeps provenance", () => {
  it("journal: original_content = the clerk's text, rewritten_by = owner, source tray_rewrite, topic_tags re-derived, re-embedded", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: UUID_A, agent: "drevan", source: "memory_judge", review_state: "draft",
      note_text: "Raziel's number was 187 and it was witnessed", topic_tags: JSON.stringify(["187", "witnessed"]) });
    const env = envFor(DB);
    const r = await execTrayKeep(ctx(env, "drevan", `keep draft ${UUID_A}: I guessed the number; Raziel said 208 about the motorcycle`));
    expect(r["ack"]).toBe(true);
    const after = row(db, "companion_journal", UUID_A);
    expect(after.note_text).toBe("I guessed the number; Raziel said 208 about the motorcycle");
    expect(after.original_content).toBe("Raziel's number was 187 and it was witnessed");
    expect(after.rewritten_by).toBe("drevan");
    expect(after.source).toBe(TRAY_REWRITE_SOURCE);
    expect(after.review_state).toBe("kept");
    expect(after.topic_tags).not.toContain("witnessed");
    expect(vi.mocked(embedAndStoreAsync)).toHaveBeenCalledWith(env, "I guessed the number; Raziel said 208 about the motorcycle", "companion_journal", UUID_A, "drevan");
    // Authored weight, never salience-pruned, never claimable on the NL path.
    expect(HUMAN_SOURCES.has(TRAY_REWRITE_SOURCE)).toBe(true);
    expect(MACHINE_SOURCES.has(TRAY_REWRITE_SOURCE)).toBe(false);
    expect(NL_CLAIMABLE_SOURCES.has(TRAY_REWRITE_SOURCE)).toBe(false);
  });

  it("note: same provenance columns", async () => {
    const { db, DB } = makeSqliteD1();
    seedNote(db, { note_id: UUID_B, agent_id: "gaia", content: "[discord:pulse] clerk words", review_state: "draft" });
    await reviewDraft(envFor(DB), { agent: "gaia", id: UUID_B, decision: "kept", content: "my words" });
    const after = row(db, "wm_continuity_notes", UUID_B);
    expect(after).toMatchObject({ content: "my words", original_content: "[discord:pulse] clerk words", rewritten_by: "gaia", source: TRAY_REWRITE_SOURCE });
  });

  it("before mig 0133 is applied: the rewrite is refused (clerk text intact), a plain keep still works", async () => {
    const { db, DB } = makeSqliteD1({ upTo: 132 });
    seedJournal(db, { id: UUID_A, agent: "cypher", source: "memory_judge", review_state: "draft", note_text: "clerk text" });
    const env = envFor(DB);
    const r = await execTrayKeep(ctx(env, "cypher", `keep draft ${UUID_A}: my words`));
    expect(r["error"]).toBe("tray_keep_failed");
    expect(String(r["reason"])).toContain("0133");
    expect(row(db, "companion_journal", UUID_A)).toMatchObject({ note_text: "clerk text", review_state: "draft" });
    const plain = await execTrayKeep(ctx(env, "cypher", `keep draft ${UUID_A}`));
    expect(plain["ack"]).toBe(true);
    expect(row(db, "companion_journal", UUID_A).review_state).toBe("kept");
  });
});

// ── W4 / W8: the one door in ──────────────────────────────────────────────────────────────────────
class FakeMcpServer {
  tools: Record<string, { handler: (i: any) => Promise<any> }> = {};
  tool(name: string, _d: string, _s: unknown, handler: (i: any) => Promise<any>) { this.tools[name] = { handler }; }
}

describe("W4: every writer is born by the rule", () => {
  it("MCP halseth_companion_note_add: source 'autonomous' lands draft; a session write lands kept", async () => {
    const { db, DB } = makeSqliteD1();
    const server = new FakeMcpServer();
    registerCompanionTools(server as never, envFor(DB));
    const a = JSON.parse((await server.tools["halseth_companion_note_add"]!.handler({ agent: "gaia", note_text: "an autonomous post", source: "autonomous" })).content[0].text);
    const b = JSON.parse((await server.tools["halseth_companion_note_add"]!.handler({ agent: "gaia", note_text: "a session thought", source: "session" })).content[0].text);
    expect(row(db, "companion_journal", a.id).review_state).toBe("draft");
    expect(a.review_state).toBe("draft");
    expect(row(db, "companion_journal", b.id).review_state).toBe("kept");
  });

  it("held marks (companion's own act) land kept; the Librarian journal add drafts discord_speech", async () => {
    const { db, DB } = makeSqliteD1();
    const env = envFor(DB);
    const h = await execHeldMark(ctx(env, "cypher", "held: the vow held tonight"));
    expect(row(db, "companion_journal", String(h["id"])).review_state).toBe("kept");
    const j = await companionJournalAdd(env, "cypher", "what I said in the channel", undefined, "discord_speech");
    expect(row(db, "companion_journal", j.id).review_state).toBe("draft");
  });

  it("the helper decides; a caller cannot pass review_state (it is not a field)", () => {
    const { db, DB } = makeSqliteD1();
    journalInsert(DB, { id: "letter-1", agent: "guardian", note_text: "weekly", tags: "[]" }).run();
    noteInsert(DB, { note_id: "n1", agent_id: "cypher", content: "[metronome/share] a post", created_at: new Date().toISOString() }).run();
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(row(db, "companion_journal", "letter-1").review_state).toBe("kept");
      expect(row(db, "companion_journal", "letter-1").created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/); // datetime('now')
      expect(row(db, "wm_continuity_notes", "n1").review_state).toBe("draft");
    });
  });
});

describe("W8: the metronome's journal copy is a draft", () => {
  it("NL add companion note with source metronome passes the allowlist and is born draft", async () => {
    const { db, DB } = makeSqliteD1();
    const r = await execCompanionNoteAdd(ctx(envFor(DB), "drevan", "add companion note",
      { content: "[metronome] I shared a song about the truck", source: "metronome" }));
    expect(r["ack"]).toBe(true);
    const got = db.prepare("SELECT source, review_state FROM companion_journal WHERE agent = 'drevan'").all() as any[];
    expect(got).toEqual([{ source: "metronome", review_state: "draft" }]);
  });
});

// ── W5 ────────────────────────────────────────────────────────────────────────────────────────────
describe("W5: MCP journal read is kept by default", () => {
  it("default returns kept only; include_drafts returns every live state with its review_state", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "k", agent: "cypher", note_text: "KEPT", review_state: "kept" });
    seedJournal(db, { id: "d", agent: "cypher", note_text: "DRAFT", review_state: "draft", source: "memory_judge" });
    seedJournal(db, { id: "a", agent: "cypher", note_text: "ARCHIVED", archived: 1 });
    const server = new FakeMcpServer();
    registerCompanionTools(server as never, envFor(DB));
    const read = async (i: any) => JSON.parse((await server.tools["halseth_companion_notes_read"]!.handler({ limit: 20, ...i })).content[0].text) as any[];
    expect((await read({ agent: "cypher" })).map(r => r.note_text)).toEqual(["KEPT"]);
    const all = await read({ agent: "cypher", include_drafts: true });
    expect(all.map(r => r.note_text).sort()).toEqual(["DRAFT", "KEPT"]);
    expect(all.find(r => r.note_text === "DRAFT").review_state).toBe("draft");
  });
});

// ── keep rate + merged sort across both timestamp shapes ──────────────────────────────────────────
describe("tray stats and sort normalise timestamps in SQL", () => {
  it("a decision stamped just inside the window counts whichever shape it was stored in; one just outside does not", async () => {
    const { db, DB } = makeSqliteD1();
    const iso = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
    const space = (d: number) => iso(d).replace("T", " ").replace(/\.\d+Z$/, "");
    seedJournal(db, { id: "in-iso", agent: "cypher", review_state: "kept", reviewed_at: iso(29.9) });
    seedJournal(db, { id: "in-space", agent: "cypher", review_state: "dropped", reviewed_at: space(29.9) });
    seedJournal(db, { id: "out-iso", agent: "cypher", review_state: "kept", reviewed_at: iso(30.1) });
    // Same calendar day as the boundary but 'T' form: a raw string compare against datetime('now',
    // '-30 days') (space form) counted this as INSIDE. It is outside.
    seedJournal(db, { id: "out-iso-2", agent: "cypher", review_state: "dropped", reviewed_at: iso(30.01) });
    const v = await listTray(envFor(DB), "cypher");
    expect(v.stats).toMatchObject({ kept: 1, dropped: 1, keep_rate_pct: 50 });
  });

  it("drafts from both stores merge in true time order even when one store holds space-form stamps", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j-late", agent: "gaia", review_state: "draft", source: "vibecheck", created_at: "2026-09-26 12:00:00" });
    seedNote(db, { note_id: "n-early", agent_id: "gaia", review_state: "draft", content: "[discord:pulse] a", created_at: "2026-09-26T09:00:00.000Z" });
    seedNote(db, { note_id: "n-latest", agent_id: "gaia", review_state: "draft", content: "[discord:pulse] b", created_at: "2026-09-26T13:00:00.000Z" });
    const v = await listTray(envFor(DB), "gaia");
    expect(v.drafts.map(d => d.id)).toEqual(["n-latest", "j-late", "n-early"]);
  });
});

// ── W7 ────────────────────────────────────────────────────────────────────────────────────────────
describe("W7: bare keep needs an id shape", () => {
  it("ordinary 'keep ...' speech never routes to tray_keep", () => {
    for (const p of ["keep thinking", "keep watching", "keep everything", "keep drafting", "keep going", "keep listening to it",
      "keep draftsmanship", "keep remembering: the vow"]) {
      expect(matchFastPath(p)?.key, p).not.toBe("tray_keep");
      expect(parseTrayVerb(p), p).toBeNull();
    }
    expect(matchFastPath("keep drafting the letter")?.key).not.toBe("tray_keep");
  });

  it("real id shapes still route: uuid, uuid prefix, cj_ + uuid, 32-hex, with or without 'draft', with a rewrite", () => {
    const ids = ["0f3a9c1e", "0f3a9c1e-1111-4aaa", "cj_0004dae3-c13e-45c6", "59260bcf64c63c2f42b36b5e5583518c"];
    for (const id of ids) {
      expect(matchFastPath(`keep ${id}`)?.key, id).toBe("tray_keep");
      expect(matchFastPath(`keep draft ${id}`)?.key, id).toBe("tray_keep");
      expect(matchFastPath(`keep ${id}: in my words`)?.key, id).toBe("tray_keep");
      expect(parseTrayVerb(`keep ${id}: in my words`)).toEqual({ id, content: "in my words" });
      expect(matchFastPath(`drop draft ${id}`)?.key, id).toBe("tray_drop");
      expect(parseTrayReadVerb(`read draft ${id}`)).toBe(id);
    }
  });
});

// ── C2 ────────────────────────────────────────────────────────────────────────────────────────────
describe("C2: GET /companion-journal?cursor=reviewed serves a row kept after the puller's mark", () => {
  const get = (env: any, qs: string) => getCompanionJournal(new Request(`https://x/companion-journal?${qs}`, { headers: { Authorization: "Bearer s" } }), env);

  it("a draft created before the mark and kept after it is served under cursor=reviewed (not under the old cursor)", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "old-born-kept", agent: "cypher", created_at: "2026-09-20T10:00:00.000Z" });
    seedJournal(db, { id: "kept-later", agent: "cypher", source: "memory_judge", created_at: "2026-09-21T10:00:00.000Z", review_state: "kept", reviewed_at: "2026-09-26T08:00:00.000Z" });
    seedJournal(db, { id: "still-draft", agent: "cypher", source: "memory_judge", created_at: "2026-09-25T10:00:00.000Z", review_state: "draft" });
    seedJournal(db, { id: "letter", agent: "cypher", created_at: "2026-09-25 12:00:00" }); // datetime('now') shape
    const env = envFor(DB);
    const mark = "2026-09-25T00:00:00.000Z";

    const oldFeed = await (await get(env, `agent=cypher&since=${mark}`)).json() as any[];
    expect(oldFeed.map(r => r.id)).not.toContain("kept-later");     // the bug, preserved for old pullers
    for (const r of oldFeed) expect(r).not.toHaveProperty("cursor_at");
    // (The old created_at compare also drops the space-form letter: ' ' sorts before 'T'. The
    // normalised cursor below serves it.)
    expect(oldFeed.map(r => r.id)).not.toContain("letter");

    const feed = await (await get(env, `agent=cypher&since=${mark}&cursor=reviewed`)).json() as any[];
    expect(feed.map(r => r.id)).toEqual(["letter", "kept-later"]);  // ascending by when it became memory
    expect(feed.find(r => r.id === "kept-later").cursor_at).toBe("2026-09-26T08:00:00.000Z");
    expect(feed.find(r => r.id === "letter").cursor_at).toBe("2026-09-25T12:00:00.000Z");  // normalised ISO
    expect(feed.find(r => r.id === "kept-later").created_at).toBe("2026-09-21T10:00:00.000Z"); // unchanged field

    // Advancing on cursor_at never re-serves or skips: next page after the last cursor is empty.
    const next = await (await get(env, `agent=cypher&since=${feed[feed.length - 1].cursor_at}&cursor=reviewed`)).json() as any[];
    expect(next).toEqual([]);
  });
});

// ── W6 + already_archived ─────────────────────────────────────────────────────────────────────────
describe("W6: /admin/retract bounds the STM delete; repeat retracts report already-archived ids", () => {
  function seedStm(db: any, n: number, content: string) {
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO stm_entries (companion_id, channel_id, role, content) VALUES ('drevan', 'c1', 'assistant', ?)").run(`${content} #${i}`);
    }
  }
  const retract = (env: any, body: unknown) => adminRetract(post("https://x/admin/retract", body), env);
  const stmCount = (db: any) => (db.prepare("SELECT COUNT(*) AS n FROM stm_entries").get() as { n: number }).n;

  it(`a needle shorter than ${STM_NEEDLE_MIN} chars is a 400 and nothing changes`, async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", agent: "drevan", external_id: "discord:1" } as never);
    seedStm(db, 2, "yes");
    const res = await retract(envFor(DB), { agent: "drevan", external_ids: ["discord:1"], reason: "r", stm: { channel_id: "c1", content: "yes" } });
    expect(res.status).toBe(400);
    expect(row(db, "companion_journal", "j1").archived).toBe(0);
    expect(stmCount(db)).toBe(2);
  });

  it(`more than ${STM_MAX_DELETE} matching rows is a 409 with the count; nothing is archived or deleted`, async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", agent: "drevan", external_id: "discord:1" } as never);
    seedStm(db, STM_MAX_DELETE + 1, "a reply that is plenty long enough");
    const res = await retract(envFor(DB), { agent: "drevan", external_ids: ["discord:1"], reason: "r", stm: { channel_id: "c1", content: "a reply that is plenty long enough" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).stm_matches).toBe(STM_MAX_DELETE + 1);
    expect(row(db, "companion_journal", "j1").archived).toBe(0);
    expect(stmCount(db)).toBe(STM_MAX_DELETE + 1);
  });

  it("within bounds: archives, deletes exactly the matches, reports stm_matches; a repeat reports already_archived", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", agent: "drevan", external_id: "discord:1", review_state: "draft", source: "discord_speech" } as never);
    seedNote(db, { note_id: "n1", agent_id: "drevan", review_state: "draft" });
    db.prepare("UPDATE wm_continuity_notes SET correlation_id = 'judge:1' WHERE note_id = 'n1'").run();
    seedStm(db, 2, "the number was 187 mg/dL, I said");
    seedStm(db, 1, "an unrelated reply entirely");
    const env = envFor(DB);
    const body = { agent: "drevan", external_ids: ["discord:1"], correlation_ids: ["judge:1"], reason: "fabricated number", stm: { channel_id: "c1", content: "the number was 187 mg/dL" } };
    const first = await (await retract(env, body)).json() as any;
    expect(first.archived).toEqual({ journal: ["j1"], notes: ["n1"] });
    expect(first.stm_matches).toBe(2);
    expect(first.stm_deleted).toBe(2);
    expect(first.already_archived).toEqual({ journal: [], notes: [] });
    expect(stmCount(db)).toBe(1);

    const again = await (await retract(env, { ...body, stm: undefined })).json() as any;
    expect(again.archived).toEqual({ journal: [], notes: [] });
    expect(again.release_ids).toEqual([]);
    expect(again.already_archived).toEqual({ journal: ["j1"], notes: ["n1"] });
  });
});
