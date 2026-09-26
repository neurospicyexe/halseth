// The read half of the imp tray (mig 0132, 2026-09-26): every query that puts a companion's own
// journal rows or continuity notes into a PROMPT -- recall, orient, ground, "read my journal",
// "read my continuity notes", "recall", the director's sibling supply, the cross-companion feed, the
// orphan detector, the puller feed -- carries `review_state = 'kept'`. A draft has a vector and a
// row like any other; these predicates are the only thing standing between a clerk's note and the
// companion's voice.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/embed.js")>();
  return { ...actual, embedText: vi.fn(async () => [0.1, 0.2, 0.3]), embedAndStoreAsync: vi.fn(async () => undefined) };
});
vi.mock("../webmind/relational.js", () => ({ readRelationalSnapshot: vi.fn(async () => null) }));
vi.mock("../webmind/limbic.js", () => ({ getCurrentLimbicState: vi.fn(async () => null), writeLimbicState: vi.fn(async () => undefined) }));
vi.mock("../webmind/spiral.js", () => ({ readRecentSpiralTurn: vi.fn(async () => null) }));
vi.mock("../webmind/home/store.js", () => ({ takeUnsurfacedEvents: vi.fn(async () => []) }));
vi.mock("../webmind/sits.js", () => ({ readSittingNotes: vi.fn(async () => []) }));
vi.mock("../mind/note-provenance.js", () => ({ resolveNoteProvenance: vi.fn(async () => new Map()), attributionNote: vi.fn(() => null) }));

import { recallNotesByMeaning, readRecentNotes } from "../webmind/notes.js";
import { mindOrient } from "../webmind/orient.js";
import { mindGround } from "../webmind/ground.js";
import { execJournalRead } from "../librarian/executors/reads.js";
import { execContinuityNotesRead } from "../librarian/executors/webmind.js";
import { execRecentRecall } from "../librarian/executors/companion-growth.js";
import { SUPPLY_SOURCES } from "../director/supply-query.js";
import { detectOrphanedMemories } from "../guardian/detectors.js";
import { getCompanionJournal } from "../handlers/history.js";

const KEPT = "review_state = 'kept'";

/** Capture every prepared SQL; answer everything empty. */
function makeEnv(vectorMatches: Array<{ table: string; row_id: string }> = []) {
  const sqls: string[] = [];
  const rowsFor = (sql: string): unknown[] =>
    sql.includes("FROM wm_identity_anchor_snapshot") ? [{ agent_id: "cypher", anchor_text: "x" }] : [];
  const mk = (sql: string) => ({
    bind: (..._a: unknown[]) => mk(sql),
    all: async () => ({ results: rowsFor(sql) }),
    first: async () => rowsFor(sql)[0] ?? null,
    run: async () => ({ meta: { changes: 0 } }),
  });
  const env = {
    SYSTEM_OWNER: "raziel",
    ADMIN_SECRET: "t",
    DB: { prepare: (sql: string) => { sqls.push(sql); return mk(sql); } },
    VECTORIZE: {
      query: vi.fn(async (_v: number[], q: { filter: { table: string } }) => ({
        matches: vectorMatches.filter(m => m.table === q.filter.table).map(m => ({ score: 0.9, metadata: { table: m.table, row_id: m.row_id, companion_id: "cypher" } })),
      })),
    },
  };
  return { env: env as never, sqls };
}

const journalSelects = (sqls: string[]) => sqls.filter(s => /SELECT[\s\S]*FROM companion_journal/i.test(s));
const noteSelects = (sqls: string[]) => sqls.filter(s => /SELECT[\s\S]*FROM wm_continuity_notes/i.test(s));

describe("recall by meaning", () => {
  it("hydrates notes AND journal candidates with review_state = 'kept' (a draft's vector is not a memory)", async () => {
    const { env, sqls } = makeEnv([{ table: "wm_continuity_notes", row_id: "n1" }, { table: "companion_journal", row_id: "j1" }]);
    await recallNotesByMeaning(env, "cypher", "blood sugar");
    const hydrations = sqls.filter(s => s.includes("IN ("));
    expect(hydrations.filter(s => s.includes("FROM wm_continuity_notes"))).toHaveLength(1);
    expect(hydrations.filter(s => s.includes("FROM companion_journal"))).toHaveLength(1);
    for (const s of hydrations) {
      expect(s).toContain("archived = 0");
      expect(s).toContain(KEPT);
    }
  });
});

