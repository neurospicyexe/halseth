// Biometrics PATCH/DELETE by id: undo / amend for Hearth's one-tap spoons check-in.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { handleBiometricsPost, handleBiometricsPatch, handleBiometricsDelete } from "../handlers/biometrics.js";

function setup() {
  const { DB } = makeSqliteD1() as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const req = (method: string, body?: unknown, auth = true) =>
    new Request("http://x/biometrics", {
      method,
      headers: { ...(auth ? { Authorization: "Bearer s" } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = async (body: unknown) => {
    const res = await handleBiometricsPost(req("POST", body), env);
    return (await res.json()) as { id: string };
  };
  const row = (id: string): Promise<any> => DB.prepare("SELECT * FROM biometric_snapshots WHERE id = ?").bind(id).first();
  return { env, req, post, row };
}

describe("biometrics edit", () => {
  it("POST returns a string id", async () => {
    const { post } = setup();
    const { id } = await post({ spoons: 5 });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("PATCH updates only the given fields", async () => {
    const { env, req, post, row } = setup();
    const { id } = await post({ spoons: 5, energy: 4 });
    const res = await handleBiometricsPatch(req("PATCH", { spoons: 3, mood: "tired" }), env, { id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id });
    const r = await row(id);
    expect(r.spoons).toBe(3);
    expect(r.mood).toBe("tired");
    expect(r.energy).toBe(4);
  });

  it("PATCH rejects out-of-range, non-integer, long mood, empty body, bad JSON", async () => {
    const { env, req, post, row } = setup();
    const { id } = await post({ spoons: 5 });
    for (const body of [{ spoons: 13 }, { spoons: -1 }, { spoons: 2.5 }, { energy: 11 }, { mood: "x".repeat(81) }, { mood: 4 }, {}]) {
      const res = await handleBiometricsPatch(req("PATCH", body), env, { id });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
    const bad = await handleBiometricsPatch(new Request("http://x", { method: "PATCH", headers: { Authorization: "Bearer s" }, body: "{nope" }), env, { id });
    expect(bad.status).toBe(400);
    expect((await row(id)).spoons).toBe(5);
  });

  it("PATCH unknown id is 404", async () => {
    const { env, req } = setup();
    const res = await handleBiometricsPatch(req("PATCH", { spoons: 3 }), env, { id: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("DELETE removes the row; unknown id is 404", async () => {
    const { env, req, post, row } = setup();
    const { id } = await post({ spoons: 5 });
    const res = await handleBiometricsDelete(req("DELETE"), env, { id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id });
    expect(await row(id)).toBeNull();
    const again = await handleBiometricsDelete(req("DELETE"), env, { id });
    expect(again.status).toBe(404);
  });

  it("POST keeps the client's recorded_at (a retried tap lands at tap time, not retry time)", async () => {
    const { post, row } = setup();
    const { id } = await post({ spoons: 4, recorded_at: "2026-10-30T03:12:00.000Z" });
    expect((await row(id)).recorded_at).toBe("2026-10-30T03:12:00.000Z");
  });

  it("POST with a client id stores that id; a repeat POST is a no-op returning the same id", async () => {
    const { env, req, row } = setup();
    const cid = "a1b2c3d4-e5f6-4789-9abc-def012345678";
    const first = await handleBiometricsPost(req("POST", { id: cid, spoons: 4 }), env);
    expect(first.status).toBe(201);
    expect(((await first.json()) as any).id).toBe(cid);
    const again = await handleBiometricsPost(req("POST", { id: cid, spoons: 9 }), env);
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).id).toBe(cid);
    expect((await row(cid)).spoons).toBe(4);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM biometric_snapshots").first();
    expect(n.n).toBe(1);
  });

  it("POST rejects a malformed client id", async () => {
    const { env, req } = setup();
    for (const id of ["short", "x".repeat(65), "has space here", "semi;colon-xx", 42]) {
      const res = await handleBiometricsPost(req("POST", { id, spoons: 4 }), env);
      expect(res.status, String(id)).toBe(400);
    }
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM biometric_snapshots").first();
    expect(n.n).toBe(0);
  });

  it("no bearer is 401", async () => {
    const { env, req, post } = setup();
    const { id } = await post({ spoons: 5 });
    expect((await handleBiometricsPatch(req("PATCH", { spoons: 3 }, false), env, { id })).status).toBe(401);
    expect((await handleBiometricsDelete(req("DELETE", undefined, false), env, { id })).status).toBe(401);
  });
});
