// src/__tests__/nl-note-provenance.test.ts  (2026-09-26)
//
// The Librarian NL "add companion note" path and the imp tray (mig 0132).
//
// Gap closed: the bots' memory-judge FALLBACK (no Discord message id, so no keyed REST write) came
// through this path with source NULL -- indistinguishable from a companion's own deliberate note --
// so it was born `kept` and reached recall unreviewed. The bot now sends `source: memory_judge` in
// the JSON context, and the executor forwards it to companionJournalAdd, where reviewStateFor()
// (the one birth rule) drafts it.
//
// The other half: the context `source` used to be forwarded verbatim, so a caller could claim
// `claude_code` (HUMAN_SOURCES, recall weight 1.0, prune-immune). Only machine classes may be
// claimed now; anything else is dropped to NULL and the write still lands.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../db/queries.js")>()),
  generateId: () => "generated-id",
}));
vi.mock("../synthesis/tag-classifier.js", () => ({
  classifyDomainTags: () => ["work"],
  classifyKeywordTags: () => ["bridge"],
}));

import { execCompanionNoteAdd, claimableNlSource, NL_CLAIMABLE_SOURCES } from "../librarian/executors/writes.js";
import { matchFastPath } from "../librarian/router.js";
import { MACHINE_SOURCES, HUMAN_SOURCES } from "../webmind/notes.js";
import { COMPANION_SPEECH_JOURNAL_SOURCES } from "../webmind/review-state.js";

interface Captured { sql: string; bound: unknown[] }

function makeEnv(): { env: any; calls: Captured[] } {
  const calls: Captured[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: (...bound: unknown[]) => { calls.push({ sql, bound }); return stmt; },
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
    },
    // noveltyCheck (machine sources) resolves to "no near match" -> insert proceeds.
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    VECTORIZE: { query: vi.fn(async () => ({ matches: [] })), upsert: vi.fn(async () => undefined) },
  };
  return { env, calls };
}

// companionJournalAdd binds: id, created_at, agent, note_text, tags, session_id, source, topic_tags, review_state
const SOURCE = 6;
const REVIEW_STATE = 8;

function journalInsert(calls: Captured[]): Captured {
  const c = calls.find((x) => /INSERT INTO companion_journal/i.test(x.sql));
  if (!c) throw new Error(`no companion_journal insert; saw: ${calls.map((x) => x.sql.slice(0, 40)).join(" | ")}`);
  return c;
}

const run = (env: any, context: string | undefined, request = "add companion note") =>
  execCompanionNoteAdd({ env, req: { companion_id: "drevan", request, ...(context !== undefined ? { context } : {}) } } as never);

beforeEach(() => vi.clearAllMocks());

describe("route table: the bots' NL fallback request reaches execCompanionNoteAdd", () => {
  it("'add companion note' fast-paths to companion_note_add", () => {
    expect(matchFastPath("add companion note")?.key).toBe("companion_note_add");
  });
});

describe("memory-judge fallback via NL is born draft", () => {
  it("source memory_judge in JSON context -> stored, review_state draft", async () => {
    const { env, calls } = makeEnv();
    const res = await run(env, JSON.stringify({
      content: "Raziel said the truck is home.", tags: ["discord", "memory-judge"], source: "memory_judge",
    }));
    expect((res as Record<string, unknown>).ack).toBe(true);
    const ins = journalInsert(calls);
    expect(ins.bound[3]).toBe("Raziel said the truck is home.");
    expect(ins.bound[SOURCE]).toBe("memory_judge");
    expect(ins.bound[REVIEW_STATE]).toBe("draft");
  });
});

describe("a companion's own deliberate NL write still lands kept", () => {
  it("raw text context -> source NULL, kept", async () => {
    const { env, calls } = makeEnv();
    await run(env, "I noticed the grove felt quieter tonight.");
    const ins = journalInsert(calls);
    expect(ins.bound[SOURCE]).toBe(null);
    expect(ins.bound[REVIEW_STATE]).toBe("kept");
  });

  it("no context at all (note in the request) -> kept", async () => {
    const { env, calls } = makeEnv();
    await run(env, undefined, "Write a companion note: the vow held.");
    const ins = journalInsert(calls);
    expect(ins.bound[3]).toBe("the vow held.");
    expect(ins.bound[REVIEW_STATE]).toBe("kept");
  });

  it("JSON context with no source -> kept", async () => {
    const { env, calls } = makeEnv();
    await run(env, JSON.stringify({ content: "a chosen memory", tags: ["held"] }));
    const ins = journalInsert(calls);
    expect(ins.bound[SOURCE]).toBe(null);
    expect(ins.bound[REVIEW_STATE]).toBe("kept");
  });
});

describe("source allowlist: a caller cannot claim a human source", () => {
  for (const claimed of ["claude_code", "session", "conversation_capture", "raziel", "whatever"]) {
    it(`claimed '${claimed}' is dropped to NULL; the write still lands kept`, async () => {
      const { env, calls } = makeEnv();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await run(env, JSON.stringify({ content: "spoof attempt", source: claimed }));
      expect((res as Record<string, unknown>).ack).toBe(true);
      const ins = journalInsert(calls);
      expect(ins.bound[SOURCE]).toBe(null);
      expect(ins.bound[REVIEW_STATE]).toBe("kept");
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  }

  it("metronome (the other live NL machine writer) is preserved", async () => {
    const { env, calls } = makeEnv();
    await run(env, JSON.stringify({ content: "[metronome] fragment", tags: ["metronome"], source: "metronome" }));
    expect(journalInsert(calls).bound[SOURCE]).toBe("metronome");
  });

  it("the allowlist is exactly MACHINE_SOURCES + the tray's speech sources, and shares nothing with HUMAN_SOURCES", () => {
    expect(NL_CLAIMABLE_SOURCES).toEqual(new Set([...MACHINE_SOURCES, ...COMPANION_SPEECH_JOURNAL_SOURCES]));
    for (const h of HUMAN_SOURCES) expect(NL_CLAIMABLE_SOURCES.has(h)).toBe(false);
  });

  it("claimableNlSource: non-string is dropped; absent is silent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(claimableNlSource(42)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(claimableNlSource(undefined)).toBeUndefined();
    expect(claimableNlSource(null)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("addressed / broadcast notes are unaffected by source", () => {
  it("a note for a peer still goes to inter_companion_notes", async () => {
    const { env, calls } = makeEnv();
    const res = await run(env, JSON.stringify({ content: "hold the thread", source: "memory_judge" }), "add companion note for gaia");
    expect((res as Record<string, unknown>).delivered_to).toBe("gaia");
    expect(calls.some((c) => /INSERT INTO inter_companion_notes/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO companion_journal/i.test(c.sql))).toBe(false);
  });
});
