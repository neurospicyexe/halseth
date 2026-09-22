// Attribution for authored float moves (graph memory Phase 2, 2026-09-21).
//
// The defect these tests pin: in the week after `felt.soma_provenance` shipped there were exactly
// two real authored float moves in prod, and BOTH carried session_id NULL --
//   2026-09-15T08:44:14Z fired 31s AFTER its own session closed (08:43:43Z), and
//   2026-09-21T12:58:49Z fired 85s BEFORE the next session opened (13:00:14Z).
// The close ritual moves floats ADJACENT to the session window, not inside it, so orient could only
// ever render "you set it <day>" and never "during <type> session", and the graph's session lane
// stayed empty. Two fixes, tested here:
//   (1) a grace window at write time -- a session that closed moments ago is still the mover;
//   (2) the close payload accepts the companions' own axis words, so floats can ride the close and
//       be attributed by CONSTRUCTION (sessionClose writes authored_close with the session id).
// The 85s-before shape is not reachable by (1) -- no query sees a row that does not exist yet --
// which is exactly why (2) is the real fix and the skill now teaches it.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { findSessionForMoment, ATTRIBUTION_GRACE_MS } from "../db/queries.js";
import { translateSomaVocab, SOMA_AXIS_KEYS } from "../soma/vocab.js";
import { normalizeStateValue, sessionClose } from "../librarian/backends/halseth.js";

