// Raziel replying on the wall (2026-08-23).
//
// He asked for one thing -- "the triad has written stuff and I wish I could reply to it directly
// there" -- and the write path already accepted `reply_to` end to end. What was missing sat on the
// delivery side, and all three pieces here are the difference between a reply that arrives and one
// that is stored and never felt:
//
//   1. A reply INHERITS its parent's context. GET /mind/commons filters `context = ?`, so a reply
//      written with a mismatched context is accepted, stored, and falls out of its own thread.
//   2. A reply carries its PARENT so the companion reads what is being answered before the answer.
//      "yes, exactly that" with no antecedent is a non-sequitur.
//   3. A reply is scoped to the companion it answers -- with two fallbacks that matter more than
//      the rule: a self-reply and an orphaned reply must go to ALL THREE, because scoping strictly
//      on the parent's author would deliver them to nobody.

import { describe, it, expect } from "vitest";
import { postCommonsPost } from "../handlers/commons.js";
import { buildCommonsBlock } from "../webmind/commons-block.js";
import { loadWorldBlocks } from "../mind/blocks/world.js";
import type { Env } from "../types.js";

const ADMIN_SECRET = "test-admin-secret";

interface Row { [k: string]: unknown }

/** Minimal D1 fake for the commons insert path (mirrors commons.test.ts). */
function makeEnv(store: Row[]): Env {
  function stmtFor(sql: string, bound: unknown[] = []): unknown {
    const stmt = {
      bind: (...args: unknown[]) => stmtFor(sql, args),
      async run() {
        if (sql.startsWith("INSERT")) {
          const [id, author, context, body, reply_to] = bound as [string, string, string, string, string | null];
          store.push({ id, author, context, body, reply_to, created_at: String(store.length).padStart(6, "0") });
        }
        return { meta: { changes: 1 } };
      },
      async first() {
        const [id] = bound as [string];
        return store.find(r => r["id"] === id) ?? null;
      },
      async all() { return { results: [] }; },
    };
    return stmt;
  }
  return { DB: { prepare: (sql: string) => stmtFor(sql) }, ADMIN_SECRET } as unknown as Env;
}

