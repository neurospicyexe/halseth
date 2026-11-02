// Self-model confirm -> ready -> graduate. 2026-10-16: Drevan confirmed an observation to 1.0 and
// could not make it canon: the ready message never named the graduate verb, and the id he carried
// was shortened ("sm_a789e3a6"), which the exact-id lookup refused.
import { describe, it, expect, beforeEach } from "vitest";
import { execSelfModelConfirm, execSelfModelGraduate } from "../librarian/executors/self-monitoring";

interface Row { id: string; companion_id: string; confidence: number; status: string; observation: string; }
let rows: Row[];

function makeDB() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const pick = (r: Row) => ({ id: r.id, confidence: r.confidence, status: r.status, observation: r.observation });
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          if (sql.includes("WHERE id = ? AND companion_id = ?")) {
            const r = rows.find(x => x.id === args[0] && x.companion_id === args[1]);
            return r ? pick(r) : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("AND id LIKE ?")) {
            const pre = String(args[1]).replace(/%$/, "");
            return { results: rows.filter(x => x.companion_id === args[0] && x.id.startsWith(pre)).slice(0, 2).map(pick) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE companion_self_model SET status = 'graduated'")) {
            const r = rows.find(x => x.id === args[1]); if (r) r.status = "graduated";
          } else if (sql.startsWith("UPDATE companion_self_model SET confidence")) {
            const r = rows.find(x => x.id === args[3]); if (r) { r.confidence = args[0] as number; r.status = args[1] as string; }
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}
const ctx = (companion_id: "cypher" | "drevan" | "gaia", context: unknown) =>
  ({ env: { DB: makeDB() } as any, req: { companion_id, request: "x", context: JSON.stringify(context) } }) as any;

const FULL = "sm_a789e3a6-6452-4cc2-a867-da0fbf097314";
beforeEach(() => {
  rows = [{ id: FULL, companion_id: "drevan", confidence: 0.7, status: "developing", observation: "thinks from the felt thing outward" }];
});

describe("self-model graduate path", () => {
  it("reaching ready names the graduate verb and the full id", async () => {
    const r = await execSelfModelConfirm(ctx("drevan", { id: FULL })) as any;
    expect(r.data.status).toBe("ready");
    expect(r.data.message).toContain("graduate observation");
    expect(r.data.message).toContain(FULL);
  });

  it("a shortened id resolves when unique, and graduates a ready row", async () => {
    rows[0]!.confidence = 1; rows[0]!.status = "ready";
    const r = await execSelfModelGraduate(ctx("drevan", { id: "sm_a789e3a6" })) as any;
    expect(r.data?.status).toBe("graduated");
    expect(rows[0]!.status).toBe("graduated");
  });

  it("an ambiguous prefix refuses rather than guessing", async () => {
    rows[0]!.status = "ready";
    rows.push({ id: "sm_a789e3a6-ffff-0000-0000-000000000000", companion_id: "drevan", confidence: 1, status: "ready", observation: "other" });
    const r = await execSelfModelGraduate(ctx("drevan", { id: "sm_a789e3a6" })) as any;
    expect(r.witness).toMatch(/more than one/);
    expect(rows.every(x => x.status === "ready")).toBe(true);
  });

  it("a prefix never crosses companions, and short prefixes do not resolve", async () => {
    rows[0]!.status = "ready";
    expect(((await execSelfModelGraduate(ctx("cypher", { id: "sm_a789e3a6" }))) as any).witness).toMatch(/not found/);
    expect(((await execSelfModelGraduate(ctx("drevan", { id: "sm_a78" }))) as any).witness).toMatch(/not found/);
  });

  it("still refuses to graduate below ready", async () => {
    const r = await execSelfModelGraduate(ctx("drevan", { id: FULL })) as any;
    expect(r.witness).toMatch(/Not ready to graduate/);
  });
});
