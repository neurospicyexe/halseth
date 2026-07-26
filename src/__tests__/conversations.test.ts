// Tests for the 2026-07-21 thread-spine core module (`src/webmind/conversations.ts`,
// migration 0106: conversation_threads + thread_ledger). One active thread per channel;
// idempotent ledger appends per Discord message; lazy fade on stale reads.
// In-memory D1 fake in the suite's miniflare-free style (copied/adapted from
// thread-hygiene-agency.test.ts — SQL-aware just enough for these statements).
//
// 2026-07-21 review-fix update: the FakeStatement now models the CAS guards (`WHERE id = ?
// AND state IN ('open','moving')`) by checking the row's actual current state before
// applying a state-transitioning UPDATE, and models appendTurn's SQL-side participants
// mutation (json_each/json_insert dedupe + POST-mutation state computation) in JS rather
// than trusting a bound full-blob value (there isn't one anymore). `preparedSqls` records
// every SQL string handed to `prepare()` so tests can assert on the guard/json_* text
// itself, not just on behavior. `raceStateAfterLedgerInsert` / `forceLandCasFailure` /
// `removeAfterIdRead` are opt-in hooks a test flips to simulate a concurrent writer landing
// or fading the thread in the gap between a function's initial SELECT and its guarded
// write -- exactly the race the CAS guards exist to survive.

import { describe, it, expect } from "vitest";
import {
  openConversation, appendTurn, landConversation, getActiveConversation, listConversations,
  FADE_HOURS,
  ConvoThread,
} from "../webmind/conversations.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

