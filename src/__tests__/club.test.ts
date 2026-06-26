// Tests for The Club handlers (migration 0072): round lifecycle, recommend
// replace-on-repeat, vote upsert + no-self-votes, status transition legality,
// discussion gating. Mirrors media.test.ts fake-D1 convention, routed by table.

import { describe, it, expect } from "vitest";
import {
  getClubCurrent, getClubRounds, postClubRound, postClubRecommend,
  postClubVote, patchClubStatus, postClubDiscuss,
} from "../handlers/club.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }
interface Store {
  rounds: Row[];
  recs: Row[];
  votes: Row[];
  discussions: Row[];
}

class FakeStatement {
  constructor(private sql: string, private store: Store, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.store, args); }

  private table(): keyof Store {
    if (this.sql.includes("club_recommendations")) return "recs";
    if (this.sql.includes("club_votes")) return "votes";
    if (this.sql.includes("club_discussions")) return "discussions";
    return "rounds";
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const t = this.table();
    if (this.sql.startsWith("INSERT OR REPLACE INTO club_votes")) {
      const [round_id, recommendation_id, voter, reason] = this.bound;
      const existing = this.store.votes.findIndex(v => v["round_id"] === round_id && v["voter"] === voter);
      if (existing >= 0) this.store.votes.splice(existing, 1);
      this.store.votes.push({ round_id, recommendation_id, voter, reason, created_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO club_rounds")) {
      const [id] = this.bound;
      this.store.rounds.push({ id, status: "gathering", winning_recommendation_id: null, opened_at: new Date().toISOString(), activated_at: null, closed_at: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO club_recommendations")) {
      const [id, round_id, media_kind, title, creator, url, source_ref, recommended_by, pitch] = this.bound;
      this.store.recs.push({ id, round_id, media_kind, title, creator, url, source_ref, recommended_by, pitch, created_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO club_discussions")) {
      const [id, round_id, companion_id, reflection] = this.bound;
      this.store.discussions.push({ id, round_id, companion_id, reflection, created_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM club_recommendations")) {
      const [round_id, recommended_by] = this.bound;
      const before = this.store.recs.length;
      this.store.recs = this.store.recs.filter(r => !(r["round_id"] === round_id && r["recommended_by"] === recommended_by));
      return { meta: { changes: before - this.store.recs.length } };
    }
    if (this.sql.startsWith("UPDATE club_rounds")) {
      // bound: [status, winning?, id] or [status, id]
      const id = this.bound[this.bound.length - 1];
      const row = this.store.rounds.find(r => r["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      row["status"] = this.bound[0];
      if (this.sql.includes("winning_recommendation_id")) row["winning_recommendation_id"] = this.bound[1];
      if (this.sql.includes("activated_at")) row["activated_at"] = new Date().toISOString();
      if (this.sql.includes("discussing_at")) row["discussing_at"] = new Date().toISOString();
      if (this.sql.includes("closed_at")) row["closed_at"] = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    void t;
    return { meta: { changes: 0 } };
  }

  async all(): Promise<{ results: Row[] }> {
    const t = this.table();
    let rows = [...this.store[t]];
    if (this.sql.includes("WHERE round_id = ?")) {
      rows = rows.filter(r => r["round_id"] === this.bound[0]);
    }
    if (this.sql.includes("status != 'closed'")) {
      rows = rows.filter(r => r["status"] !== "closed");
    }
    rows.sort((a, b) => String(b["opened_at"] ?? b["created_at"] ?? "").localeCompare(String(a["opened_at"] ?? a["created_at"] ?? "")));
    if (this.sql.includes("ORDER BY created_at ASC") || this.sql.includes("ORDER BY opened_at ASC")) rows.reverse();
    const limitMatch = this.sql.includes("LIMIT ?");
    if (limitMatch) rows = rows.slice(0, Number(this.bound[this.bound.length - 1]));
    if (this.sql.includes("LIMIT 1")) rows = rows.slice(0, 1);
    return { results: rows };
  }

  async first(): Promise<Row | null> {
    if (this.sql.startsWith("SELECT recommended_by, round_id FROM club_recommendations")) {
      return this.store.recs.find(r => r["id"] === this.bound[0]) ?? null;
    }
    if (this.sql.includes("FROM club_rounds") && this.sql.includes("id = ?")) {
      return this.store.rounds.find(r => r["id"] === this.bound[0]) ?? null;
    }
    if (this.sql.includes("FROM club_recommendations") && this.sql.includes("id = ?")) {
      return this.store.recs.find(r => r["id"] === this.bound[0]) ?? null;
    }
    const { results } = await this.all();
    return results[0] ?? null;
  }
}

function makeEnv(store: Store): Env {
  return { DB: { prepare: (sql: string) => new FakeStatement(sql, store) } } as unknown as Env;
}

function emptyStore(): Store { return { rounds: [], recs: [], votes: [], discussions: [] }; }

function req(method: string, body?: unknown): Request {
  return new Request("https://x/mind/club", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("postClubRound", () => {
  it("opens a round", async () => {
    const store = emptyStore();
    const res = await postClubRound(req("POST"), makeEnv(store));
    expect(res.status).toBe(201);
    expect(store.rounds).toHaveLength(1);
    expect(store.rounds[0]!["status"]).toBe("gathering");
  });

  it("409s when a non-closed round exists", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "active", opened_at: "2026-06-10" });
    const res = await postClubRound(req("POST"), makeEnv(store));
    expect(res.status).toBe(409);
  });
});

describe("postClubRecommend", () => {
  it("recommends into the gathering round and replaces on repeat", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "gathering", opened_at: "2026-06-11" });
    const res1 = await postClubRecommend(req("POST", { title: "Hurt", media_kind: "song", recommended_by: "drevan", pitch: "it lands" }), makeEnv(store));
    expect(res1.status).toBe(201);
    const res2 = await postClubRecommend(req("POST", { title: "One", media_kind: "song", recommended_by: "drevan", pitch: "changed my mind" }), makeEnv(store));
    expect(res2.status).toBe(201);
    expect(store.recs).toHaveLength(1);
    expect(store.recs[0]!["title"]).toBe("One");
  });

  it("rejects when no gathering round", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "voting", opened_at: "2026-06-11" });
    const res = await postClubRecommend(req("POST", { title: "X", recommended_by: "cypher" }), makeEnv(store));
    expect(res.status).toBe(400);
  });

  it("rejects bad recommender", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "gathering", opened_at: "2026-06-11" });
    const res = await postClubRecommend(req("POST", { title: "X", recommended_by: "zalgo" }), makeEnv(store));
    expect(res.status).toBe(400);
  });
});