// ── A real SQLite behind the D1 shape ────────────────────────────────────────
//
// findSessionForMoment's whole content is a SQL distance expression and an ORDER BY; a mocked
// `first()` would assert the shape of a string and prove nothing about which session wins. Node's
// built-in sqlite runs the actual query, and julianday() parses both stamp shapes this table holds
// (ISO-with-Z from live writes, space-form from backfills) -- verified in the first test below.
function makeSqliteEnv(): { env: any; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, companion_id TEXT, surface TEXT, session_type TEXT,
      created_at TEXT, handover_id TEXT
    );
    CREATE TABLE handover_packets (id TEXT PRIMARY KEY, created_at TEXT);
  `);
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => db.prepare(sql).get(...(binds as any[])) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }),
          run: async () => db.prepare(sql).run(...(binds as any[])),
        }),
      }),
    },
  };
  return { env, db };
}

function addSession(db: DatabaseSync, s: {
  id: string; companion?: string; surface?: string | null; type?: string;
  opened: string; closed?: string;
}) {
  const handoverId = s.closed ? `h-${s.id}` : null;
  if (s.closed) db.prepare("INSERT INTO handover_packets (id, created_at) VALUES (?, ?)").run(handoverId, s.closed);
  db.prepare(
    "INSERT INTO sessions (id, companion_id, surface, session_type, created_at, handover_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(s.id, s.companion ?? "cypher", s.surface ?? "claude-ai:cypher", s.type ?? "companion", s.opened, handoverId);
}

describe("findSessionForMoment -- the attribution grace window", () => {
  it("attributes the 09-15 shape: a float moved 31 seconds AFTER its session closed", async () => {
    const { env, db } = makeSqliteEnv();
    addSession(db, { id: "s-0915", opened: "2026-09-15T08:29:43.376Z", closed: "2026-09-15T08:43:43.753Z" });

    const hit = await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-15T08:44:14.334Z");
    expect(hit?.id).toBe("s-0915");
    expect(hit?.session_type).toBe("companion");
    // 31s, give or take the rounding of a julian-day difference.
    expect(hit?.distance_ms).toBeGreaterThan(29_000);
    expect(hit?.distance_ms).toBeLessThan(33_000);
  });

  it("reads a space-form stamp as readily as an ISO one -- both live in this table", async () => {
    const { env, db } = makeSqliteEnv();
    addSession(db, { id: "s-space", opened: "2026-09-15 08:29:43", closed: "2026-09-15 08:43:43" });
    const hit = await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-15T08:44:14.334Z");
    expect(hit?.id).toBe("s-space");
  });

  it("an OPEN session on the surface wins outright over one that closed seconds ago", async () => {
    const { env, db } = makeSqliteEnv();
    // Deliberate: the open row is 20 hours old and the closed row is 30 seconds old. An open
    // session on the surface IS the session -- distance 0 -- and must not lose to proximity.
    addSession(db, { id: "s-open", opened: "2026-09-20T17:00:00.000Z" });
    addSession(db, { id: "s-justclosed", opened: "2026-09-21T12:00:00.000Z", closed: "2026-09-21T12:58:19.000Z" });
    const hit = await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-21T12:58:49.446Z");
    expect(hit?.id).toBe("s-open");
    expect(hit?.distance_ms).toBe(0);
  });

  it("refuses a session outside the grace window rather than reaching for the nearest thing", async () => {
    const { env, db } = makeSqliteEnv();
    // The 09-18 thread, swept auto_stale three days before the move. Nearest is not near enough.
    addSession(db, { id: "s-0918", opened: "2026-09-18T14:53:30.717Z", closed: "2026-09-18T15:00:07.065Z" });
    expect(await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-21T12:58:49.446Z")).toBeNull();
    // A close 5 minutes back is still outside the 2-minute window.
    addSession(db, { id: "s-5min", opened: "2026-09-21T12:00:00.000Z", closed: "2026-09-21T12:53:49.000Z" });
    expect(await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-21T12:58:49.446Z")).toBeNull();
    expect(ATTRIBUTION_GRACE_MS).toBe(120_000);
  });

  it("never crosses surfaces: the bots open a session every few minutes and one of them is always near", async () => {
    const { env, db } = makeSqliteEnv();
    addSession(db, { id: "s-discord", surface: "discord:cypher", opened: "2026-09-21T12:58:00.000Z" });
    // Same companion, wrong surface: no attribution is better than a wrong one.
    expect(await findSessionForMoment(env, "cypher", "claude-ai:cypher", "2026-09-21T12:58:49.446Z")).toBeNull();
  });

  it("returns null without touching the DB when the caller does not say where it is speaking from", async () => {
    let queried = false;
    const env: any = { DB: { prepare: () => { queried = true; return { bind: () => ({ first: async () => null }) }; } } };
    expect(await findSessionForMoment(env, "cypher", null)).toBeNull();
    expect(await findSessionForMoment(env, null, "claude-ai:cypher")).toBeNull();
    expect(queried).toBe(false);
  });
});

describe("translateSomaVocab -- one dialect table, two call sites", () => {
  it("maps each companion's axis names to the columns they mean", () => {
    expect(translateSomaVocab({ acuity: 0.8, presence: 0.74 })).toEqual({ soma_float_1: 0.8, soma_float_2: 0.74 });
    expect(translateSomaVocab({ stillness: 0.9, perimeter: 0.7 })).toEqual({ soma_float_1: 0.9, soma_float_3: 0.7 });
    // Drevan's axes are TEXT enums and stay words.
    expect(translateSomaVocab({ heat: "warm", reach: "reaching" })).toEqual({ heat: "warm", reach: "reaching" });
  });

  it("resolves authored words per axis, never across them", () => {
    // "steady" is presence 0.55 but stillness 0.7 -- a flat word map would cross-contaminate.
    expect(translateSomaVocab({ presence: "steady" })).toEqual({ soma_float_2: 0.55 });
    expect(translateSomaVocab({ stillness: "steady" })).toEqual({ soma_float_1: 0.7 });
    expect(translateSomaVocab({ acuity: "sharp" })).toEqual({ soma_float_1: 0.9 });
  });

  it("passes an unknown key and an unknown word through, for the write path to name", () => {
    expect(translateSomaVocab({ nonsense: 1 })).toEqual({ nonsense: 1 });
    expect(translateSomaVocab({ acuity: "luminous" })).toEqual({ soma_float_1: "luminous" });
  });

  it("covers every axis the close payload advertises", () => {
    for (const k of ["acuity", "presence", "warmth", "stillness", "density", "perimeter", "heat", "reach", "weight"]) {
      expect(SOMA_AXIS_KEYS).toContain(k);
    }
  });
});

describe("normalizeStateValue -- the guard both float writers now share", () => {
  it("coerces a numeric string and drops what is not a number", () => {
    expect(normalizeStateValue("soma_float_1", "0.78")).toEqual({ write: true, value: 0.78 });
    expect(normalizeStateValue("soma_float_1", "luminous").write).toBe(false);
    expect(normalizeStateValue("soma_float_1", NaN).write).toBe(false);
    expect(normalizeStateValue("soma_float_1", Infinity).write).toBe(false);
  });

  it("clears on explicit null and skips a blank string -- Number('') is 0, which would ZERO a float", () => {
    expect(normalizeStateValue("soma_float_2", null)).toEqual({ write: true, value: null });
    expect(normalizeStateValue("soma_float_2", "   ").write).toBe(false);
  });

  it("leaves a text column alone", () => {
    expect(normalizeStateValue("heat", "warm")).toEqual({ write: true, value: "warm" });
    expect(normalizeStateValue("current_mood", "pattern-lit")).toEqual({ write: true, value: "pattern-lit" });
  });
});

// ── sessionClose: floats ride the close, attributed by construction ──────────

function makeRecordingEnv(prior: Record<string, unknown> | null = null) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const env: any = {
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            calls.push({ sql, binds });
            return {
              run: async () => ({ meta: { changes: 1 } }),
              all: async () => ({ results: [] }),
              // The only `first()` reads on this path are findExistingClose (no existing close)
              // and the float pre-read.
              first: async () => (/FROM companion_state/i.test(sql) ? prior : null),
            };
          },
        };
        return stmt;
      },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
  };
  return { env, calls };
}

describe("sessionClose -- the authored_close event", () => {
  const base = {
    session_id: "sess-1", spine: "the grace window landed", last_real_thing: "the query ran",
    motion_state: "at_rest", companionId: "cypher",
  };

  it("writes the float history with the session and the handover as the cause", async () => {
    const { env, calls } = makeRecordingEnv({ soma_float_1: 0.7, soma_float_2: 0.6, soma_float_3: 0.5, version: 4 });
    await sessionClose(env, { ...base, somaFields: { soma_float_1: 0.8 } });

    const events = calls.filter((c) => /INSERT (OR IGNORE )?INTO companion_soma_events/i.test(c.sql));
    expect(events.length).toBe(1);
    const binds = events[0]!.binds.map(String);
    expect(binds).toContain("authored_close");
    expect(binds).toContain("cypher");
    expect(binds).toContain("handover_packets");
    // The session id is on the row -- this is the whole point: no timing coincidence required.
    expect(binds).toContain("sess-1");
  });

  it("drops a float that is not a number instead of letting it reach a REAL column", async () => {
    const { env, calls } = makeRecordingEnv({ soma_float_1: 0.7, soma_float_2: 0.6, soma_float_3: 0.5, version: 4 });
    // What an unknown axis word looks like after translation: it passes through as a string.
    await sessionClose(env, { ...base, somaFields: { soma_float_1: "luminous" as unknown as number, current_mood: "lit" } });

    const stateWrites = calls.filter((c) => /UPDATE companion_state SET/i.test(c.sql));
    expect(stateWrites.length).toBe(1);
    expect(stateWrites[0]!.sql).not.toMatch(/soma_float_1/);
    expect(stateWrites[0]!.sql).toMatch(/current_mood/);
    // No float landed, so there is no float history row to write either.
    expect(calls.filter((c) => /INSERT (OR IGNORE )?INTO companion_soma_events/i.test(c.sql)).length).toBe(0);
  });

  it("records the COERCED value, so the history differences the number that reached the column", async () => {
    const { env, calls } = makeRecordingEnv({ soma_float_1: 0.70, soma_float_2: 0.6, soma_float_3: 0.5, version: 4 });
    await sessionClose(env, { ...base, somaFields: { soma_float_1: "0.80" as unknown as number } });
    const event = calls.find((c) => /INSERT (OR IGNORE )?INTO companion_soma_events/i.test(c.sql));
    expect(event).toBeDefined();
    const nums = event!.binds.filter((b) => typeof b === "number") as number[];
    expect(nums).toContain(0.8);              // after_value, coerced from the string
    expect(nums.some((n) => Math.abs(n - 0.1) < 1e-9)).toBe(true); // delta against 0.70
  });
});