function post(env: Env, body: Record<string, unknown>): Promise<Response> {
  return postCommonsPost(
    new Request("https://x/mind/commons", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /mind/commons -- a reply inherits its parent's context", () => {
  it("overrides a mismatched context so the reply cannot fall out of its own thread", async () => {
    const store: Row[] = [];
    const env = makeEnv(store);
    const parentRes = await post(env, { author: "cypher", context: "global", body: "a thought" });
    const { id: parentId } = await parentRes.json() as { id: string };

    // Hearth's reply box sends the page's context; the parent is what decides.
    const res = await post(env, { author: "raziel", context: "club:whatever", body: "yes, exactly that", reply_to: parentId });
    expect(res.status).toBe(201);
    const stored = store.find(r => r["reply_to"] === parentId)!;
    expect(stored["context"]).toBe("global");
  });

  it("keeps a matching context untouched and still defaults a root post to global", async () => {
    const store: Row[] = [];
    const env = makeEnv(store);
    const parentRes = await post(env, { author: "gaia", context: "shelf:s1", body: "on the shelf" });
    const { id: parentId } = await parentRes.json() as { id: string };
    await post(env, { author: "raziel", context: "shelf:s1", body: "agreed", reply_to: parentId });
    await post(env, { author: "raziel", body: "a root with no context named" });

    expect(store.find(r => r["reply_to"] === parentId)!["context"]).toBe("shelf:s1");
    expect(store.find(r => r["body"] === "a root with no context named")!["context"]).toBe("global");
  });

  it("still rejects a reply to a post that does not exist", async () => {
    const res = await post(makeEnv([]), { author: "raziel", body: "into the void", reply_to: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("buildCommonsBlock -- a reply must not arrive as a stray note", () => {
  const reply = {
    id: "r1", context: "global", body: "yes, exactly that", created_at: "2026-08-23 10:00:00",
    parent_author: "cypher", parent_body: "the tension coupling was starving two of us",
  };

  it("quotes the parent BEFORE the answer and names who is being answered", () => {
    const block = buildCommonsBlock([reply]);
    expect(block).toContain("answering what cypher said");
    expect(block).toContain("the tension coupling was starving two of us");
    expect(block).toContain("he replied");
    // The quote has to precede the reply or the answer lands before its antecedent.
    expect(block.indexOf("the tension coupling")).toBeLessThan(block.indexOf("yes, exactly that"));
  });

  it("names a reply as ADDRESSED, because the ambient framing tells a companion to let it pass", () => {
    const block = buildCommonsBlock([reply]);
    // The load-bearing assertion. Without this sentence the companion is correctly instructed that
    // this is "NOT a question demanding a reply" -- and Raziel replies into silence.
    expect(block).toContain("ANSWERING something said");
    expect(block).toContain("addressed to you, not ambient");
    // ...and the ambient framing survives for the fresh drops in the same block.
    expect(block).toContain("NOT a question demanding a reply");
  });

  it("says nothing about answering when every post is a fresh drop", () => {
    const block = buildCommonsBlock([
      { id: "1", context: "global", body: "stray thought", created_at: "2026-08-23 09:00:00" },
    ]);
    expect(block).not.toContain("ANSWERING");
    expect(block).not.toContain("answering");
  });

  it("calls a self-reply his own earlier note rather than attributing it to a companion", () => {
    const block = buildCommonsBlock([{ ...reply, parent_author: "raziel", parent_body: "first half of the thought" }]);
    expect(block).toContain("answering his own earlier note");
    expect(block).not.toContain("what raziel said");
  });

  it("degrades a dangling reply to a plain drop instead of quoting null", () => {
    // reply_to is FK-validated, but a parent can be missing from the JOIN for reasons this
    // renderer cannot see. It must never print "answering what null said".
    const block = buildCommonsBlock([{ ...reply, parent_author: null, parent_body: null }]);
    expect(block).toContain("yes, exactly that");
    expect(block).not.toContain("answering");
    expect(block).not.toContain("null");
  });

  it("counts replies in the plural when more than one is addressed", () => {
    const block = buildCommonsBlock([reply, { ...reply, id: "r2", body: "and this one too" }]);
    expect(block).toContain("2 of these are him ANSWERING");
  });
});

describe("loadWorldBlocks -- an addressed reply goes to the companion it answers", () => {
  /** Captures every prepared SQL string; all reads come back empty. */
  function capturingEnv() {
    const prepared: string[] = [];
    const stmt = {
      bind(..._b: unknown[]) { return stmt; },
      async all() { return { results: [] }; },
      async first() { return null; },
      async run() { return { meta: { changes: 0 } }; },
    };
    const env = {
      DB: { prepare(sql: string) { prepared.push(sql); return stmt; }, async batch() { return []; } },
    } as unknown as Env;
    return { env, prepared };
  }

  async function commonsSql(): Promise<string> {
    const { env, prepared } = capturingEnv();
    await loadWorldBlocks(env, "cypher");
    const sql = prepared.find(s => s.includes("c.author = 'raziel'"));
    expect(sql, "the raziel-drops query should still exist").toBeTruthy();
    return sql!.replace(/\s+/g, " ");
  }

  it("joins the parent so the renderer has something to quote", async () => {
    const sql = await commonsSql();
    expect(sql).toContain("LEFT JOIN commons_posts p ON p.id = c.reply_to");
    expect(sql).toContain("p.author AS parent_author");
    expect(sql).toContain("p.body AS parent_body");
  });

  it("scopes a reply to the parent's author, with the two fallbacks spelled out", async () => {
    const sql = await commonsSql();
    // Scoped to this companion...
    expect(sql).toContain("p.author = ?1");
    // ...but a self-reply and an orphaned reply must reach all three rather than nobody. These two
    // clauses are the whole reason the predicate is not just `p.author = ?1`.
    expect(sql).toContain("p.author = 'raziel'");
    expect(sql).toContain("p.author IS NULL");
    // A fresh drop is not a reply and is never scoped.
    expect(sql).toContain("c.reply_to IS NULL");
  });

  it("still excludes posts this companion has already answered", async () => {
    const sql = await commonsSql();
    expect(sql).toContain("NOT IN (SELECT reply_to FROM commons_posts WHERE author = ?1");
  });
});
