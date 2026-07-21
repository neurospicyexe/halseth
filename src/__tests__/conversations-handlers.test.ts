// Tests for /mind/conversations* handlers (migration 0106 thread spine, Task 3).
// In-memory D1 fake in the suite's miniflare-free style (helpers copied in from
// thread-hygiene-agency.test.ts's idiom, not cross-imported).

import { describe, it, expect } from "vitest";
import {
  postConversation,
  postConversationTurn,
  postConversationLand,
  getConversationActive,
  listConversationsHandler,
} from "../handlers/conversations.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

// SQL-aware just enough for the statements src/webmind/conversations.ts runs.
class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async run(): Promise<{ meta: { changes: number } }> {
    const s = this.sql.trim();

    if (s.startsWith("INSERT INTO conversation_threads")) {
      const [
        id, channel_id, surface, seed_text, seed_author, seed_message_id,
        ref_type, ref_id, ref_label, participants, last_turn_at, created_at,
      ] = this.bound as [
        string, string, string, string, string, string | null,
        string | null, string | null, string | null, string, string, string,
      ];

      const activeExists = this.db.threads.some(
        (t) => t["channel_id"] === channel_id && (t["state"] === "open" || t["state"] === "moving"),
      );
      if (activeExists) {
        throw new Error("UNIQUE constraint failed: conversation_threads.channel_id");
      }

      this.db.threads.push({
        id, channel_id, surface, seed_text, seed_author, seed_message_id,
        ref_type, ref_id, ref_label, participants, state: "open",
        resolution: null, landed_by: null, landed_at: null,
        turn_count: 0, last_turn_at, created_at,
      });
      return { meta: { changes: 1 } };
    }

    if (s.startsWith("UPDATE conversation_threads SET turn_count")) {
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

    if (s.startsWith("UPDATE conversation_threads SET state = 'landed'")) {
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

    if (s.startsWith("UPDATE conversation_threads SET state = 'faded'")) {
      const [id] = this.bound as [string];
      const t = this.db.threads.find((row) => row["id"] === id);
      if (t) t["state"] = "faded";
      return { meta: { changes: t ? 1 : 0 } };
    }

    if (s.startsWith("INSERT OR IGNORE INTO thread_ledger") || s.startsWith("INSERT INTO thread_ledger")) {
      const [id, thread_id, author, gist, message_id, said_at] = this.bound as [
        string, string, string, string, string | null, string,
      ];
      if (message_id != null && this.db.ledger.some((l) => l["thread_id"] === thread_id && l["message_id"] === message_id)) {
        return { meta: { changes: 0 } };
      }
      this.db.ledger.push({ id, thread_id, author, gist, message_id, said_at });
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 1 } };
  }

  async first<T = Row>(): Promise<T | null> {
    const s = this.sql.trim();

    if (s.includes("FROM conversation_threads WHERE channel_id") && s.includes("state IN")) {
      const [channel_id] = this.bound as [string];
      const found = this.db.threads.find(
        (t) => t["channel_id"] === channel_id && (t["state"] === "open" || t["state"] === "moving"),
      );
      return (found ?? null) as T | null;
    }

    if (s.includes("FROM conversation_threads WHERE id")) {
      const [id] = this.bound as [string];
      const found = this.db.threads.find((t) => t["id"] === id);
      return (found ?? null) as T | null;
    }

    return null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    const s = this.sql.trim();

    if (s.includes("FROM thread_ledger WHERE thread_id")) {
      const [thread_id] = this.bound as [string];
      return { results: this.db.ledger.filter((l) => l["thread_id"] === thread_id) as unknown as T[] };
    }

    if (s.includes("FROM conversation_threads")) {
      let results = [...this.db.threads];
      let bindIdx = 0;

      if (s.includes("state = ?")) {
        const state = this.bound[bindIdx] as string;
        bindIdx++;
        results = results.filter((t) => t["state"] === state);
      }
      if (s.includes("datetime(created_at)")) {
        const daysRaw = String(this.bound[bindIdx]);
        bindIdx++;
        const days = parseInt(daysRaw.replace(/[^0-9]/g, ""), 10);
        const cutoff = Date.now() - days * 86_400_000;
        results = results.filter((t) => Date.parse(String(t["created_at"])) >= cutoff);
      }

      results.sort((a, b) => String(b["last_turn_at"]).localeCompare(String(a["last_turn_at"])));
      const limit = this.bound[this.bound.length - 1] as number;
      return { results: results.slice(0, limit) as unknown as T[] };
    }

    return { results: [] };
  }
}

class FakeDb {
  threads: Row[] = [];
  ledger: Row[] = [];
  prepare = (sql: string) => new FakeStatement(sql, this);
  batch = async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run()));
}

const ADMIN = "test-admin-secret";

function makeEnv(db: FakeDb, secrets: Partial<Record<string, string>> = {}): Env {
  return { DB: db, ADMIN_SECRET: ADMIN, ...secrets } as unknown as Env;
}

function req(method: string, path: string, body: unknown, auth: string | null = `Bearer ${ADMIN}`): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

// ── auth ────────────────────────────────────────────────────────────────────

