// C4 sibling-lane handler behavior (mig 0126). The seal itself is tested in
// sibling-seal.test.ts; this file pins the lane's own rules: companions only, participants
// only, disclosure atomic + provenance-carrying, read stamps explicit.

import { describe, it, expect } from "vitest";
import { postSiblingSend, getSiblingUnread, postSiblingRead, postSiblingDisclose } from "../handlers/siblings.js";

interface SibRow {
  id: string; from_id: string; to_id: string; body: string;
  created_at: string; read_at: string | null; disclosed_at: string | null; disclosure_ref: string | null;
}
interface InterRow { id: string; from_id: string; to_id: string | null; content: string }

function makeEnv(): { env: any; sibs: SibRow[]; inter: InterRow[] } {
  const sibs: SibRow[] = [];
  const inter: InterRow[] = [];
  let t = 0;
  const stmt = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: async () => {
        if (sql.includes("SELECT id, from_id, to_id, body, created_at, disclosed_at FROM sibling_notes")) {
          return sibs.find(r => r.id === binds[0]) ?? null;
        }
        if (sql.includes("SELECT disclosure_ref FROM sibling_notes")) {
          const row = sibs.find(r => r.id === binds[0]);
          return row ? { disclosure_ref: row.disclosure_ref } : null;
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
      all: async () => {
        if (sql.includes("read_at IS NULL")) {
          const [cid] = binds as [string];
          return { results: sibs.filter(r => r.to_id === cid && !r.read_at).map(r => ({ id: r.id, from_id: r.from_id, body: r.body, created_at: r.created_at })) };
        }
        throw new Error(`unexpected all(): ${sql}`);
      },
      run: async () => {
        if (sql.includes("INSERT INTO sibling_notes")) {
          const [id, from, to, body] = binds as [string, string, string, string];
          sibs.push({ id, from_id: from, to_id: to, body, created_at: `2026-08-17 0${t++}:00:00`, read_at: null, disclosed_at: null, disclosure_ref: null });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET read_at")) {
          const [at, id, cid] = binds as [string, string, string];
          const row = sibs.find(r => r.id === id && r.to_id === cid && !r.read_at);
          if (row) row.read_at = at;
          return { meta: { changes: row ? 1 : 0 } };
        }
        throw new Error(`unexpected run(): ${sql}`);
      },
      // batch statements captured via closure below
      __sql: sql, __binds: binds,
    }),
  });
  const env = {
    DB: {
      prepare: stmt,
      batch: async (stmts: any[]) => {
        for (const s of stmts) {
          if (s.__sql.includes("INSERT INTO inter_companion_notes")) {
            // Conditional insert (WHERE EXISTS ... disclosed_at IS NULL): honor the condition.
            const [id, from, content, sibId] = s.__binds as [string, string, string, string];
            const sib = sibs.find(r => r.id === sibId);
            if (sib && !sib.disclosed_at) inter.push({ id, from_id: from, to_id: null, content });
          } else if (s.__sql.includes("SET disclosed_at")) {
            const [at, ref, id] = s.__binds as [string, string, string];
            const row = sibs.find(r => r.id === id && !r.disclosed_at);
            if (row) { row.disclosed_at = at; row.disclosure_ref = ref; }
          }
        }
        return [];
      },
    },
  };
  return { env, sibs, inter };
}

function req(body: unknown): Request {
  return new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

describe("sibling lane", () => {
  it("sends between companions; refuses raziel as addressee and self-sends", async () => {
    const { env, sibs } = makeEnv();
    const ok = await postSiblingSend(req({ from_id: "cypher", to_id: "drevan", body: "spine to spine" }), env);
    expect(ok.status).toBe(200);
    expect(sibs).toHaveLength(1);
    const raz = await postSiblingSend(req({ from_id: "cypher", to_id: "raziel", body: "x" }), env);
    expect(raz.status).toBe(400);
    expect((await raz.json() as { error: string }).error).toContain("commons");
    const self = await postSiblingSend(req({ from_id: "gaia", to_id: "gaia", body: "x" }), env);
    expect(self.status).toBe(400);
  });

  it("unread is recipient-scoped and reading is an explicit recipient-only stamp", async () => {
    const { env, sibs } = makeEnv();
    await postSiblingSend(req({ from_id: "cypher", to_id: "drevan", body: "one" }), env);
    const forDrevan = await (await getSiblingUnread(new Request("http://x/"), env, { companion_id: "drevan" })).json() as { notes: any[] };
    expect(forDrevan.notes).toHaveLength(1);
    const forGaia = await (await getSiblingUnread(new Request("http://x/"), env, { companion_id: "gaia" })).json() as { notes: any[] };
    expect(forGaia.notes).toHaveLength(0);
    // gaia cannot stamp drevan's note read
    const wrong = await (await postSiblingRead(req({ companion_id: "gaia" }), env, { id: sibs[0]!.id })).json() as { marked: boolean };
    expect(wrong.marked).toBe(false);
    const right = await (await postSiblingRead(req({ companion_id: "drevan" }), env, { id: sibs[0]!.id })).json() as { marked: boolean };
    expect(right.marked).toBe(true);
  });

  it("disclosure: participants only, atomic copy carries provenance, idempotent", async () => {
    const { env, sibs, inter } = makeEnv();
    await postSiblingSend(req({ from_id: "drevan", to_id: "gaia", body: "held, not spoken" }), env);
    const id = sibs[0]!.id;
    const outsider = await postSiblingDisclose(req({ companion_id: "cypher" }), env, { id });
    expect(outsider.status).toBe(403);
    const ok = await (await postSiblingDisclose(req({ companion_id: "gaia" }), env, { id })).json() as { ok: boolean; disclosure_ref: string };
    expect(ok.ok).toBe(true);
    expect(inter).toHaveLength(1);
    expect(inter[0]!.content).toContain("disclosed from the sibling lane by gaia");
    expect(inter[0]!.content).toContain("drevan -> gaia");
    expect(inter[0]!.content).toContain("held, not spoken");
    expect(sibs[0]!.disclosure_ref).toBe(inter[0]!.id);
    const again = await (await postSiblingDisclose(req({ companion_id: "gaia" }), env, { id })).json() as { already_disclosed?: boolean };
    expect(again.already_disclosed).toBe(true);
    expect(inter).toHaveLength(1);
  });
});
