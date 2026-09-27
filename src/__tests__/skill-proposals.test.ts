// Tests for the Hermes skill-proposal mirror (mig 0107): handlers
// (POST ingest + external_id idempotency, GET list, PATCH decision) and the
// librarian read executor. Same miniflare-free FakeStatement harness as
// forage.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { postSkillProposal, listSkillProposals, decideSkillProposal } from "../handlers/skill-proposals.js";
import { execSkillProposalsRead } from "../librarian/executors/reads.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(
    private sql: string,
    private store: Row[],
    private bound: unknown[] = [],
  ) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.store, args);
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT")) {
      const [id, external_id, companion_id, hermes_home, skill_name, action, summary, content] =
        this.bound as [string, string | null, string, string | null, string, string, string | null, string | null];
      if (external_id !== null && this.store.some(r => r["external_id"] === external_id)) {
        throw new Error("UNIQUE constraint failed: skill_proposals.external_id");
      }
      this.store.push({
        id, external_id, companion_id, hermes_home, skill_name, action, summary, content,
        status: "staged", decided_by: null, decision_note: null,
        staged_at: new Date().toISOString(), decided_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE")) {
      const [status, decided_by, note, id, external_id] =
        this.bound as [string, string, string | null, string, string];
      const row = this.store.find(r => (r["id"] === id || r["external_id"] === external_id) && r["status"] === "staged");
      if (!row) return { meta: { changes: 0 } };
      row["status"] = status;
      row["decided_by"] = decided_by;
      row["decision_note"] = note;
      row["decided_at"] = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async all(): Promise<{ results: Row[] }> {
    // Librarian executor path: staged only, no bindings.
    if (this.bound.length === 0) {
      return { results: this.store.filter(r => r["status"] === "staged") };
    }
    // Handler list path: conditions built from (status?, companion_id?, limit).
    const bindings = [...this.bound];
    const limit = bindings.pop() as number;
    let results = [...this.store];
    if (this.sql.includes("status = ?")) {
      const status = bindings.shift() as string;
      results = results.filter(r => r["status"] === status);
    }
    if (this.sql.includes("companion_id = ?")) {
      const companion = bindings.shift() as string;
      results = results.filter(r => r["companion_id"] === companion);
    }
    return { results: results.slice(0, limit) };
  }
  async first(): Promise<Row | null> {
    const [id, external_id] = this.bound as [string, string | undefined];
    return this.store.find(r => r["id"] === id || r["external_id"] === (external_id ?? id)) ?? null;
  }
}

const ADMIN_SECRET = "test-admin-secret";

function makeEnv(store: Row[]): Env {
  return {
    DB: { prepare: (sql: string) => new FakeStatement(sql, store) },
    ADMIN_SECRET,
  } as unknown as Env;
}

function req(method: string, body?: unknown, url = "http://local/mind/skill-proposals"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const STAGE_BODY = {
  external_id: "stage-001",
  companion_id: "drevan",
  hermes_home: "drevan",
  skill_name: "fargo-watch-notes",
  action: "create",
  summary: "Capture per-episode watch notes with speaker attribution.",
  content: "# fargo-watch-notes\n...",
};

describe("skill-proposal handlers", () => {
  let store: Row[];
  let env: Env;
  beforeEach(() => {
    store = [];
    env = makeEnv(store);
  });

  it("POST stages a proposal and returns 201", async () => {
    const res = await postSkillProposal(req("POST", STAGE_BODY), env);
    expect(res.status).toBe(201);
    expect(store).toHaveLength(1);
    expect(store[0]!["status"]).toBe("staged");
  });

  it("POST same external_id twice dedupes instead of 500 (watcher re-post)", async () => {
    await postSkillProposal(req("POST", STAGE_BODY), env);
    const res2 = await postSkillProposal(req("POST", STAGE_BODY), env);
    expect(res2.status).toBe(200);
    const data = await res2.json() as { deduped?: boolean; id?: string };
    expect(data.deduped).toBe(true);
    expect(data.id).toBeTruthy();
    expect(store).toHaveLength(1);
  });

  it("POST rejects bad companion_id, missing skill_name, bad action", async () => {
    expect((await postSkillProposal(req("POST", { ...STAGE_BODY, companion_id: "raziel" }), env)).status).toBe(400);
    expect((await postSkillProposal(req("POST", { ...STAGE_BODY, skill_name: "" }), env)).status).toBe(400);
    expect((await postSkillProposal(req("POST", { ...STAGE_BODY, action: "delete" }), env)).status).toBe(400);
  });

  it("GET defaults to staged and filters by companion_id", async () => {
    await postSkillProposal(req("POST", STAGE_BODY), env);
    await postSkillProposal(req("POST", { ...STAGE_BODY, external_id: "stage-002", companion_id: "cypher", skill_name: "audit-register" }), env);
    const res = await listSkillProposals(req("GET", undefined, "http://local/mind/skill-proposals?companion_id=cypher"), env);
    expect(res.status).toBe(200);
    const data = await res.json() as { proposals: Row[] };
    expect(data.proposals).toHaveLength(1);
    expect(data.proposals[0]!["skill_name"]).toBe("audit-register");
  });

  it("GET rejects an unknown status value", async () => {
    const res = await listSkillProposals(req("GET", undefined, "http://local/mind/skill-proposals?status=bogus"), env);
    expect(res.status).toBe(400);
  });

  it("PATCH decides by external_id, then 409 on a replayed decision", async () => {
    await postSkillProposal(req("POST", STAGE_BODY), env);
    const res = await decideSkillProposal(
      req("PATCH", { status: "approved", decided_by: "raziel" }),
      env, { id: "stage-001" },
    );
    expect(res.status).toBe(200);
    expect(store[0]!["status"]).toBe("approved");

    const replay = await decideSkillProposal(
      req("PATCH", { status: "declined" }),
      env, { id: "stage-001" },
    );
    expect(replay.status).toBe(409);
    expect(store[0]!["status"]).toBe("approved");
  });

  it("PATCH on an unknown id returns 404; bad status returns 400", async () => {
    expect((await decideSkillProposal(req("PATCH", { status: "approved" }), env, { id: "nope" })).status).toBe(404);
    expect((await decideSkillProposal(req("PATCH", { status: "maybe" }), env, { id: "x" })).status).toBe(400);
  });

  it("unauthenticated requests are denied", async () => {
    const res = await postSkillProposal(new Request("http://local/mind/skill-proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(STAGE_BODY),
    }), env);
    expect(res.status).toBe(401);
  });
});

describe("execSkillProposalsRead", () => {
  it("returns only staged proposals, triad-wide", async () => {
    const store: Row[] = [];
    const env = makeEnv(store);
    await postSkillProposal(req("POST", STAGE_BODY), env);
    await postSkillProposal(req("POST", { ...STAGE_BODY, external_id: "stage-002", companion_id: "cypher", skill_name: "audit-register" }), env);
    await decideSkillProposal(req("PATCH", { status: "declined" }), env, { id: "stage-002" });

    const ctx = { env, req: { request: "skill proposals", companion_id: "gaia" } } as unknown as ExecutorContext;
    const result = await execSkillProposalsRead(ctx) as { proposals: Array<{ skill_name: string; companion_id: string }>; meta: { count: number } };
    expect(result.meta.count).toBe(1);
    expect(result.proposals[0]!.skill_name).toBe("fargo-watch-notes");
    expect(result.proposals[0]!.companion_id).toBe("drevan");
  });
});
