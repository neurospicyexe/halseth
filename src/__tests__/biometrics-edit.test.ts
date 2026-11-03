// Biometrics PATCH/DELETE by id: undo / amend for Hearth's one-tap spoons check-in.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { handleBiometricsPost, handleBiometricsPatch, handleBiometricsDelete, handleBiometricsList } from "../handlers/biometrics.js";

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
    expect(await res.json()).toEqual({ ok: true, id, care_firings_voided: 0 });
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

  describe("pain_where / pain / notes (0167)", () => {
    it("POST stores pain_where trimmed; empty or non-string becomes null; over 120 is cut", async () => {
      const { post, row } = setup();
      expect((await row((await post({ pain: 4, pain_where: "  hips  " })).id)).pain_where).toBe("hips");
      expect((await row((await post({ pain: 4, pain_where: "   " })).id)).pain_where).toBeNull();
      expect((await row((await post({ pain: 4, pain_where: 7 })).id)).pain_where).toBeNull();
      expect((await row((await post({ pain_where: "x".repeat(300) })).id)).pain_where).toHaveLength(120);
    });

    it("PATCH sets pain, pain_where and notes; other columns are untouched", async () => {
      const { env, req, post, row } = setup();
      const { id } = await post({ spoons: 5, energy: 4 });
      const res = await handleBiometricsPatch(req("PATCH", { pain: 6, pain_where: " hips ", notes: " flat, but okay " }), env, { id });
      expect(res.status).toBe(200);
      const r = await row(id);
      expect(r.pain).toBe(6);
      expect(r.pain_where).toBe("hips");
      expect(r.notes).toBe("flat, but okay");
      expect(r.spoons).toBe(5);
      expect(r.energy).toBe(4);
    });

    it("PATCH null or empty string clears pain_where and notes; null clears pain; pain 0 is kept", async () => {
      const { env, req, post, row } = setup();
      const { id } = await post({ pain: 6, pain_where: "hips", notes: "word" });
      await handleBiometricsPatch(req("PATCH", { pain_where: "", notes: null }), env, { id });
      let r = await row(id);
      expect(r.pain_where).toBeNull();
      expect(r.notes).toBeNull();
      expect(r.pain).toBe(6);
      await handleBiometricsPatch(req("PATCH", { pain: 0 }), env, { id });
      expect((await row(id)).pain).toBe(0);
      await handleBiometricsPatch(req("PATCH", { pain: null }), env, { id });
      expect((await row(id)).pain).toBeNull();
    });

    it("PATCH rejects bad pain / pain_where / notes with 400 and writes nothing", async () => {
      const { env, req, post, row } = setup();
      const { id } = await post({ pain: 2, pain_where: "knee", notes: "n" });
      for (const body of [
        { pain: 11 }, { pain: -1 }, { pain: 2.5 }, { pain: "3" },
        { pain_where: "x".repeat(121) }, { pain_where: 5 },
        { notes: "x".repeat(2001) }, { notes: 5 },
        { spoons: null },
      ]) {
        const res = await handleBiometricsPatch(req("PATCH", body), env, { id });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const r = await row(id);
      expect([r.pain, r.pain_where, r.notes]).toEqual([2, "knee", "n"]);
      // boundaries are accepted
      const ok = await handleBiometricsPatch(req("PATCH", { pain_where: "x".repeat(120), notes: "y".repeat(2000) }), env, { id });
      expect(ok.status).toBe(200);
    });

    it("PATCH of the new fields on an unknown id is 404", async () => {
      const { env, req } = setup();
      const res = await handleBiometricsPatch(req("PATCH", { pain_where: "hips" }), env, { id: "nope" });
      expect(res.status).toBe(404);
    });

    it("GET /biometrics rows include pain_where", async () => {
      const { env, req, post } = setup();
      await post({ pain: 3, pain_where: "back" });
      const rows = (await (await handleBiometricsList(req("GET"), env)).json()) as any[];
      expect(rows[0].pain_where).toBe("back");
    });
  });
});
