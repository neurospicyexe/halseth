// Tests for the Hearth write layer (migration 0092): commons_posts handlers.
// Wall, not chat -- ambient posts, optional async replies via reply_to. Mirrors the
// suite's miniflare-free style with a minimal in-memory D1 fake (see forage.test.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { postCommonsPost, getCommonsPosts, getCommonsFeed } from "../handlers/commons.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private store: Row[], private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.store, args);
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT")) {
      const [id, author, context, body, reply_to] = this.bound as [string, string, string, string, string | null];
      // created_at strictly increasing by insertion order so DESC == reverse insertion.
      this.store.push({ id, author, context, body, reply_to, created_at: String(this.store.length).padStart(6, "0") });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first(): Promise<Row | null> {
    // SELECT id FROM commons_posts WHERE id = ?  (reply_to parent check)
    const [id] = this.bound as [string];
    return this.store.find(r => r["id"] === id) ?? null;
  }
  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("WHERE context")) {
      const [context, limit] = this.bound as [string, number];
      const res = this.store.filter(r => r["context"] === context).slice().reverse().slice(0, limit ?? 30);
      return { results: res };
    }
    // feed: no WHERE, across all contexts
    const [limit] = this.bound as [number];
    return { results: this.store.slice().reverse().slice(0, limit ?? 20) };
  }
}

const ADMIN_SECRET = "test-admin-secret";

function makeEnv(store: Row[]): Env {
  return { DB: { prepare: (sql: string) => new FakeStatement(sql, store) }, ADMIN_SECRET } as unknown as Env;
}

function post(body: unknown): Request {
  return new Request("http://local/mind/commons", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function get(qs: string): Request {
  return new Request(`http://local/mind/commons${qs}`, {
    headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
  });
}

describe("commons handlers", () => {
  let store: Row[];
  let env: Env;
  beforeEach(() => { store = []; env = makeEnv(store); });

  it("POST inserts a global post and returns 201 + id", async () => {
    const res = await postCommonsPost(post({ author: "raziel", body: "a half-formed thought" }), env);
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string };
    expect(data.id).toBeTruthy();
    expect(store).toHaveLength(1);
    expect(store[0]!["context"]).toBe("global"); // default
  });

  it("POST rejects a bad author and an empty body", async () => {
    expect((await postCommonsPost(post({ author: "system", body: "x" }), env)).status).toBe(400);
    expect((await postCommonsPost(post({ author: "raziel", body: "   " }), env)).status).toBe(400);
  });

  it("GET by context returns only that context, newest first", async () => {
    await postCommonsPost(post({ author: "raziel", body: "first", context: "global" }), env);
    await postCommonsPost(post({ author: "raziel", body: "club one", context: "club:r1" }), env);
    await postCommonsPost(post({ author: "raziel", body: "second", context: "global" }), env);
    const res = await getCommonsPosts(get("?context=global"), env);
    const data = await res.json() as { posts: Array<{ body: string }> };
    expect(data.posts.map(p => p.body)).toEqual(["second", "first"]); // newest first
  });

  it("a reply inherits context, links via reply_to, and round-trips", async () => {
    const rootRes = await postCommonsPost(post({ author: "raziel", body: "what is this show", context: "shelf:s1" }), env);
    const rootId = (await rootRes.json() as { id: string }).id;
    const replyRes = await postCommonsPost(post({ author: "cypher", body: "here is a read", context: "shelf:s1", reply_to: rootId }), env);
    expect(replyRes.status).toBe(201);
    const data = await (await getCommonsPosts(get("?context=shelf:s1"), env)).json() as { posts: Array<{ body: string; reply_to: string | null }> };
    const reply = data.posts.find(p => p.body === "here is a read");
    expect(reply?.reply_to).toBe(rootId);
  });

  it("POST with an unknown reply_to is a 400, not a 500", async () => {
    const res = await postCommonsPost(post({ author: "cypher", body: "orphan", reply_to: "nope" }), env);
    expect(res.status).toBe(400);
  });

  it("feed returns recent posts across ALL contexts", async () => {
    await postCommonsPost(post({ author: "raziel", body: "g", context: "global" }), env);
    await postCommonsPost(post({ author: "raziel", body: "c", context: "club:r1" }), env);
    await postCommonsPost(post({ author: "raziel", body: "s", context: "shelf:s1" }), env);
    const data = await (await getCommonsFeed(get("/feed?limit=20"), env)).json() as { posts: Array<{ body: string }> };
    expect(data.posts.map(p => p.body).sort()).toEqual(["c", "g", "s"]);
  });
});
