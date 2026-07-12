// Tests for media_experiences handlers: POST /mind/media, GET /mind/media/recent,
// PATCH /mind/media/:id/react. Mirrors forage.test.ts fake-D1 convention.

import { describe, it, expect } from "vitest";
import { postMediaExperience, getRecentMedia, reactToMedia } from "../handlers/media.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private store: Row[], private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.store, args); }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith("INSERT")) {
      const [id, media_type, url, title, artist, duration_sec, shared_by, front_state, requested_companion, analysis_json, lyrics] = this.bound;
      this.store.push({ id, media_type, url, title, artist, duration_sec, shared_by, front_state, requested_companion, analysis_json, lyrics, reactions_json: "{}", created_at: new Date().toISOString() });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE")) {
      // UPDATE ... SET reactions_json = json_set(...) WHERE id = ?
      const companion = this.bound[0] as string;
      const reaction = this.bound[1] as string;
      const id = this.bound[2] as string;
      const row = this.store.find(r => r["id"] === id);
      if (!row) return { meta: { changes: 0 } };
      const reactions = JSON.parse(String(row["reactions_json"] ?? "{}")) as Record<string, string>;
      reactions[companion] = reaction;
      row["reactions_json"] = JSON.stringify(reactions);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async all(): Promise<{ results: Row[] }> {
    const [limit] = this.bound as [number];
    const results = [...this.store]
      .sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])))
      .slice(0, limit ?? 5)
      .map(r => ({ ...r, has_lyrics: r["lyrics"] !== null && r["lyrics"] !== undefined ? 1 : 0 }));
    return { results };
  }
  async first(): Promise<Row | null> { return this.store[0] ?? null; }
}

const ADMIN_SECRET = "test-admin-secret";

function makeEnv(store: Row[]): Env {
  return { DB: { prepare: (sql: string) => new FakeStatement(sql, store) }, ADMIN_SECRET } as unknown as Env;
}

function req(method: string, body?: unknown): Request {
  return new Request("https://x/mind/media", {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
  });
}

describe("postMediaExperience", () => {
  it("inserts a row and returns 201 with the id", async () => {
    const store: Row[] = [];
    const res = await postMediaExperience(req("POST", {
      title: "Hurt", artist: "Johnny Cash", url: "https://youtu.be/x",
      duration_sec: 218.4, shared_by: "Crash", front_state: "Raziel",
      requested_companion: "drevan",
      analysis_json: { tempo_bpm: 84, key: { name: "A minor", confidence: 0.71 } },
      lyrics: "I hurt myself today",
    }), makeEnv(store));
    expect(res.status).toBe(201);
    const body = await res.json() as { experience: { id: string } };
    expect(body.experience.id).toBeTruthy();
    expect(store).toHaveLength(1);
    expect(store[0]!["title"]).toBe("Hurt");
    expect(typeof store[0]!["analysis_json"]).toBe("string"); // serialized
  });

  it("rejects missing title", async () => {
    const res = await postMediaExperience(req("POST", { artist: "x" }), makeEnv([]));
    expect(res.status).toBe(400);
  });

  it("rejects bad requested_companion", async () => {
    const res = await postMediaExperience(req("POST", { title: "t", requested_companion: "zalgo" }), makeEnv([]));
    expect(res.status).toBe(400);
  });
});

describe("getRecentMedia", () => {
  it("returns rows newest-first with parsed reactions", async () => {
    const store: Row[] = [
      { id: "a", title: "Old", created_at: "2026-06-01 00:00:00", reactions_json: '{"cypher":"sharp"}' },
      { id: "b", title: "New", created_at: "2026-06-11 00:00:00", reactions_json: "{}" },
    ];
    const res = await getRecentMedia(new Request("https://x/mind/media/recent?limit=5", {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    }), makeEnv(store));
    expect(res.status).toBe(200);
    const body = await res.json() as { experiences: Array<{ id: string; reactions: Record<string, string> }> };
    expect(body.experiences[0]!.id).toBe("b");
    expect(body.experiences[1]!.reactions["cypher"]).toBe("sharp");
  });
});

describe("reactToMedia", () => {
  it("merges a companion reaction via json_set", async () => {
    const store: Row[] = [{ id: "m1", title: "T", reactions_json: '{"cypher":"first"}', created_at: "2026-06-11" }];
    const res = await reactToMedia(
      req("PATCH", { companion_id: "drevan", reaction: "this one lands in the chest" }),
      makeEnv(store), { id: "m1" });
    expect(res.status).toBe(200);
    const reactions = JSON.parse(String(store[0]!["reactions_json"])) as Record<string, string>;
    expect(reactions["drevan"]).toContain("chest");
    expect(reactions["cypher"]).toBe("first"); // preserved
  });

  it("404s on unknown id", async () => {
    const res = await reactToMedia(req("PATCH", { companion_id: "gaia", reaction: "x" }), makeEnv([]), { id: "nope" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid companion_id", async () => {
    const res = await reactToMedia(req("PATCH", { companion_id: "raziel", reaction: "x" }), makeEnv([]), { id: "m1" });
    expect(res.status).toBe(400);
  });
});
