// Imp tray pass 2 (2026-09-26), C1: DERIVED inputs never launder a draft.
//
// Every test here runs the real job/handler/executor against a real SQLite with the full migrated
// schema (helpers/sqlite-d1.ts). Each seeds one KEPT row and one DRAFT row (plus, where it matters, a
// DROPPED and an ARCHIVED row) with distinctive text, runs the code, and asserts on what came out --
// the prompt the LLM was handed, the rows returned, the rows written -- never on SQL text.

import { describe, it, expect, vi, beforeEach } from "vitest";

const prompts: string[] = [];
vi.mock("../synthesis/deepseek.js", async (orig) => {
  const actual = await orig<typeof import("../synthesis/deepseek.js")>();
  return {
    ...actual,
    // Capture the prompt, then stop the job: what matters is what it was about to say.
    complete: vi.fn(async (_sys: string, user: string) => { prompts.push(user); throw new Error("STOP_AFTER_PROMPT"); }),
  };
});
vi.mock("../librarian/backends/second-brain.js", () => ({
  sbSaveDocument: vi.fn(async () => ({ ok: true })),
  sbIngestRaw: vi.fn(async () => ({ ok: true })),
}));
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

import { makeSqliteD1, seedJournal, seedNote, seedSession } from "./helpers/sqlite-d1.js";
import { runDailyNarrative } from "../synthesis/jobs/daily-narrative.js";
import { runSomaticSnapshot } from "../synthesis/jobs/somatic-snapshot.js";
import { runSessionSummary } from "../synthesis/jobs/session-summary.js";
import { postMotifsDetect } from "../handlers/motifs.js";
import { execPatternRecall, execJournalSearch, execJournalRead } from "../librarian/executors/reads.js";
import { execHeldRead, execRecentRecall } from "../librarian/executors/companion-growth.js";
import { readSittingNotes } from "../webmind/sits.js";
import { addNote, getEligibleNotesForCompression, archiveNotes, recallNotes } from "../webmind/notes.js";
import { runSaliencePrune } from "../webmind/salience-prune.js";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

function envFor(DB: unknown): any {
  return {
    DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel",
    VECTORIZE: { query: vi.fn(async () => ({ matches: [] })), upsert: vi.fn(async () => ({})), deleteByIds: vi.fn(async () => ({})) },
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
  };
}

/** One row of each state, all recent, all the same agent. */
function seedFour(db: any, agent = "cypher", extra: Partial<Parameters<typeof seedJournal>[1]> = {}) {
  seedJournal(db, { id: "j-kept", agent, note_text: "KEPT_LINE the lighthouse held", created_at: hoursAgo(2), review_state: "kept", ...extra });
  seedJournal(db, { id: "j-draft", agent, note_text: "DRAFT_LINE the number was 187", created_at: hoursAgo(1), review_state: "draft", source: "memory_judge", ...extra });
  seedJournal(db, { id: "j-dropped", agent, note_text: "DROPPED_LINE never memory", created_at: hoursAgo(1), review_state: "dropped", reviewed_at: hoursAgo(0.5), source: "discord_speech", ...extra });
  seedJournal(db, { id: "j-archived", agent, note_text: "ARCHIVED_LINE retracted", created_at: hoursAgo(1), review_state: "kept", archived: 1, ...extra });
}

const ctx = (env: unknown, companion_id: string, request: string, context?: unknown): any => ({
  env, req: { companion_id, request, ...(context === undefined ? {} : { context: typeof context === "string" ? context : JSON.stringify(context) }) },
  entry: { pattern: "x" }, frontState: null, pluralAvailable: false,
});

beforeEach(() => { prompts.length = 0; });

