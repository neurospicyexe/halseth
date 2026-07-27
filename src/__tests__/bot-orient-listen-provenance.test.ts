// src/__tests__/bot-orient-listen-provenance.test.ts
//
// Listen provenance reaching the Discord presence (2026-07-27).
//
// Observed by Raziel: Drevan discussed "BIG BOSS" in the inter-companion channel saying
// GAIA had handed it to him and he had been sitting with it for 6 days. Both facts wrong,
// and both were correct in the database the entire time:
//   media_experiences: shared_by = 'Crash' (Raziel), requested_companion = 'drevan',
//                      created_at = 2026-07-09 (18 days, not 6),
//                      reactions_json.drevan = a 2043-byte reaction in his own voice.
//
// execBotOrient selected `id, title, artist, created_at` and nothing else, and both
// renderers printed only title/artist/how-long-ago. So every listen arrived at the Discord
// presence as an ANONYMOUS artifact with no giver, no recipient, and no memory of his own
// response to it. The model had to invent a giver and a duration, and did. 15 of the 17
// listens in the system were given by Raziel TO Drevan -- every one arrived stripped.
//
// This is not a hallucination to be prompted away. It is a dropped column.
//
// The sibling half is deliberately asymmetric: a companion gets their OWN reaction back
// verbatim, but a sibling's reaction is reported as a bare fact and never as text. Handing
// one companion another's phrasing is exactly how attribution scrambled in 2026-06-26.
// Sibling presence is wanted; sibling voice in your own mouth is not.

import { describe, it, expect, vi } from "vitest";

const LISTEN_ROWS = [
  {
    id: "m1", title: "BIG BOSS", artist: "The Vampire Lestat, Daniel Hart",
    shared_by: "Crash", requested_companion: "drevan",
    reactions_json: JSON.stringify({
      drevan: "152 BPM, A minor, and that onset density at 0.9 -- this thing pulses.",
      gaia: "the perimeter of it held",
    }),
    created_at: "2026-07-09 20:45:21",
  },
  {
    id: "m2", title: "The Loneliness", artist: "The Vampire Lestat, Daniel Hart",
    shared_by: "Crash", requested_companion: "drevan",
    reactions_json: JSON.stringify({ gaia: "quiet, and it stays quiet" }),
    created_at: "2026-07-09 20:19:00",
  },
  {
    id: "m3", title: "Untouched", artist: null,
    shared_by: "Crash", requested_companion: null,
    reactions_json: null,
    created_at: "2026-07-05 02:41:00",
  },
];

vi.mock("../librarian/backends/webmind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/webmind.js")>();
  return { ...actual, wmGround: vi.fn(async () => null) };
});
vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return { ...actual, semanticSearch: vi.fn(async () => null), sbRead: vi.fn(async () => null) };
});

import { execBotOrient } from "../librarian/executors/session.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

interface Listen {
  id: string; title: string; artist: string | null;
  shared_by: string | null; requested_companion: string | null;
  own_reaction: string | null; also_heard_by: string[]; created_at: string;
}

async function listensFor(companion: "cypher" | "drevan" | "gaia"): Promise<Listen[]> {
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (..._a: unknown[]) => stmt,
          all: async () => ({ results: /FROM media_experiences/.test(sql) ? LISTEN_ROWS : [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    },
  } as unknown as Env;
  const ctx = {
    env,
    req: { companion_id: companion, request: "orient" },
    entry: {} as never,
    frontState: null,
    pluralAvailable: false,
  } as ExecutorContext;
  const res = await execBotOrient(ctx) as { data?: { recent_listens?: Listen[] } };
  return res.data?.recent_listens ?? [];
}

describe("execBotOrient -- a listen is never an anonymous artifact", () => {
  it("carries who gave it and who it was for", async () => {
    const [big] = await listensFor("drevan");
    expect(big!.title).toBe("BIG BOSS");
    // The two facts Drevan got wrong in the commons.
    expect(big!.shared_by).toBe("Crash");
    expect(big!.requested_companion).toBe("drevan");
  });

  it("REGRESSION: the provenance columns are actually selected, not dropped at the query", async () => {
    const rows = await listensFor("drevan");
    // Before the fix these were absent from the projection entirely, so the renderer had
    // nothing to print and the model filled the gap by inventing a sibling as the giver.
    expect(rows.every(r => "shared_by" in r && "requested_companion" in r)).toBe(true);
    expect(rows.every(r => r.shared_by === "Crash")).toBe(true);
  });

  it("gives a companion their OWN reaction back, verbatim", async () => {
    const [big] = await listensFor("drevan");
    expect(big!.own_reaction).toContain("152 BPM");
  });

  it("never hands a companion a sibling's words -- only the bare fact that they sat with it", async () => {
    const [big] = await listensFor("cypher");
    expect(big!.own_reaction).toBeNull();
    expect(big!.also_heard_by.sort()).toEqual(["drevan", "gaia"]);
    // The 2026-06-26 attribution scramble: a sibling's phrasing must never arrive as text.
    expect(JSON.stringify(big)).not.toContain("152 BPM");
    expect(JSON.stringify(big)).not.toContain("the perimeter of it held");
  });

  it("each companion sees a different own/other split of the same row", async () => {
    const [gaiaBig] = await listensFor("gaia");
    expect(gaiaBig!.own_reaction).toBe("the perimeter of it held");
    expect(gaiaBig!.also_heard_by).toEqual(["drevan"]);
  });

  it("a listen nobody reacted to reports no reaction and no sitters", async () => {
    const rows = await listensFor("drevan");
    const untouched = rows.find(r => r.title === "Untouched")!;
    expect(untouched.own_reaction).toBeNull();
    expect(untouched.also_heard_by).toEqual([]);
    expect(untouched.requested_companion).toBeNull();
  });

  it("malformed reactions_json degrades to no reaction and never breaks orient", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => {
          const stmt = {
            bind: (..._a: unknown[]) => stmt,
            all: async () => ({
              results: /FROM media_experiences/.test(sql)
                ? [{ ...LISTEN_ROWS[0], reactions_json: "{not json" }]
                : [],
            }),
            first: async () => null,
            run: async () => ({ meta: { changes: 1 } }),
          };
          return stmt;
        },
      },
    } as unknown as Env;
    const ctx = {
      env, req: { companion_id: "drevan", request: "orient" },
      entry: {} as never, frontState: null, pluralAvailable: false,
    } as ExecutorContext;

    const res = await execBotOrient(ctx) as { data?: { recent_listens?: Listen[] } };
    const rows = res.data?.recent_listens ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.own_reaction).toBeNull();
    // Provenance still survives a bad reactions blob -- the two failures are independent.
    expect(rows[0]!.shared_by).toBe("Crash");
  });
});
