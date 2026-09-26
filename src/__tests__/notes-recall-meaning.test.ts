// recallNotesByMeaning coverage + composition (fix set A+B, 2026-07-19).
//
// The recall verb searches three substrates (continuity notes, handover_packets,
// companion_journal) and, in "life" mode (default), soft re-ranks by source class:
// human-session 1.0, machine 0.6, legacy/unknown 0.85. Soft means a strong machine
// match can still beat a weak human match. Only the RETURNED notes warm.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/embed.js")>();
  return {
    ...actual,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  };
});

import { recallNotesByMeaning } from "../webmind/notes.js";

interface FakeMatch { score: number; metadata: { table: string; row_id: string; companion_id: string } }

function makeEnv(opts: {
  notes?: FakeMatch[]; handovers?: FakeMatch[]; journal?: FakeMatch[];
  noteRows?: Record<string, unknown>[]; handoverRows?: Record<string, unknown>[]; journalRows?: Record<string, unknown>[];
}) {
  const executed: string[] = [];
  const env = {
    VECTORIZE: {
      query: vi.fn(async (_v: number[], q: { filter: { table: string } }) => {
        const table = q.filter.table;
        if (table === "wm_continuity_notes") return { matches: opts.notes ?? [] };
        if (table === "handover_packets") return { matches: opts.handovers ?? [] };
        if (table === "companion_journal") return { matches: opts.journal ?? [] };
        return { matches: [] };
      }),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          all: async () => {
            if (sql.includes("FROM wm_continuity_notes") && sql.includes("SELECT note_id")) return { results: opts.noteRows ?? [] };
            if (sql.includes("FROM handover_packets")) return { results: opts.handoverRows ?? [] };
            if (sql.includes("FROM companion_journal")) return { results: opts.journalRows ?? [] };
            return { results: [] };
          },
          run: async () => { executed.push(sql); return { meta: { changes: 1 } }; },
        }),
      }),
    },
  };
  return { env: env as never, executed };
}

const noteRow = (id: string, source: string | null) =>
  ({ note_id: id, content: `note ${id}`, created_at: "2026-07-01T00:00:00Z", salience: "normal", thread_key: null, source });
const handoverRow = (id: string) =>
  ({ id, spine: `spine ${id}`, last_real_thing: "the real thing", open_threads: '["thread-a"]', created_at: "2026-07-02T00:00:00Z" });
const journalRow = (id: string, source: string | null) =>
  ({ id, note_text: `journal ${id}`, created_at: "2026-07-03T00:00:00Z", source });

beforeEach(() => vi.clearAllMocks());