describe("synthesis jobs read kept + live journal rows only", () => {
  it("daily narrative: the prompt carries the kept line and none of draft / dropped / archived", async () => {
    const { db, DB } = makeSqliteD1();
    seedFour(db);
    await runDailyNarrative("cypher", envFor(DB)).catch((e) => { if (!String(e).includes("STOP_AFTER_PROMPT")) throw e; });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("KEPT_LINE");
    for (const bad of ["DRAFT_LINE", "DROPPED_LINE", "ARCHIVED_LINE"]) expect(prompts[0]).not.toContain(bad);
  });

  it("somatic snapshot: same", async () => {
    const { db, DB } = makeSqliteD1();
    seedFour(db);
    await runSomaticSnapshot("cypher", envFor(DB)).catch((e) => { if (!String(e).includes("STOP_AFTER_PROMPT")) throw e; });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("KEPT_LINE");
    for (const bad of ["DRAFT_LINE", "DROPPED_LINE", "ARCHIVED_LINE"]) expect(prompts[0]).not.toContain(bad);
  });

  it("session summary: the session's draft speech and archived rows never reach the summary prompt", async () => {
    const { db, DB } = makeSqliteD1();
    seedSession(db, { id: "s1", created_at: hoursAgo(3) });
    seedFour(db, "cypher", { session_id: "s1" });
    await runSessionSummary("s1", envFor(DB)).catch((e) => { if (!String(e).includes("STOP_AFTER_PROMPT")) throw e; });
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0]).toContain("KEPT_LINE");
    for (const bad of ["DRAFT_LINE", "DROPPED_LINE", "ARCHIVED_LINE"]) expect(prompts[0]).not.toContain(bad);
  });
});

describe("motifs count kept rows only", () => {
  it("a word recurring only in drafts never becomes a motif; the kept one does", async () => {
    const { db, DB } = makeSqliteD1();
    for (let i = 0; i < 6; i++) {
      seedJournal(db, { id: `k${i}`, agent: "gaia", note_text: `the lighthouse keeper walked ${i}`, created_at: daysAgo(1 + i / 10), review_state: "kept" });
      seedJournal(db, { id: `d${i}`, agent: "gaia", note_text: `zanzibar zanzibar orbit ${i}`, created_at: daysAgo(1 + i / 10), review_state: "draft", source: "memory_judge" }); // not a chatter-lane source: only the tray gate can exclude it
    }
    const res = await postMotifsDetect(new Request("https://x/mind/motifs/detect", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify({ companion_id: "gaia" }),
    }), envFor(DB));
    expect(res.status).toBe(200);
    const labels = (db.prepare("SELECT label FROM companion_motifs WHERE companion_id = 'gaia'").all() as Array<{ label: string }>).map(r => r.label);
    expect(labels.some(l => l.includes("lighthouse"))).toBe(true);
    expect(labels.some(l => l.includes("zanzibar"))).toBe(false);
  });
});

describe("Librarian reads that present rows as the companion's own", () => {
  it("pattern recall, journal search, read my journal, held read, recent recall: kept + live only", async () => {
    const { db, DB } = makeSqliteD1();
    const tags = JSON.stringify(["pattern_synthesis", "held"]);
    seedFour(db, "drevan", { tags });
    const env = envFor(DB);
    const texts = (rows: unknown[]) => JSON.stringify(rows);

    const pr = await execPatternRecall(ctx(env, "drevan", "recall patterns"));
    const js = await execJournalSearch(ctx(env, "drevan", "search my journal for LINE"));
    const jr = await execJournalRead(ctx(env, "drevan", "read my journal"));
    const hr = await execHeldRead(ctx(env, "drevan", "held moments"));
    const rr = await execRecentRecall(ctx(env, "drevan", "recall"));
    for (const [name, out] of Object.entries({ pr, js, jr, hr, rr })) {
      const s = texts([out]);
      expect(s, name).toContain("KEPT_LINE");
      for (const bad of ["DRAFT_LINE", "DROPPED_LINE", "ARCHIVED_LINE"]) expect(s, `${name} leaked ${bad}`).not.toContain(bad);
    }
  });

  it("sitting notes: a draft (or archived row) that got sat on is not served as unresolved material", async () => {
    const { db, DB } = makeSqliteD1();
    seedFour(db, "cypher", { processing_status: "sitting" });
    for (const id of ["j-kept", "j-draft", "j-dropped", "j-archived"]) {
      db.prepare("INSERT INTO companion_journal_sits (id, note_id, companion_id, sit_text, sat_at) VALUES (?, ?, 'cypher', 'sat', ?)").run(`s-${id}`, id, daysAgo(30));
    }
    const all = await readSittingNotes(envFor(DB), "cypher" as never);
    expect(all.map(n => n.note_id)).toEqual(["j-kept"]);
  });
});