function isActive(t: Row): boolean {
  return t["state"] === "open" || t["state"] === "moving";
}

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async run(): Promise<{ meta: { changes: number }; results?: Row[] }> {
    const s = this.sql.trim();

    if (s.includes("INSERT INTO conversation_threads")) {
      if (this.db.insertShouldThrow) {
        throw new Error("UNIQUE constraint failed: conversation_threads.channel_id");
      }
      const [
        id, channel_id, surface, seed_text, seed_author, seed_message_id,
        ref_type, ref_id, ref_label, participants, last_turn_at, created_at,
      ] = this.bound as [
        string, string, string, string, string, string | null,
        string | null, string | null, string | null, string, string, string,
      ];
      this.db.threads.push({
        id, channel_id, surface, seed_text, seed_author, seed_message_id,
        ref_type, ref_id, ref_label, participants, state: "open",
        resolution: null, landed_by: null, landed_at: null,
        turn_count: 0, last_turn_at, created_at,
      });
      return { meta: { changes: 1 } };
    }

    if (s.includes("UPDATE conversation_threads SET state = 'landed'")) {
      if (this.db.forceLandCasFailure) return { meta: { changes: 0 } };
      const [resolution, landed_by, landed_at, id] = this.bound as [string, string, string, string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (!t || !isActive(t)) return { meta: { changes: 0 } };
      t["state"] = "landed";
      t["resolution"] = resolution;
      t["landed_by"] = landed_by;
      t["landed_at"] = landed_at;
      return { meta: { changes: 1 } };
    }

    if (s.includes("UPDATE conversation_threads SET state = 'faded'")) {
      const [id] = this.bound as [string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (!t || !isActive(t)) return { meta: { changes: 0 } };
      t["state"] = "faded";
      return { meta: { changes: 1 } };
    }

    if (s.includes("INTO thread_ledger")) {
      const [id, thread_id, author, gist, message_id, said_at] = this.bound as [
        string, string, string, string, string | null, string,
      ];
      const isIgnore = s.includes("OR IGNORE");
      if (isIgnore && message_id != null) {
        const dup = this.db.ledger.find(
          (row) => row["thread_id"] === thread_id && row["message_id"] === message_id,
        );
        if (dup) return { meta: { changes: 0 } };
      }
      this.db.ledger.push({ id, thread_id, author, gist, message_id, said_at });
      // Test hook: simulate a concurrent writer landing/fading the thread in the gap
      // between the ledger insert and appendTurn's guarded state-transition UPDATE.
      if (this.db.raceStateAfterLedgerInsert) {
        const t = this.db.threads.find((row) => row["id"] === thread_id);
        if (t) t["state"] = this.db.raceStateAfterLedgerInsert;
      }
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }

  async first<T = Row>(): Promise<T | null> {
    const s = this.sql.trim();
    if (s.includes("FROM conversation_threads") && s.includes("state IN")) {
      const [channel_id] = this.bound as [string];
      const row = this.db.threads.find((t) => t["channel_id"] === channel_id && isActive(t));
      return (row ?? null) as T | null;
    }
    if (s.includes("FROM conversation_threads") && s.includes("WHERE id = ?")) {
      const [id] = this.bound as [string];
      const idx = this.db.threads.findIndex((t) => t["id"] === id);
      if (idx === -1) return null;
      const row = this.db.threads[idx];
      // Test hook: simulate the row vanishing between the initial SELECT and a later
      // CAS re-check (landConversation's not_found-after-race branch).
      if (this.db.removeAfterIdRead) {
        this.db.removeAfterIdRead = false;
        this.db.threads.splice(idx, 1);
      }
      return row as T | null;
    }
    const refMatch = s.match(/^SELECT 1 FROM (\w+) WHERE id = \?$/);
    if (refMatch) {
      const table = refMatch[1]!;
      const [id] = this.bound as [string];
      const exists = this.db.refRows[table]?.has(id) ?? false;
      return (exists ? ({ "1": 1 } as unknown as T) : null);
    }
    return null;
  }

  async all<T = Row>(): Promise<{ results: T[]; meta?: { changes: number } }> {
    const s = this.sql.trim();

    // Combined turn_count/participants/state UPDATE...RETURNING (appendTurn). Uses .all(),
    // not .run() -- both return the same D1Result<T> shape, but .all() is unambiguous
    // about surfacing RETURNING rows (2026-07-21 review fix). Bind order matches the real
    // SQL: last_turn_at, author (participants EXISTS check), author (json_insert value),
    // author (state EXISTS check), id.
    if (s.includes("UPDATE conversation_threads SET turn_count")) {
      const [last_turn_at, author, , , id] = this.bound as [string, string, string, string, string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (!t || !isActive(t)) return { meta: { changes: 0 }, results: [] };

      const participants: string[] = JSON.parse(t["participants"] as string);
      const hasAuthor = participants.includes(author);
      const newParticipants = hasAuthor ? participants : [...participants, author];
      const newState = t["state"] === "open" && newParticipants.length >= 2 ? "moving" : t["state"] as string;

      t["turn_count"] = (t["turn_count"] as number) + 1;
      t["last_turn_at"] = last_turn_at;
      t["participants"] = JSON.stringify(newParticipants);
      t["state"] = newState;

      return {
        meta: { changes: 1 },
        results: [{ state: newState, participants: JSON.stringify(newParticipants) }] as unknown as T[],
      };
    }

    if (s.includes("FROM thread_ledger")) {
      const [thread_id, limit] = this.bound as [string, number];
      const rows = this.db.ledger
        .filter((row) => row["thread_id"] === thread_id)
        .sort((a, b) => String(a["said_at"]).localeCompare(String(b["said_at"])));
      const sliced = rows.slice(Math.max(0, rows.length - limit));
      return { results: sliced as T[] };
    }
    if (s.includes("FROM conversation_threads")) {
      let rows = [...this.db.threads];
      // state filter, if bound as the first param and sql has `state = ?`
      if (s.includes("state = ?")) {
        const state = this.bound[0] as string;
        rows = rows.filter((t) => t["state"] === state);
      }
      rows.sort((a, b) => String(b["last_turn_at"]).localeCompare(String(a["last_turn_at"])));
      const limit = this.bound[this.bound.length - 1] as number;
      return { results: rows.slice(0, limit) as T[] };
    }
    return { results: [] };
  }
}

class FakeDb {
  threads: Row[] = [];
  ledger: Row[] = [];
  insertShouldThrow = false;
  refRows: Record<string, Set<string>> = {};
  preparedSqls: string[] = [];
  raceStateAfterLedgerInsert: string | undefined;
  forceLandCasFailure = false;
  removeAfterIdRead = false;
  prepare = (sql: string) => {
    this.preparedSqls.push(sql);
    return new FakeStatement(sql, this);
  };
  batch = async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run()));
}

function makeEnv(db: FakeDb): Env {
  return { DB: db } as unknown as Env;
}

function seedThread(db: FakeDb, overrides: Partial<Row> = {}): Row {
  const now = new Date().toISOString();
  const row: Row = {
    id: "t1", channel_id: "chan1", surface: "discord", seed_text: "seed", seed_author: "cypher",
    seed_message_id: null, ref_type: null, ref_id: null, ref_label: null,
    participants: JSON.stringify(["cypher"]), state: "open",
    resolution: null, landed_by: null, landed_at: null,
    turn_count: 0, last_turn_at: now, created_at: now,
    ...overrides,
  };
  db.threads.push(row);
  return row;
}

describe("openConversation", () => {
  it("creates a thread with participants=[seed_author] and created:true", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hello there", seed_author: "cypher",
    });
    expect("error" in result).toBe(false);
    const ok = result as { thread: ConvoThread; created: boolean };
    expect(ok.created).toBe(true);
    expect(ok.thread.seed_author).toBe("cypher");
    expect(JSON.parse(ok.thread.participants)).toEqual(["cypher"]);
    expect(ok.thread.state).toBe("open");
  });

  it("returns the existing active thread with created:false on UNIQUE race", async () => {
    const db = new FakeDb();
    db.insertShouldThrow = true;
    seedThread(db, { id: "existing-1", seed_author: "drevan" });
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hi", seed_author: "cypher",
    });
    expect("error" in result).toBe(false);
    const ok = result as { thread: ConvoThread; created: boolean };
    expect(ok.created).toBe(false);
    expect(ok.thread.id).toBe("existing-1");
  });

  it("rejects ref_type without ref_id", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hi", seed_author: "cypher", ref_type: "question",
    });
    expect("error" in result).toBe(true);
    expect(db.threads).toHaveLength(0);
  });
});

