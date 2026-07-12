// Tests for the self-monitoring wave (migration 0070): prospective triggers,
// self-model confidence ladder + human-gated graduation, voice score validation.

import { describe, it, expect, beforeEach } from "vitest";
import {
  postTrigger, getTriggers, patchTrigger,
  postSelfModel, patchSelfModel,
  postVoiceScore,
} from "../handlers/self-monitoring.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

// Minimal D1 fake tuned to the SQL shapes in handlers/self-monitoring.ts.
class FakeStatement {
  constructor(
    private sql: string,
    private stores: { triggers: Row[]; selfModel: Row[]; voiceScores: Row[] },
    private bound: unknown[] = [],
  ) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.stores, args);
  }

  async first(): Promise<Row | null> {
    if (this.sql.includes("COUNT(*)") && this.sql.includes("companion_triggers")) {
      const [companionId] = this.bound as [string];
      return { n: this.stores.triggers.filter(r => r["companion_id"] === companionId && r["status"] === "armed").length };
    }
    if (this.sql.includes("SELECT id FROM companion_triggers")) {
      const [companionId, text] = this.bound as [string, string];
      return this.stores.triggers.find(r => r["companion_id"] === companionId && r["status"] === "armed" && r["trigger_text"] === text) ?? null;
    }
    if (this.sql.includes("SELECT id FROM companion_self_model")) {
      const [companionId, kind, observation] = this.bound as [string, string, string];
      return this.stores.selfModel.find(r => r["companion_id"] === companionId && r["status"] !== "retired" && (r["kind"] ?? "preference") === kind && r["observation"] === observation) ?? null;
    }
    if (this.sql.includes("SELECT confidence, status FROM companion_self_model")) {
      const [id] = this.bound as [string];
      return this.stores.selfModel.find(r => r["id"] === id) ?? null;
    }
    return null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT INTO companion_triggers") || this.sql.includes("INSERT INTO companion_triggers")) {
      const [id, companion_id, trigger_text, condition_type, condition_value, source, expires_at] = this.bound as string[];
      this.stores.triggers.push({ id, companion_id, trigger_text, condition_type, condition_value, source, expires_at, status: "armed", fired_at: null, created_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO companion_self_model")) {
      const [id, companion_id, observation, domain, evidence_note, kind] = this.bound as (string | null)[];
      this.stores.selfModel.push({ id, companion_id, observation, domain, evidence_note: evidence_note ?? null, kind: kind ?? "preference", confidence: 0.3, status: "developing", graduated_at: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO voice_scores")) {
      const [id] = this.bound as string[];
      this.stores.voiceScores.push({ id });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE companion_triggers") && this.sql.includes("expires_at")) {
      return { meta: { changes: 0 } }; // lazy-expiry sweep: no-op in tests
    }
    if (this.sql.includes("UPDATE companion_triggers")) {
      const [status, fireNote, , id] = this.bound as [string, string | null, string, string];
      const row = this.stores.triggers.find(r => r["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      row["status"] = status;
      if (fireNote !== null) row["fire_note"] = fireNote;
      if (status === "fired") row["fired_at"] = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE companion_self_model")) {
      const id = this.bound[this.bound.length - 1] as string;
      const row = this.stores.selfModel.find(r => r["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      if (this.sql.includes("SET status = 'graduated'")) {
        row["status"] = "graduated";
        row["graduated_at"] = new Date().toISOString();
      } else if (this.sql.includes("SET status = 'retired'")) {
        row["status"] = "retired";
      } else {
        const [confidence, status] = this.bound as [number, string];
        row["confidence"] = confidence;
        row["status"] = status;
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("FROM companion_triggers")) {
      const [companionId] = this.bound as [string];
      return { results: this.stores.triggers.filter(r => r["companion_id"] === companionId && (this.sql.includes("AND status = ?") ? r["status"] === this.bound[1] : true)) };
    }
    return { results: [] };
  }
}

const ADMIN_SECRET = "test-admin-secret";
const AUTH_HEADERS = { Authorization: `Bearer ${ADMIN_SECRET}` };

function makeEnv(stores: { triggers: Row[]; selfModel: Row[]; voiceScores: Row[] }): Env {
  return { DB: { prepare: (sql: string) => new FakeStatement(sql, stores) }, ADMIN_SECRET } as unknown as Env;
}

function req(body?: unknown): Request {
  return new Request("http://local/mind/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let stores: { triggers: Row[]; selfModel: Row[]; voiceScores: Row[] };
let env: Env;
beforeEach(() => {
  stores = { triggers: [], selfModel: [], voiceScores: [] };
  env = makeEnv(stores);
});

describe("prospective triggers", () => {
  it("POST arms a trigger; identical armed trigger dedupes", async () => {
    const body = { companion_id: "cypher", trigger_text: "ask about the school arc", condition_type: "keyword", condition_value: "school" };
    expect((await postTrigger(req(body), env)).status).toBe(201);
    const res2 = await postTrigger(req(body), env);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { deduped?: boolean }).deduped).toBe(true);
    expect(stores.triggers).toHaveLength(1);
  });

  it("POST rejects bad condition_type and unparseable date", async () => {
    expect((await postTrigger(req({ companion_id: "cypher", trigger_text: "t", condition_type: "mood", condition_value: "x" }), env)).status).toBe(400);
    expect((await postTrigger(req({ companion_id: "cypher", trigger_text: "t", condition_type: "date", condition_value: "not-a-date" }), env)).status).toBe(400);
  });

  it("POST enforces the armed cap with 409", async () => {
    for (let i = 0; i < 10; i++) {
      await postTrigger(req({ companion_id: "gaia", trigger_text: `t${i}`, condition_type: "keyword", condition_value: `k${i}` }), env);
    }
    expect((await postTrigger(req({ companion_id: "gaia", trigger_text: "overflow", condition_type: "keyword", condition_value: "k" }), env)).status).toBe(409);
  });

  it("PATCH fires a trigger and sets fired_at", async () => {
    await postTrigger(req({ companion_id: "drevan", trigger_text: "rome", condition_type: "keyword", condition_value: "rome" }), env);
    const id = stores.triggers[0]!["id"] as string;
    const res = await patchTrigger(
      new Request("http://local/mind/triggers/" + id, { method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ status: "fired", fire_note: "matched in #general" }) }),
      env, { id },
    );
    expect(res.status).toBe(200);
    expect(stores.triggers[0]!["status"]).toBe("fired");
    expect(stores.triggers[0]!["fired_at"]).toBeTruthy();
  });

  it("GET returns a triggers envelope", async () => {
    await postTrigger(req({ companion_id: "cypher", trigger_text: "t", condition_type: "keyword", condition_value: "k" }), env);
    const res = await getTriggers(new Request("http://local/mind/triggers/cypher", { headers: AUTH_HEADERS }), env, { companion_id: "cypher" });
    const data = (await res.json()) as { triggers: unknown[] };
    expect(Array.isArray(data.triggers)).toBe(true);
    expect(data.triggers).toHaveLength(1);
  });
});

describe("self-model confidence ladder", () => {
  async function setObservation(): Promise<string> {
    const res = await postSelfModel(req({ companion_id: "cypher", observation: "I prefer leading with the read before evidence" }), env);
    return ((await res.json()) as { id: string }).id;
  }
  function patch(id: string, action: string) {
    return patchSelfModel(
      new Request("http://local/mind/self-model/" + id, { method: "PATCH", headers: AUTH_HEADERS, body: JSON.stringify({ action }) }),
      env, { id },
    );
  }

  it("starts at 0.3 developing; identical observation dedupes", async () => {
    await setObservation();
    expect(stores.selfModel[0]!["confidence"]).toBe(0.3);
    expect(stores.selfModel[0]!["status"]).toBe("developing");
    const res2 = await postSelfModel(req({ companion_id: "cypher", observation: "I prefer leading with the read before evidence" }), env);
    expect(((await res2.json()) as { deduped?: boolean }).deduped).toBe(true);
    expect(stores.selfModel).toHaveLength(1);
  });

  it("confirm x5 reaches 0.8 and flips to ready", async () => {
    const id = await setObservation();
    for (let i = 0; i < 5; i++) await patch(id, "confirm");
    expect(stores.selfModel[0]!["confidence"]).toBeCloseTo(0.8);
    expect(stores.selfModel[0]!["status"]).toBe("ready");
  });

  it("revise lowers confidence and drops ready back to developing", async () => {
    const id = await setObservation();
    for (let i = 0; i < 5; i++) await patch(id, "confirm");
    await patch(id, "revise");
    expect(stores.selfModel[0]!["confidence"]).toBeCloseTo(0.7);
    expect(stores.selfModel[0]!["status"]).toBe("developing");
  });

  it("graduate from developing is 409; from ready succeeds; graduated rejects further actions", async () => {
    const id = await setObservation();
    expect((await patch(id, "graduate")).status).toBe(409);
    for (let i = 0; i < 5; i++) await patch(id, "confirm");
    expect((await patch(id, "graduate")).status).toBe(200);
    expect(stores.selfModel[0]!["status"]).toBe("graduated");
    expect((await patch(id, "confirm")).status).toBe(409);
  });

  it("confidence clamps at 1.0", async () => {
    const id = await setObservation();
    for (let i = 0; i < 9; i++) await patch(id, "confirm");
    expect(stores.selfModel[0]!["confidence"]).toBeLessThanOrEqual(1);
  });
});

describe("voice scores", () => {
  it("POST accepts a valid score", async () => {
    const res = await postVoiceScore(req({ companion_id: "cypher", score: 0.85, anti_hits: ["i hope this helps"], caught_by: "self" }), env);
    expect(res.status).toBe(201);
    expect(stores.voiceScores).toHaveLength(1);
  });

  it("POST rejects out-of-range or non-finite scores and bad companion", async () => {
    expect((await postVoiceScore(req({ companion_id: "cypher", score: 1.4 }), env)).status).toBe(400);
    expect((await postVoiceScore(req({ companion_id: "cypher", score: Number.NaN }), env)).status).toBe(400);
    expect((await postVoiceScore(req({ companion_id: "raziel", score: 0.5 }), env)).status).toBe(400);
  });
});