describe("note compaction never digests or deletes a draft or a dropped row", () => {
  it("cap eviction (addNote over NOTE_CAP): only kept overflow is digested/deleted; drafts + dropped survive untouched", async () => {
    const { db, DB } = makeSqliteD1();
    // 100 kept evictable notes (at cap), cold and old, plus 30 drafts and 5 dropped that are colder still.
    for (let i = 0; i < 100; i++) seedNote(db, { note_id: `k${i}`, agent_id: "gaia", content: `kept ${i}`, created_at: daysAgo(60 - i / 10), heat: 0.5 + i / 1000 });
    for (let i = 0; i < 30; i++) seedNote(db, { note_id: `d${i}`, agent_id: "gaia", content: `[discord:pulse] DRAFT_NOTE ${i}`, created_at: daysAgo(90), review_state: "draft", heat: 0.01 });
    for (let i = 0; i < 5; i++) seedNote(db, { note_id: `x${i}`, agent_id: "gaia", content: `DROPPED_NOTE ${i}`, created_at: daysAgo(90), review_state: "dropped", reviewed_at: daysAgo(80), heat: 0.01 });
    const env = envFor(DB);
    await addNote(env, { agent_id: "gaia", content: "a new kept note", salience: "normal" } as never);
    await addNote(env, { agent_id: "gaia", content: "another kept note", salience: "normal" } as never);

    const count = (state: string) => (db.prepare("SELECT COUNT(*) AS n FROM wm_continuity_notes WHERE agent_id = 'gaia' AND review_state = ?").get(state) as { n: number }).n;
    expect(count("draft")).toBe(30);
    expect(count("dropped")).toBe(5);
    const digests = db.prepare("SELECT summary FROM wm_archive_notes WHERE agent_id = 'gaia'").all() as Array<{ summary: string }>;
    expect(digests.length).toBeGreaterThan(0);                      // the cap DID run
    for (const d of digests) {
      expect(d.summary).not.toContain("DRAFT_NOTE");
      expect(d.summary).not.toContain("DROPPED_NOTE");
    }
  });

  it("compression: eligible set is kept-only, and archiveNotes refuses a draft id handed back by the summariser", async () => {
    const { db, DB } = makeSqliteD1();
    for (let i = 0; i < 60; i++) seedNote(db, { note_id: `k${i}`, agent_id: "cypher", content: `kept ${i}`, created_at: daysAgo(40 + i) });
    for (let i = 0; i < 40; i++) seedNote(db, { note_id: `d${i}`, agent_id: "cypher", content: `DRAFT ${i}`, created_at: daysAgo(200 + i), review_state: "draft" });
    const env = envFor(DB);
    const eligible = await getEligibleNotesForCompression(env, "cypher");
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every(n => n.note_id.startsWith("k"))).toBe(true);

    await archiveNotes(env, "cypher", [...eligible, { note_id: "d0", content: "DRAFT 0", created_at: daysAgo(200) }], "summary");
    const d0 = db.prepare("SELECT archived FROM wm_continuity_notes WHERE note_id = 'd0'").get() as { archived: number };
    expect(d0.archived).toBe(0);
  });

  it("salience prune never archives a cold draft (it would vanish from the tray without a decision)", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "cold-kept", agent: "drevan", source: "autonomous", created_at: daysAgo(60), review_state: "kept" });
    seedJournal(db, { id: "cold-draft", agent: "drevan", source: "autonomous", created_at: daysAgo(60), review_state: "draft" });
    db.prepare("UPDATE companion_journal SET heat = 0, last_access_at = NULL").run();
    const r = await runSaliencePrune(envFor(DB), { force: true });
    expect(r.archived).toBe(1);
    const state = (id: string) => (db.prepare("SELECT archived FROM companion_journal WHERE id = ?").get(id) as { archived: number }).archived;
    expect(state("cold-kept")).toBe(1);
    expect(state("cold-draft")).toBe(0);
  });
});

describe("recall by id", () => {
  it("recallNotes returns and warms kept + live notes only; knowing a draft's id is not recall", async () => {
    const { db, DB } = makeSqliteD1();
    seedNote(db, { note_id: "n-kept", agent_id: "cypher", content: "kept", heat: 1 });
    seedNote(db, { note_id: "n-draft", agent_id: "cypher", content: "[discord:pulse] draft", review_state: "draft", heat: 1 });
    seedNote(db, { note_id: "n-arch", agent_id: "cypher", content: "archived", archived: 1, heat: 1 });
    const got = await recallNotes(envFor(DB), "cypher", ["n-kept", "n-draft", "n-arch"]);
    expect(got.map(n => n.note_id)).toEqual(["n-kept"]);
    const lastAccess = (id: string) => (db.prepare("SELECT last_access_at FROM wm_continuity_notes WHERE note_id = ?").get(id) as { last_access_at: string | null }).last_access_at;
    expect(lastAccess("n-kept")).not.toBeNull();
    expect(lastAccess("n-draft")).toBeNull();
  });
});
