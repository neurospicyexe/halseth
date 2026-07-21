// Tests for the 2026-07-21 thread-spine core module (`src/webmind/conversations.ts`,
// migration 0106: conversation_threads + thread_ledger). One active thread per channel;
// idempotent ledger appends per Discord message; lazy fade on stale reads.
// In-memory D1 fake in the suite's miniflare-free style (copied/adapted from
// thread-hygiene-agency.test.ts — SQL-aware just enough for these statements).

import { describe, it, expect } from "vitest";
import {
  openConversation, appendTurn, landConversation, getActiveConversation, listConversations,
  FADE_HOURS,
  ConvoThread,
} from "../webmind/conversations.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async run(): Promise<{ meta: { changes: number } }> {
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

    if (s.includes("UPDATE conversation_threads SET turn_count")) {
      const [last_turn_at, participants, state, id] = this.bound as [string, string, string, string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (t) {
        t["turn_count"] = (t["turn_count"] as number) + 1;
        t["last_turn_at"] = last_turn_at;
        t["participants"] = participants;
        t["state"] = state;
      }
      return { meta: { changes: t ? 1 : 0 } };
    }

    if (s.includes("UPDATE conversation_threads SET state = 'landed'")) {
      const [resolution, landed_by, landed_at, id] = this.bound as [string, string, string, string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (t) {
        t["state"] = "landed";
        t["resolution"] = resolution;
        t["landed_by"] = landed_by;
        t["landed_at"] = landed_at;
      }
      return { meta: { changes: t ? 1 : 0 } };
    }

    if (s.includes("UPDATE conversation_threads SET state = 'faded'")) {
      const [id] = this.bound as [string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (t) t["state"] = "faded";
      return { meta: { changes: t ? 1 : 0 } };
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
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }

  async first<T = Row>(): Promise<T | null> {
    const s = this.sql.trim();
    if (s.includes("FROM conversation_threads") && s.includes("state IN")) {
      const [channel_id] = this.bound as [string];
      const row = this.db.threads.find(
        (t) => t["channel_id"] === channel_id && (t["state"] === "open" || t["state"] === "moving"),
      );
      return (row ?? null) as T | null;
    }
    if (s.includes("FROM conversation_threads") && s.includes("WHERE id = ?")) {
      const [id] = this.bound as [string];
      const row = this.db.threads.find((t) => t["id"] === id);
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    const s = this.sql.trim();
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
  prepare = (sql: string) => new FakeStatement(sql, this);
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
});