describe("conversations handlers auth", () => {
  it("401s POST /mind/conversations without auth", async () => {
    const env = makeEnv(new FakeDb());
    const res = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c1", seed_text: "hi", seed_author: "raziel" }, null),
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ── open ──────────────────────────────────────────────────────────────────

describe("postConversation (open)", () => {
  it("opens a new conversation -> 201 created:true", async () => {
    const env = makeEnv(new FakeDb());
    const res = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c1", seed_text: "what should we build", seed_author: "raziel" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { thread: { id: string; state: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.thread.state).toBe("open");
  });

  it("returns existing active thread on the same channel -> 200 created:false", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const first = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c1", seed_text: "seed one", seed_author: "raziel" }),
      env,
    );
    expect(first.status).toBe(201);

    const second = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c1", seed_text: "seed two", seed_author: "cypher" }),
      env,
    );
    expect(second.status).toBe(200);
    const body = await second.json() as { created: boolean; thread: { seed_text: string } };
    expect(body.created).toBe(false);
    expect(body.thread.seed_text).toBe("seed one");
  });

  it("400s on missing required fields", async () => {
    const env = makeEnv(new FakeDb());
    const res = await postConversation(req("POST", "/mind/conversations", { seed_text: "hi", seed_author: "raziel" }), env);
    expect(res.status).toBe(400);
  });
});

// ── turns ─────────────────────────────────────────────────────────────────

describe("postConversationTurn", () => {
  it("409s on a terminal (landed) thread", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);

    const opened = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c2", seed_text: "seed", seed_author: "raziel" }),
      env,
    );
    const { thread } = await opened.json() as { thread: { id: string } };

    const landed = await postConversationLand(
      req("POST", `/mind/conversations/${thread.id}/land`, { resolution: "done", landed_by: "cypher" }),
      env,
      { id: thread.id },
    );
    expect(landed.status).toBe(200);

    const turnRes = await postConversationTurn(
      req("POST", `/mind/conversations/${thread.id}/turns`, { author: "raziel", gist: "one more thing" }),
      env,
      { id: thread.id },
    );
    expect(turnRes.status).toBe(409);
    const body = await turnRes.json() as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "terminal" });
  });

  it("404s on an unknown thread id", async () => {
    const env = makeEnv(new FakeDb());
    const res = await postConversationTurn(
      req("POST", "/mind/conversations/nope/turns", { author: "raziel", gist: "hi" }),
      env,
      { id: "nope" },
    );
    expect(res.status).toBe(404);
  });

  it("200s and appends a turn on an open thread", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const opened = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c3", seed_text: "seed", seed_author: "raziel" }),
      env,
    );
    const { thread } = await opened.json() as { thread: { id: string } };

    const res = await postConversationTurn(
      req("POST", `/mind/conversations/${thread.id}/turns`, { author: "cypher", gist: "replying" }),
      env,
      { id: thread.id },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── active ────────────────────────────────────────────────────────────────

describe("getConversationActive", () => {
  it("400s without channel_id", async () => {
    const env = makeEnv(new FakeDb());
    const res = await getConversationActive(req("GET", "/mind/conversations/active", undefined), env);
    expect(res.status).toBe(400);
  });

  it("returns {thread: null} when no active thread exists", async () => {
    const env = makeEnv(new FakeDb());
    const res = await getConversationActive(req("GET", "/mind/conversations/active?channel_id=nope", undefined), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { thread: null };
    expect(body.thread).toBeNull();
  });

  it("returns the active thread + ledger when one exists", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c4", seed_text: "seed", seed_author: "raziel" }),
      env,
    );
    const res = await getConversationActive(req("GET", "/mind/conversations/active?channel_id=c4", undefined), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { thread: { channel_id: string } | null; ledger: unknown[] };
    expect(body.thread?.channel_id).toBe("c4");
    expect(body.ledger).toEqual([]);
  });
});

// ── list ──────────────────────────────────────────────────────────────────

describe("listConversationsHandler", () => {
  it("respects the state filter", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);

    const opened1 = await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c5", seed_text: "seed", seed_author: "raziel" }),
      env,
    );
    const { thread: thread1 } = await opened1.json() as { thread: { id: string } };

    await postConversation(
      req("POST", "/mind/conversations", { channel_id: "c6", seed_text: "seed", seed_author: "raziel" }),
      env,
    );

    await postConversationLand(
      req("POST", `/mind/conversations/${thread1.id}/land`, { resolution: "done", landed_by: "cypher" }),
      env,
      { id: thread1.id },
    );

    const landedRes = await listConversationsHandler(req("GET", "/mind/conversations?state=landed", undefined), env);
    expect(landedRes.status).toBe(200);
    const landedBody = await landedRes.json() as { conversations: Array<{ channel_id: string }> };
    expect(landedBody.conversations).toHaveLength(1);
    expect(landedBody.conversations[0]!.channel_id).toBe("c5");

    const openRes = await listConversationsHandler(req("GET", "/mind/conversations?state=open", undefined), env);
    const openBody = await openRes.json() as { conversations: Array<{ channel_id: string }> };
    expect(openBody.conversations).toHaveLength(1);
    expect(openBody.conversations[0]!.channel_id).toBe("c6");
  });
});