describe("appendTurn", () => {
  it("no-ops with reason terminal on a landed thread", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "landed", resolution: "done", landed_by: "cypher" });
    const env = makeEnv(db);
    const result = await appendTurn(env, "t1", { author: "drevan", gist: "hey" });
    expect(result).toEqual({ ok: false, reason: "terminal" });
    expect(db.ledger).toHaveLength(0);
  });

  it("dedupes on message_id (INSERT OR IGNORE, meta.changes=0) without touching the thread row", async () => {
    const db = new FakeDb();
    seedThread(db, { turn_count: 3 });
    db.ledger.push({
      id: "l1", thread_id: "t1", author: "cypher", gist: "hi", message_id: "msg-1",
      said_at: new Date().toISOString(),
    });
    const env = makeEnv(db);
    const result = await appendTurn(env, "t1", { author: "cypher", gist: "hi again", message_id: "msg-1" });
    expect(result).toEqual({ ok: true, deduped: true });
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["turn_count"]).toBe(3);
    expect(t["state"]).toBe("open");
    expect(db.ledger).toHaveLength(1);
  });

  it("flips open→moving when a second distinct participant appends", async () => {
    const db = new FakeDb();
    seedThread(db, { participants: JSON.stringify(["cypher"]), state: "open" });
    const env = makeEnv(db);
    const result = await appendTurn(env, "t1", { author: "drevan", gist: "joining in" });
    expect(result.ok).toBe(true);
    expect(result.state).toBe("moving");
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("moving");
    expect(JSON.parse(t["participants"] as string)).toEqual(["cypher", "drevan"]);
    expect(t["turn_count"]).toBe(1);
  });

  // Finding 1 (2026-07-21 review): the state-transitioning UPDATE must carry the CAS
  // guard, and losing the race after the ledger row is already durable must still report
  // ok:true without claiming a state transition.
  it("guards the turn_count UPDATE with the state IN CAS clause", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "open" });
    const env = makeEnv(db);
    await appendTurn(env, "t1", { author: "drevan", gist: "joining in" });
    const turnSql = db.preparedSqls.find((sql) => sql.includes("SET turn_count"));
    expect(turnSql).toBeTruthy();
    expect(turnSql).toContain("state IN ('open','moving')");
  });

  it("reports ok:true with no state field when the CAS guard loses the race after the ledger row is already inserted", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "open" });
    // Simulate a concurrent writer landing the thread in the gap between the ledger
    // insert (which we just performed) and our guarded turn_count/state UPDATE.
    db.raceStateAfterLedgerInsert = "landed";
    const env = makeEnv(db);
    const result = await appendTurn(env, "t1", { author: "drevan", gist: "hey" });
    expect(result).toEqual({ ok: true });
    expect(db.ledger).toHaveLength(1); // the turn was still recorded
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("landed"); // the concurrent land wins, untouched by us
  });

  // Finding 2 (2026-07-21 review): participants must be mutated SQL-side, never via a
  // full-blob JS-computed bind.
  it("mutates participants SQL-side (json_each/json_insert), never binds the full participants blob", async () => {
    const db = new FakeDb();
    seedThread(db, { participants: JSON.stringify(["cypher"]), state: "open" });
    const env = makeEnv(db);
    await appendTurn(env, "t1", { author: "drevan", gist: "hi" });
    const turnSql = db.preparedSqls.find((sql) => sql.includes("SET turn_count"))!;
    expect(turnSql).toContain("json_insert");
    expect(turnSql).toContain("json_each");
    expect(turnSql).not.toContain("participants = ?");
  });
});