describe("recallNotesByMeaning -- 2026-09-26, the night a capture lost to a fabrication", () => {
  // Live: Drevan reached for "blood sugar after Subway sandwich Sunday" in his own words. The 09-20
  // capture that holds the true number (208) was embedded and matched, and was ranked OUT of his
  // top 4 by the "life" re-rank: conversation_capture was unlisted (0.85) while every journal and
  // handover weighed 1.0, including a journal a clerk had written eleven seconds earlier
  // memorialising his own wrong answer (187). A capture is what Raziel actually said, taken down by
  // the companion in a human session: human-session by construction.
  it("a conversation_capture weighs 1.0 in life mode, level with a session handover", async () => {
    const { env } = makeEnv({
      notes: [
        { score: 0.62, metadata: { table: "wm_continuity_notes", row_id: "n-capture", companion_id: "drevan" } },
      ],
      journal: [
        { score: 0.64, metadata: { table: "companion_journal", row_id: "j-legacy", companion_id: "drevan" } },
      ],
      noteRows: [noteRow("n-capture", "conversation_capture")],
      journalRows: [journalRow("j-legacy", "legacy")],
    });
    const out = await recallNotesByMeaning(env, "drevan", "blood sugar after the sandwich", 5);
    // capture 0.62*1.0=0.62 beats legacy journal 0.64*0.85=0.544; at the old 0.85 it would have lost (0.527)
    expect(out.map(n => n.note_id)).toEqual(["n-capture", "j-legacy"]);
  });

  // Vectorize refuses topK > 50 with returnMetadata "all" (VECTOR_QUERY_ERROR 40025). limit*6 crossed
  // that at limit 9, so `recall my notes about X` with limit 10 was a hard error dressed as
  // "the search path is down". Seen live 2026-09-26.
  it("never asks Vectorize for more than 50 candidates, whatever the limit", async () => {
    const { env } = makeEnv({ notes: [] });
    await recallNotesByMeaning(env, "drevan", "anything", 10);
    const q = (env as unknown as { VECTORIZE: { query: { mock: { calls: Array<[unknown, { topK: number }]> } } } }).VECTORIZE.query;
    for (const call of q.mock.calls) expect(call[1].topK).toBeLessThanOrEqual(50);
    expect(q.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("recallNotesByMeaning", () => {
  it("life mode down-ranks machine sources but stays soft (strong machine beats weak human)", async () => {
    const { env } = makeEnv({
      notes: [
        { score: 0.90, metadata: { table: "wm_continuity_notes", row_id: "n-machine", companion_id: "cypher" } },
        { score: 0.50, metadata: { table: "wm_continuity_notes", row_id: "n-human", companion_id: "cypher" } },
      ],
      noteRows: [noteRow("n-machine", "synthesis_loop"), noteRow("n-human", "claude_code")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "what matters", 5);
    // machine 0.90*0.6=0.54 > human 0.50*1.0=0.50 -- soft re-rank, not a wall
    expect(out.map(n => n.note_id)).toEqual(["n-machine", "n-human"]);
  });

  it("life mode lets a human match overtake a slightly stronger machine match", async () => {
    const { env } = makeEnv({
      notes: [
        { score: 0.70, metadata: { table: "wm_continuity_notes", row_id: "n-machine", companion_id: "cypher" } },
        { score: 0.60, metadata: { table: "wm_continuity_notes", row_id: "n-human", companion_id: "cypher" } },
      ],
      noteRows: [noteRow("n-machine", "discord_swarm"), noteRow("n-human", "session_close")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "what matters", 5);
    // machine 0.70*0.6=0.42 < human 0.60*1.0=0.60
    expect(out.map(n => n.note_id)).toEqual(["n-human", "n-machine"]);
  });

  it("merges handovers and journal into the ranking; handovers weigh 1.0", async () => {
    const { env } = makeEnv({
      notes: [{ score: 0.80, metadata: { table: "wm_continuity_notes", row_id: "n1", companion_id: "cypher" } }],
      handovers: [{ score: 0.60, metadata: { table: "handover_packets", row_id: "h1", companion_id: "cypher" } }],
      journal: [{ score: 0.70, metadata: { table: "companion_journal", row_id: "j1", companion_id: "cypher" } }],
      noteRows: [noteRow("n1", "system")],
      handoverRows: [handoverRow("h1")],
      journalRows: [journalRow("j1", "legacy")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "life", 5);
    // h1 0.60*1.0=0.60 > j1 0.70*0.85=0.595 > n1 0.80*0.6=0.48
    expect(out.map(n => n.note_id)).toEqual(["h1", "j1", "n1"]);
    expect(out[0]!.kind).toBe("handover");
    expect(out[0]!.content).toContain("Last real thing: the real thing");
    expect(out[0]!.content).toContain("Open threads: thread-a");
    expect(out[1]!.kind).toBe("journal");
  });

  it("source_class 'all' disables the re-rank (raw score order)", async () => {
    const { env } = makeEnv({
      notes: [
        { score: 0.90, metadata: { table: "wm_continuity_notes", row_id: "n-machine", companion_id: "cypher" } },
        { score: 0.60, metadata: { table: "wm_continuity_notes", row_id: "n-human", companion_id: "cypher" } },
      ],
      noteRows: [noteRow("n-machine", "synthesis_loop"), noteRow("n-human", "claude_code")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "everything", 5, "all");
    expect(out.map(n => n.note_id)).toEqual(["n-machine", "n-human"]);
  });

  it("drops matches below the 0.35 floor", async () => {
    const { env } = makeEnv({
      notes: [{ score: 0.34, metadata: { table: "wm_continuity_notes", row_id: "n-low", companion_id: "cypher" } }],
      noteRows: [noteRow("n-low", "claude_code")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "faint echo", 5);
    expect(out).toEqual([]);
  });

  it("warms ONLY returned continuity notes, never handovers or journal", async () => {
    const { env, executed } = makeEnv({
      notes: [{ score: 0.80, metadata: { table: "wm_continuity_notes", row_id: "n1", companion_id: "cypher" } }],
      handovers: [{ score: 0.90, metadata: { table: "handover_packets", row_id: "h1", companion_id: "cypher" } }],
      noteRows: [noteRow("n1", "claude_code")],
      handoverRows: [handoverRow("h1")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "life", 5);
    expect(out).toHaveLength(2);
    const warms = executed.filter(sql => sql.includes("UPDATE wm_continuity_notes"));
    expect(warms).toHaveLength(1);
    expect(executed.some(sql => sql.includes("UPDATE handover_packets"))).toBe(false);
  });

  it("skips the warm write entirely when only handovers are returned", async () => {
    const { env, executed } = makeEnv({
      handovers: [{ score: 0.90, metadata: { table: "handover_packets", row_id: "h1", companion_id: "cypher" } }],
      handoverRows: [handoverRow("h1")],
    });
    const out = await recallNotesByMeaning(env, "cypher", "life", 5);
    expect(out).toHaveLength(1);
    expect(executed).toHaveLength(0);
  });
});