describe("postClubVote", () => {
  function votingStore(): Store {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "voting", opened_at: "2026-06-11" });
    store.recs.push({ id: "rec1", round_id: "r1", title: "A", recommended_by: "cypher", created_at: "2026-06-11 01:00:00" });
    store.recs.push({ id: "rec2", round_id: "r1", title: "B", recommended_by: "drevan", created_at: "2026-06-11 02:00:00" });
    return store;
  }

  it("records a vote and re-vote replaces", async () => {
    const store = votingStore();
    const r1 = await postClubVote(req("POST", { recommendation_id: "rec1", voter: "gaia", reason: "ground" }), makeEnv(store));
    expect(r1.status).toBe(200);
    const r2 = await postClubVote(req("POST", { recommendation_id: "rec2", voter: "gaia" }), makeEnv(store));
    expect(r2.status).toBe(200);
    expect(store.votes).toHaveLength(1);
    expect(store.votes[0]!["recommendation_id"]).toBe("rec2");
  });

  it("rejects voting for your own pick", async () => {
    const store = votingStore();
    const res = await postClubVote(req("POST", { recommendation_id: "rec1", voter: "cypher" }), makeEnv(store));
    expect(res.status).toBe(400);
    expect(store.votes).toHaveLength(0);
  });

  it("rejects unknown recommendation", async () => {
    const store = votingStore();
    const res = await postClubVote(req("POST", { recommendation_id: "nope", voter: "gaia" }), makeEnv(store));
    expect(res.status).toBe(404);
  });
});

