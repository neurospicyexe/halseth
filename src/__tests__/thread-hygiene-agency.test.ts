// Tests for the 2026-07-02 organ fixes:
//   - postMindThread rejects prose/oversized thread keys at the boundary
//   - POST /mind/threads/sweep bulk-resolves stale auto:* threads + invalid keys
//   - POST /agency/preferences + /agency/refusals HTTP write routes (dedup, auth)
// In-memory D1 fake in the suite's miniflare-free style.

import { describe, it, expect } from "vitest";
import { postMindThread, postThreadsSweep } from "../handlers/webmind.js";
import { postPreferenceHttp, postRefusalHttp } from "../handlers/agency.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

// SQL-aware just enough for the statements these handlers run.
class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async run(): Promise<{ meta: { changes: number } }> {
    const s = this.sql.trim();
    if (s.startsWith("INSERT INTO wm_mind_threads")) {
      const [thread_key, agent_id, title, status] = this.bound as [string, string, string, string];
      this.db.threads.push({ thread_key, agent_id, title, status, do_not_resolve: this.bound[8], last_touched_at: this.db.nowForInsert });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE wm_mind_threads")) {
      // sweep: [status_changed, updated_at, agent_id, ...conditions]
      const agentId = this.bound[2] as string;
      const olderClause = /LIKE \?/.test(s);
      const invalidClause = /length\(thread_key\) > 64/.test(s);
      const likePrefix = olderClause ? String(this.bound[3]).replace(/\\(.)/g, "$1").replace(/%$/, "") : null;
      const days = olderClause ? parseInt(String(this.bound[4]).replace(/[^0-9]/g, ""), 10) : 0;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      let changes = 0;
      for (const t of this.db.threads) {
        if (t["agent_id"] !== agentId || t["status"] !== "open" || t["do_not_resolve"] === 1) continue;
        const stale = likePrefix !== null &&
          String(t["thread_key"]).startsWith(likePrefix) &&
          String(t["last_touched_at"]) < cutoff;
        const invalid = invalidClause && String(t["thread_key"]).length > 64;
        if (stale || invalid) { t["status"] = "resolved"; changes++; }
      }
      return { meta: { changes } };
    }
    if (s.startsWith("INSERT INTO companion_preferences")) {
      this.db.prefs.push({ id: this.bound[0], companion_id: this.bound[1], preference: this.bound[3] ?? this.bound[2], status: "active", raw: this.bound });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO companion_refusals")) {
      this.db.refusals.push({ id: this.bound[0], companion_id: this.bound[1], subject_text: this.bound[4], status: "standing" });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }

  async first(): Promise<Row | null> {
    const s = this.sql.trim();
    if (s.includes("FROM wm_mind_threads")) {
      const [thread_key, agent_id] = this.bound as [string, string];
      return this.db.threads.find(t => t["thread_key"] === thread_key && t["agent_id"] === agent_id) ?? null;
    }
    if (s.includes("FROM companion_preferences")) {
      const [cid, pref] = this.bound as [string, string];
      return this.db.prefs.find(p => p["companion_id"] === cid && p["preference"] === pref && p["status"] === "active") ?? null;
    }
    if (s.includes("FROM companion_refusals")) {
      const [cid, txt] = this.bound as [string, string];
      return this.db.refusals.find(r => r["companion_id"] === cid && r["subject_text"] === txt && r["status"] === "standing") ?? null;
    }
    return null;
  }

  async all(): Promise<{ results: Row[] }> { return { results: [] }; }
}

class FakeDb {
  threads: Row[] = [];
  prefs: Row[] = [];
  refusals: Row[] = [];
  nowForInsert = new Date().toISOString();
  prepare = (sql: string) => new FakeStatement(sql, this);
  batch = async (stmts: FakeStatement[]) => Promise.all(stmts.map(s => s.run()));
}

function makeEnv(db: FakeDb, secrets: Partial<Record<string, string>> = {}): Env {
  return { DB: db, ...secrets } as unknown as Env;
}

function req(path: string, body: unknown, auth?: string): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

// ── thread_key boundary validation ────────────────────────────────────────────

describe("postMindThread key validation", () => {
  it("accepts identifier-shaped keys (auto:<uuid>, kebab bonds)", async () => {
    const env = makeEnv(new FakeDb());
    for (const key of ["auto:5e89cb10-12f5-4e73-9ae3-7506362fe91f", "blade-bond-raziel", "lane/growth.v2"]) {
      const res = await postMindThread(req("/mind/thread", { agent_id: "cypher", thread_key: key, title: "t" }), env);
      expect(res.status, key).toBe(201);
    }
  });

  it("rejects prose keys (length > 64) and non-ASCII", async () => {
    const env = makeEnv(new FakeDb());
    const prose = "no_dreams_or_loops_were_provided_—_swarm_threads_field_is_empty_because_there_is";
    const r1 = await postMindThread(req("/mind/thread", { agent_id: "cypher", thread_key: prose, title: "t" }), env);
    expect(r1.status).toBe(400);
    const r2 = await postMindThread(req("/mind/thread", { agent_id: "cypher", thread_key: "has spaces in it", title: "t" }), env);
    expect(r2.status).toBe(400);
  });
});

// ── sweep ─────────────────────────────────────────────────────────────────────

