// src/__tests__/conversation-verbs.test.ts
//
// Task 5 of the thread-spine plan (2026-07-21): two new Librarian natural-language
// verbs (conversation_list, conversation_land) wired onto Task 2's conversation-thread
// module (src/webmind/conversations.ts) and Task 3's HTTP handlers. "thread"/
// "conversation" trigger words collide with wm_thread_upsert and live_thread_* in BOTH
// directions -- the anchored guards in router.ts (ANCHORED_GUARDS) are load-bearing
// here, not decoration. This file asserts routing (guards win over neighboring
// patterns) and executor behavior (parse context, call the Task 2 module fns, ack).

import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";
import { execConversationList, execConversationLand } from "../librarian/executors/webmind.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

// ── Routing ───────────────────────────────────────────────────────────────────

describe("routing: conversation_list", () => {
  it("routes 'open conversations' to conversation_list", () => {
    expect(matchFastPath("open conversations")?.key).toBe("conversation_list");
  });

  it("routes 'what conversations are open' to conversation_list", () => {
    expect(matchFastPath("what conversations are open")?.key).toBe("conversation_list");
  });

  it("routes 'conversation threads' to conversation_list", () => {
    expect(matchFastPath("conversation threads")?.key).toBe("conversation_list");
  });
});

describe("routing: conversation_land", () => {
  it("routes 'land conversation' to conversation_land", () => {
    expect(matchFastPath("land conversation")?.key).toBe("conversation_land");
  });

  it("routes 'land the conversation' to conversation_land", () => {
    expect(matchFastPath("land the conversation")?.key).toBe("conversation_land");
  });

  it("routes 'conversation landed' to conversation_land", () => {
    expect(matchFastPath("conversation landed")?.key).toBe("conversation_land");
  });
});

describe("anti-collision: conversation spine vs wm_thread_upsert / live_thread_*", () => {
  it("'track a mind thread for cypher' still routes to wm_thread_upsert (not conversation_land)", () => {
    const result = matchFastPath("track a mind thread for cypher");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_thread_upsert");
  });

  it("'track mind thread' still routes to wm_thread_upsert", () => {
    expect(matchFastPath("track mind thread")?.key).toBe("wm_thread_upsert");
  });

  it("'live thread add' still routes to live_thread_add (not conversation_list)", () => {
    expect(matchFastPath("add live thread")?.key).toBe("live_thread_add");
  });

  it("'land the conversation' routes to conversation_land, not wm_thread_upsert or live_thread_close", () => {
    const result = matchFastPath("land the conversation");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("conversation_land");
  });

  it("'land this thread' routes to conversation_land, not live_thread_close", () => {
    const result = matchFastPath("land this thread");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("conversation_land");
  });
});

// ── Executors ─────────────────────────────────────────────────────────────────
// In-memory D1 fake, copied/adapted from conversations.test.ts's miniflare-free style --
// just SQL-aware enough for the statements execConversationList/execConversationLand's
// module calls (listConversations, landConversation, getActiveConversation) issue.

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async run(): Promise<{ meta: { changes: number } }> {
    const s = this.sql.trim();
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
    if (s.includes("FROM thread_ledger")) return { results: [] as T[] };
    if (s.includes("FROM conversation_threads")) {
      let rows = [...this.db.threads];
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
  prepare = (sql: string) => new FakeStatement(sql, this);
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

function makeCtx(db: FakeDb, request: string, context?: string): ExecutorContext {
  return {
    req: { companion_id: "cypher", request, context },
    env: { DB: db },
  } as unknown as ExecutorContext;
}

describe("execConversationList", () => {
  it("returns { ack: true, conversations } sourced from listConversations", async () => {
    const db = new FakeDb();
    seedThread(db, { id: "t1", channel_id: "chan1" });
    seedThread(db, { id: "t2", channel_id: "chan2", state: "landed" });
    const ctx = makeCtx(db, "open conversations");
    const r = await execConversationList(ctx) as { ack: boolean; conversations: Row[] };
    expect(r.ack).toBe(true);
    expect(r.conversations.map((c) => c["id"]).sort()).toEqual(["t1", "t2"]);
  });

  it("passes optional state/days/limit through from context", async () => {
    const db = new FakeDb();
    seedThread(db, { id: "t1", state: "open" });
    seedThread(db, { id: "t2", channel_id: "chan2", state: "landed" });
    const ctx = makeCtx(db, "open conversations", JSON.stringify({ state: "landed", limit: 5 }));
    const r = await execConversationList(ctx) as { ack: boolean; conversations: Row[] };
    expect(r.ack).toBe(true);
    expect(r.conversations).toHaveLength(1);
    expect(r.conversations[0]!["id"]).toBe("t2");
  });
});

describe("execConversationLand", () => {
  it("lands by explicit thread_id, landed_by = ctx.req.companion_id", async () => {
    const db = new FakeDb();
    seedThread(db, { id: "t1" });
    const ctx = makeCtx(db, "land conversation", JSON.stringify({ thread_id: "t1", resolution: "wrapped it up" }));
    const r = await execConversationLand(ctx) as { ack: boolean };
    expect(r.ack).toBe(true);
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("landed");
    expect(t["landed_by"]).toBe("cypher");
    expect(t["resolution"]).toBe("wrapped it up");
  });

  it("resolves thread_id via getActiveConversation when only channel_id is given", async () => {
    const db = new FakeDb();
    seedThread(db, { id: "t1", channel_id: "chan1" });
    const ctx = makeCtx(db, "land the conversation", JSON.stringify({ channel_id: "chan1", resolution: "done" }));
    const r = await execConversationLand(ctx) as { ack: boolean };
    expect(r.ack).toBe(true);
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("landed");
    expect(t["landed_by"]).toBe("cypher");
  });

  it("errors 'no active conversation in that channel' when channel_id resolves to nothing", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db, "land the conversation", JSON.stringify({ channel_id: "chan-empty", resolution: "done" }));
    const r = await execConversationLand(ctx) as { error?: string; reason?: string };
    expect(r.reason).toBe("no active conversation in that channel");
  });

  it("requires resolution -- errors without it", async () => {
    const db = new FakeDb();
    seedThread(db, { id: "t1" });
    const ctx = makeCtx(db, "land conversation", JSON.stringify({ thread_id: "t1" }));
    const r = await execConversationLand(ctx) as { error?: string; reason?: string };
    expect(r.error).toBeTruthy();
    expect(r.reason).toMatch(/resolution/);
    const t = db.threads.find((row) => row["id"] === "t1")!;
    expect(t["state"]).toBe("open");
  });

  it("errors when neither thread_id nor channel_id is given", async () => {
    const db = new FakeDb();
    const ctx = makeCtx(db, "land conversation", JSON.stringify({ resolution: "done" }));
    const r = await execConversationLand(ctx) as { error?: string; reason?: string };
    expect(r.error).toBeTruthy();
  });
});