describe("landConversation", () => {
  it("lands an open thread (state, resolution, landed_by written)", async () => {
    const db = new FakeDb();
    seedThread(db, { turn_count: 2 });
    const env = makeEnv(db);
    const result = await landConversation(env, "t1", { resolution: "resolved it", landed_by: "cypher" });
    expect(result).toEqual({ ok: true });
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("landed");
    expect(t["resolution"]).toBe("resolved it");
    expect(t["landed_by"]).toBe("cypher");
    expect(t["landed_at"]).toBeTruthy();
  });

  it("refuses to land a faded thread", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "faded" });
    const env = makeEnv(db);
    const result = await landConversation(env, "t1", { resolution: "resolved it", landed_by: "cypher" });
    expect(result).toEqual({ ok: false, reason: "terminal" });
  });

  // Finding 1 (2026-07-21 review): compare-and-set. The UPDATE carries the guard, and
  // losing the CAS race re-checks the row to report an accurate reason rather than
  // silently claiming ok:true for a write that never happened.
  it("guards the land UPDATE with the state IN CAS clause", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "open" });
    const env = makeEnv(db);
    await landConversation(env, "t1", { resolution: "resolved it", landed_by: "cypher" });
    const landSql = db.preparedSqls.find((sql) => sql.includes("SET state = 'landed'"));
    expect(landSql).toBeTruthy();
    expect(landSql).toContain("state IN ('open','moving')");
  });

  it("reports reason:terminal when the CAS guard loses the race and the row still exists", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "open" });
    // Simulate another process already having landed/faded it between our initial read
    // and this write -- the guarded UPDATE reports changes:0 regardless of row content.
    db.forceLandCasFailure = true;
    const env = makeEnv(db);
    const result = await landConversation(env, "t1", { resolution: "resolved it", landed_by: "cypher" });
    expect(result).toEqual({ ok: false, reason: "terminal" });
  });

  it("reports reason:not_found when the CAS guard loses the race and the row is gone by the re-check", async () => {
    const db = new FakeDb();
    seedThread(db, { state: "open" });
    db.forceLandCasFailure = true;
    db.removeAfterIdRead = true; // row vanishes after the initial SELECT, before the re-check
    const env = makeEnv(db);
    const result = await landConversation(env, "t1", { resolution: "resolved it", landed_by: "cypher" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("getActiveConversation", () => {
  it("fades a stale active thread (last_turn_at older than FADE_HOURS) and returns null", async () => {
    const db = new FakeDb();
    const stale = new Date(Date.now() - (FADE_HOURS + 1) * 3_600_000).toISOString();
    seedThread(db, { last_turn_at: stale, created_at: stale });
    const env = makeEnv(db);
    const result = await getActiveConversation(env, "chan1");
    expect(result).toBeNull();
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("faded");
  });

  it("returns thread + ledger for a fresh active thread", async () => {
    const db = new FakeDb();
    const now = new Date().toISOString();
    seedThread(db, { last_turn_at: now, created_at: now });
    db.ledger.push({ id: "l1", thread_id: "t1", author: "cypher", gist: "hi", message_id: null, said_at: now });
    const env = makeEnv(db);
    const result = await getActiveConversation(env, "chan1");
    expect(result).not.toBeNull();
    expect(result!.thread.id).toBe("t1");
    expect(result!.ledger).toHaveLength(1);
    expect(result!.ledger[0]!.gist).toBe("hi");
  });

  // Finding 1 (2026-07-21 review): the lazy-fade UPDATE must carry the CAS guard so it can
  // never clobber a concurrent land.
  it("guards the lazy-fade UPDATE with the state IN CAS clause", async () => {
    const db = new FakeDb();
    const stale = new Date(Date.now() - (FADE_HOURS + 1) * 3_600_000).toISOString();
    seedThread(db, { last_turn_at: stale, created_at: stale });
    const env = makeEnv(db);
    await getActiveConversation(env, "chan1");
    const fadeSql = db.preparedSqls.find((sql) => sql.includes("SET state = 'faded'"));
    expect(fadeSql).toBeTruthy();
    expect(fadeSql).toContain("state IN ('open','moving')");
  });
});

describe("openConversation ref existence (Finding 3, mig-0104 convention)", () => {
  it("rejects a ref_id that does not exist in the mapped table", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hi", seed_author: "cypher",
      ref_type: "tension", ref_id: "missing-1",
    });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe('ref_id "missing-1" not found in companion_tensions');
    expect(db.threads).toHaveLength(0);
  });

  it("accepts a ref_id that exists in the mapped table", async () => {
    const db = new FakeDb();
    db.refRows["companion_questions"] = new Set(["q1"]);
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hi", seed_author: "cypher",
      ref_type: "question", ref_id: "q1",
    });
    expect("error" in result).toBe(false);
    const ok = result as { thread: ConvoThread; created: boolean };
    expect(ok.thread.ref_type).toBe("question");
    expect(ok.thread.ref_id).toBe("q1");
  });

  it("checks the council ref_type against council_questions", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const result = await openConversation(env, {
      channel_id: "chan1", seed_text: "hi", seed_author: "cypher",
      ref_type: "council", ref_id: "c1",
    });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("council_questions");
  });
});
