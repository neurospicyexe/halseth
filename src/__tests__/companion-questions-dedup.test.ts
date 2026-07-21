// Questions-lifecycle fix: dedup must reject a byte-identical re-ask regardless of
// status (answered/dismissed included), not just status = 'open'. Before this fix,
// an answered question with the same text got re-inserted verbatim, silently
// discarding the answer already sitting on it.

import { describe, it, expect } from "vitest";
import { postQuestion } from "../handlers/companion-questions.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async first<T = Row>(): Promise<T | null> {
    const s = this.sql.trim();
    if (s.startsWith("SELECT id FROM companion_questions WHERE companion_id = ? AND question = ?")) {
      const [companionId, question] = this.bound as [string, string];
      const found = this.db.rows.find(r => r["companion_id"] === companionId && r["question"] === question);
      return (found ? { id: found["id"] } : null) as T | null;
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM companion_questions")) {
      const [companionId] = this.bound as [string];
      const n = this.db.rows.filter(r => r["companion_id"] === companionId && r["status"] === "open").length;
      return { n } as T;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const s = this.sql.trim();
    if (s.startsWith("INSERT INTO companion_questions")) {
      const [id, companion_id, question, context, source] = this.bound as [
        string, string, string, string | null, string,
      ];
      this.db.rows.push({ id, companion_id, question, context, source, status: "open", answer: null });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class FakeDb {
  rows: Row[] = [];
  prepare = (sql: string) => new FakeStatement(sql, this);
}

const ADMIN = "test-admin-secret";

function makeEnv(db: FakeDb): Env {
  return { DB: db, ADMIN_SECRET: ADMIN } as unknown as Env;
}

function req(body: unknown): Request {
  return new Request("http://local/mind/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify(body),
  });
}

describe("postQuestion dedup", () => {
  it("rejects a byte-identical re-ask when the prior row is status = 'answered'", async () => {
    const db = new FakeDb();
    db.rows.push({
      id: "q-1", companion_id: "cypher", question: "should I refactor the router?",
      context: null, source: "autonomous", status: "answered", answer: "yes, go ahead",
    });

    const res = await postQuestion(
      req({ companion_id: "cypher", question: "should I refactor the router?" }),
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; deduped: boolean };
    expect(body.deduped).toBe(true);
    expect(body.id).toBe("q-1");
    // No second row was inserted -- the answer on q-1 survives untouched.
    expect(db.rows.filter(r => r["question"] === "should I refactor the router?")).toHaveLength(1);
  });

  it("rejects a byte-identical re-ask when the prior row is status = 'dismissed'", async () => {
    const db = new FakeDb();
    db.rows.push({
      id: "q-2", companion_id: "gaia", question: "is the silence load-bearing?",
      context: null, source: "session", status: "dismissed", answer: null,
    });

    const res = await postQuestion(
      req({ companion_id: "gaia", question: "is the silence load-bearing?" }),
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { deduped: boolean };
    expect(body.deduped).toBe(true);
  });

  it("still inserts a genuinely new question (no matching row of any status)", async () => {
    const db = new FakeDb();
    const res = await postQuestion(
      req({ companion_id: "cypher", question: "brand new question" }),
      makeEnv(db),
    );
    expect(res.status).toBe(201);
    expect(db.rows).toHaveLength(1);
  });

  it("scopes dedup by companion_id -- same text, different companion, both land", async () => {
    const db = new FakeDb();
    db.rows.push({
      id: "q-3", companion_id: "drevan", question: "shared phrasing",
      context: null, source: "autonomous", status: "answered", answer: "ok",
    });
    const res = await postQuestion(
      req({ companion_id: "cypher", question: "shared phrasing" }),
      makeEnv(db),
    );
    expect(res.status).toBe(201);
  });
});