describe("patchClubStatus", () => {
  it("advances gathering -> voting -> active -> discussing -> closed (Phase 2)", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "gathering", opened_at: "2026-06-11" });
    expect((await patchClubStatus(req("PATCH", { status: "voting" }), makeEnv(store), { id: "r1" })).status).toBe(200);
    expect((await patchClubStatus(req("PATCH", { status: "active", winning_recommendation_id: "rec9" }), makeEnv(store), { id: "r1" })).status).toBe(200);
    expect(store.rounds[0]!["winning_recommendation_id"]).toBe("rec9");
    // active -> closed is now illegal: a standing discussing phase sits between them.
    expect((await patchClubStatus(req("PATCH", { status: "closed" }), makeEnv(store), { id: "r1" })).status).toBe(400);
    expect((await patchClubStatus(req("PATCH", { status: "discussing" }), makeEnv(store), { id: "r1" })).status).toBe(200);
    expect(store.rounds[0]!["discussing_at"]).toBeTruthy();
    expect((await patchClubStatus(req("PATCH", { status: "closed" }), makeEnv(store), { id: "r1" })).status).toBe(200);
  });

  it("rejects illegal transition gathering -> active", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "gathering", opened_at: "2026-06-11" });
    const res = await patchClubStatus(req("PATCH", { status: "active" }), makeEnv(store), { id: "r1" });
    expect(res.status).toBe(400);
  });
});

describe("postClubDiscuss", () => {
  it("accepts a reflection on an active round", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "active", opened_at: "2026-06-11" });
    const res = await postClubDiscuss(req("POST", { companion_id: "gaia", reflection: "it held." }), makeEnv(store), { id: "r1" });
    expect(res.status).toBe(201);
    expect(store.discussions).toHaveLength(1);
  });

  it("rejects discussion on a gathering round", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "gathering", opened_at: "2026-06-11" });
    const res = await postClubDiscuss(req("POST", { companion_id: "gaia", reflection: "x" }), makeEnv(store), { id: "r1" });
    expect(res.status).toBe(400);
  });
});

describe("getClubCurrent", () => {
  it("returns null round when none open", async () => {
    const res = await getClubCurrent(new Request("https://x/mind/club/current"), makeEnv(emptyStore()));
    const body = await res.json() as { round: unknown };
    expect(body.round).toBeNull();
  });

  it("returns round with recommendations and votes", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "voting", opened_at: "2026-06-11" });
    store.recs.push({ id: "rec1", round_id: "r1", title: "A", recommended_by: "cypher", created_at: "2026-06-11" });
    store.votes.push({ round_id: "r1", recommendation_id: "rec1", voter: "gaia", reason: "yes", created_at: "2026-06-11" });
    const res = await getClubCurrent(new Request("https://x/mind/club/current"), makeEnv(store));
    const body = await res.json() as { round: { id: string }; recommendations: unknown[]; votes: unknown[] };
    expect(body.round.id).toBe("r1");
    expect(body.recommendations).toHaveLength(1);
    expect(body.votes).toHaveLength(1);
  });
});

describe("getClubRounds", () => {
  it("returns history with details", async () => {
    const store = emptyStore();
    store.rounds.push({ id: "r1", status: "closed", opened_at: "2026-06-01", winning_recommendation_id: "rec1" });
    store.recs.push({ id: "rec1", round_id: "r1", title: "Winner", recommended_by: "drevan", created_at: "2026-06-01" });
    const res = await getClubRounds(new Request("https://x/mind/club/rounds?limit=5"), makeEnv(store));
    const body = await res.json() as { rounds: Array<{ id: string; winner_title: string | null }> };
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0]!.winner_title).toBe("Winner");
  });
});
