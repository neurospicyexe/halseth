// Earned-salience gap (found 2026-07-26 by the organ census, prod-measured).
//
// Mig 0105's contract, in its own header: "Salience rises when a row is recalled/
// surfaced (warmSql), decays otherwise." halseth/CLAUDE.md states it as
// "recall/orient warm what they surface."
//
// mindOrient honours that for two of the three stores it surfaces:
//   wm_continuity_notes  -> warmed (orient.ts, 3-pool block)
//   companion_conclusions -> warmed (orient.ts, type-distributed block)
//   companion_journal     -> surfaced every orient (substantive lane, LIMIT 3) and NEVER warmed
//
// Prod consequence: 4,630 journal rows, exactly ONE with last_access_at set (and that
// one came from the recall path, not orient), against 6 warmed conclusions. Journal
// heat is therefore inert on the orient path -- never written, so the effective-heat
// decay it feeds can only ever fall. The salience prune reads that same heat.
//
// Note the lane split stays intact: orient's journal slots are a RECENCY lane by
// design (webmind/journal-lanes.ts, 2026-07-09) so this fixes the WRITE half only.
// Ordering stays created_at DESC; chatter still never wins a slot.

import { describe, it, expect, vi } from "vitest";

vi.mock("../webmind/relational.js", () => ({
  readRelationalSnapshot: vi.fn(async () => null),
}));
vi.mock("../webmind/limbic.js", () => ({
  getCurrentLimbicState: vi.fn(async () => null),
  writeLimbicState: vi.fn(async () => undefined),
}));
vi.mock("../webmind/spiral.js", () => ({
  readRecentSpiralTurn: vi.fn(async () => null),
}));
vi.mock("../webmind/home/store.js", () => ({
  takeUnsurfacedEvents: vi.fn(async () => []),
}));

import { mindOrient } from "../webmind/orient.js";

type Run = { sql: string; args: unknown[] };

const journalRows = [
  { id: "j1", agent: "cypher", note_text: "authored reflection one", tags: null, session_id: null, created_at: "2026-07-26T10:00:00Z" },
  { id: "j2", agent: "cypher", note_text: "authored reflection two", tags: null, session_id: null, created_at: "2026-07-25T10:00:00Z" },
];

function makeOrientEnv(opts: { journal?: unknown[] } = {}) {
  const runs: Run[] = [];
  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes("FROM companion_journal")) return opts.journal ?? journalRows;
    if (sql.includes("FROM wm_identity_anchor_snapshot")) return [{ agent_id: "cypher", anchor_text: "x" }];
    return [];
  };
  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare: (sql: string) => {
        const mk = (args: unknown[]) => ({
          bind: (...a: unknown[]) => mk(a),
          all: async () => ({ results: rowsFor(sql) }),
          first: async () => rowsFor(sql)[0] ?? null,
          run: async () => { runs.push({ sql, args }); return { meta: { changes: 1 } }; },
        });
        return mk([]);
      },
    },
  };
  return { env: env as never, runs };
}

const journalWarms = (runs: Run[]) =>
  runs.filter(r => /UPDATE companion_journal/i.test(r.sql) && /last_access_at/i.test(r.sql));

describe("mindOrient warms the journal rows it surfaces (mig 0105 write half)", () => {
  it("issues a warm UPDATE binding every surfaced substantive journal id", async () => {
    const { env, runs } = makeOrientEnv();
    await mindOrient(env, "cypher");

    const warms = journalWarms(runs);
    expect(warms).toHaveLength(1);
    expect(warms[0]!.sql).toContain("SET heat = MIN(");
    expect(warms[0]!.sql).toContain("last_access_at = datetime('now')");
    expect(warms[0]!.args).toEqual(["j1", "j2"]);
  });

  it("does not warm when the substantive lane returns nothing", async () => {
    const { env, runs } = makeOrientEnv({ journal: [] });
    await mindOrient(env, "cypher");
    expect(journalWarms(runs)).toHaveLength(0);
  });

  it("skips the warm under readOnly -- the MindState loader's pure-read covenant", async () => {
    const { env, runs } = makeOrientEnv();
    await mindOrient(env, "cypher", { readOnly: true });
    expect(journalWarms(runs)).toHaveLength(0);
  });
});