describe("boot surfaces", () => {
  it("mindOrient: the three high-salience pools and the journal recency slots are kept-only", async () => {
    const { env, sqls } = makeEnv();
    await mindOrient(env, "cypher" as never);
    const pools = noteSelects(sqls).filter(s => s.includes("salience = 'high'") && s.includes("NOT IN ('soma_arc', 'spiral_turn')"));
    expect(pools).toHaveLength(3);
    for (const s of pools) expect(s).toContain(KEPT);
    const journal = journalSelects(sqls).filter(s => s.includes("LIMIT 3"));
    expect(journal.length).toBeGreaterThanOrEqual(1);
    for (const s of journal) expect(s).toContain(KEPT);
  });

  it("mindGround: recent notes are kept-only", async () => {
    const { env, sqls } = makeEnv();
    await mindGround(env, "cypher" as never);
    const notes = noteSelects(sqls);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(KEPT);
  });

  it("readRecentNotes (halseth_session_load's recent_notes) is kept-only", async () => {
    const { env, sqls } = makeEnv();
    await readRecentNotes(env, { agent_id: "cypher" });
    expect(noteSelects(sqls)[0]).toContain(KEPT);
  });
});

describe("Librarian self-reads", () => {
  const ctx = (env: unknown, request: string): any => ({ env, req: { companion_id: "cypher", request }, entry: {}, frontState: null, pluralAvailable: false });

  it("'read my journal' is kept-only on companion_journal", async () => {
    const { env, sqls } = makeEnv();
    await execJournalRead(ctx(env, "read my journal"));
    expect(journalSelects(sqls)).toHaveLength(1);
    expect(journalSelects(sqls)[0]).toContain(KEPT);
  });

  it("'read my continuity notes' is kept-only", async () => {
    const { env, sqls } = makeEnv();
    await execContinuityNotesRead(ctx(env, "read my continuity notes"));
    expect(noteSelects(sqls)[0]).toContain(KEPT);
  });

  it("'recall' (recent writes) is kept-only on both stores", async () => {
    const { env, sqls } = makeEnv();
    await execRecentRecall(ctx(env, "recall"));
    expect(journalSelects(sqls)[0]).toContain(KEPT);
    expect(noteSelects(sqls)[0]).toContain(KEPT);
  });
});

describe("other prompt feeds", () => {
  it("director sibling_note supply is kept-only", () => {
    const src = SUPPLY_SOURCES.find(s => s.kind === "sibling_note")!;
    expect(src.sql).toContain(KEPT);
  });

  it("orphan-memory detector never flags a draft (it was never eligible to be recalled)", async () => {
    const { env, sqls } = makeEnv();
    await detectOrphanedMemories(env);
    expect(noteSelects(sqls)[0]).toContain(KEPT);
  });

  it("GET /companion-journal (the Second Brain puller's feed) is kept by default; review_state=all|draft opens the tray", async () => {
    const a = makeEnv();
    await getCompanionJournal(new Request("https://x/companion-journal?agent=drevan", { headers: { Authorization: "Bearer t" } }), a.env);
    expect(journalSelects(a.sqls)[0]).toContain(KEPT);
    const b = makeEnv();
    await getCompanionJournal(new Request("https://x/companion-journal?agent=drevan&review_state=all", { headers: { Authorization: "Bearer t" } }), b.env);
    expect((journalSelects(b.sqls)[0] ?? "").split("WHERE")[1] ?? "").not.toContain("review_state");
    const c = makeEnv();
    await getCompanionJournal(new Request("https://x/companion-journal?agent=drevan&review_state=draft", { headers: { Authorization: "Bearer t" } }), c.env);
    expect(journalSelects(c.sqls)[0]).toContain("review_state = ?");
  });
});