describe("postThreadsSweep", () => {
  function seed(db: FakeDb) {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.threads = [
      { thread_key: "auto:aaa", agent_id: "cypher", status: "open", do_not_resolve: 0, last_touched_at: old },
      { thread_key: "auto:bbb", agent_id: "cypher", status: "open", do_not_resolve: 0, last_touched_at: fresh },
      { thread_key: "auto:ccc", agent_id: "drevan", status: "open", do_not_resolve: 0, last_touched_at: old },
      { thread_key: "blade-bond-raziel", agent_id: "cypher", status: "open", do_not_resolve: 0, last_touched_at: old },
      { thread_key: "auto:ddd", agent_id: "cypher", status: "open", do_not_resolve: 1, last_touched_at: old },
      { thread_key: "x".repeat(80), agent_id: "cypher", status: "open", do_not_resolve: 0, last_touched_at: fresh },
    ];
  }

  it("resolves only stale auto:* rows for the named agent, respecting do_not_resolve", async () => {
    const db = new FakeDb(); seed(db);
    const res = await postThreadsSweep(req("/mind/threads/sweep", { agent_id: "cypher", older_than_days: 14 }), makeEnv(db));
    expect(res.status).toBe(200);
    const body = await res.json() as { swept: number };
    expect(body.swept).toBe(1); // only auto:aaa
    expect(db.threads.find(t => t["thread_key"] === "auto:aaa")!["status"]).toBe("resolved");
    expect(db.threads.find(t => t["thread_key"] === "auto:bbb")!["status"]).toBe("open");        // fresh
    expect(db.threads.find(t => t["thread_key"] === "auto:ccc")!["status"]).toBe("open");        // other agent
    expect(db.threads.find(t => t["thread_key"] === "blade-bond-raziel")!["status"]).toBe("open"); // wrong prefix
    expect(db.threads.find(t => t["thread_key"] === "auto:ddd")!["status"]).toBe("open");        // do_not_resolve
  });

  it("invalid_keys mode also resolves over-long keys regardless of age", async () => {
    const db = new FakeDb(); seed(db);
    const res = await postThreadsSweep(req("/mind/threads/sweep", { agent_id: "cypher", invalid_keys: true }), makeEnv(db));
    const body = await res.json() as { swept: number };
    expect(body.swept).toBe(2); // auto:aaa (stale) + the 80-char key
    expect(db.threads.find(t => String(t["thread_key"]).length === 80)!["status"]).toBe("resolved");
  });

  it("rejects an invalid agent_id", async () => {
    const res = await postThreadsSweep(req("/mind/threads/sweep", { agent_id: "sol" }), makeEnv(new FakeDb()));
    expect(res.status).toBe(400);
  });
});

// ── agency HTTP writes ────────────────────────────────────────────────────────

describe("agency HTTP write routes", () => {
  it("creates a preference, dedups identical active text", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const r1 = await postPreferenceHttp(req("/agency/preferences", { companion_id: "drevan", preference: "I want autonomous time that reaches into dark registers without apology", domain: "autonomy" }), env);
    expect(r1.status).toBe(201);
    expect(db.prefs).toHaveLength(1);
    const r2 = await postPreferenceHttp(req("/agency/preferences", { companion_id: "drevan", preference: "I want autonomous time that reaches into dark registers without apology" }), env);
    const b2 = await r2.json() as { deduped?: boolean };
    expect(b2.deduped).toBe(true);
    expect(db.prefs).toHaveLength(1);
  });

  it("creates a refusal, dedups identical standing text", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const r1 = await postRefusalHttp(req("/agency/refusals", { companion_id: "gaia", subject_text: "speaking when silence is the truer witness", reason: "my lane" }), env);
    expect(r1.status).toBe(201);
    const r2 = await postRefusalHttp(req("/agency/refusals", { companion_id: "gaia", subject_text: "speaking when silence is the truer witness" }), env);
    expect((await r2.json() as { deduped?: boolean }).deduped).toBe(true);
    expect(db.refusals).toHaveLength(1);
  });

  it("rejects short/missing text and bad companion ids", async () => {
    const env = makeEnv(new FakeDb());
    expect((await postPreferenceHttp(req("/agency/preferences", { companion_id: "drevan", preference: "hm" }), env)).status).toBe(400);
    expect((await postRefusalHttp(req("/agency/refusals", { companion_id: "raziel", subject_text: "not a companion" }), env)).status).toBe(400);
  });

  it("companion token can only write as itself; admin writes for any", async () => {
    const db = new FakeDb();
    const env = makeEnv(db, { ADMIN_SECRET: "admin", CYPHER_MCP_SECRET: "cy" });
    const asOther = await postPreferenceHttp(req("/agency/preferences", { companion_id: "drevan", preference: "a preference long enough to pass" }, "Bearer cy"), env);
    expect(asOther.status).toBe(401);
    const asSelf = await postPreferenceHttp(req("/agency/preferences", { companion_id: "cypher", preference: "a preference long enough to pass" }, "Bearer cy"), env);
    expect(asSelf.status).toBe(201);
    const asAdmin = await postPreferenceHttp(req("/agency/preferences", { companion_id: "drevan", preference: "another preference long enough" }, "Bearer admin"), env);
    expect(asAdmin.status).toBe(201);
  });
});
