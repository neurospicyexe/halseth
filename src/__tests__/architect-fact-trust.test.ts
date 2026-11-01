// Fact trust (mig 0158, 2026-11-01): derived at write time, adjustable by Raziel, tolerated before the migration.
import { describe, it, expect } from "vitest";
import { deriveFactTrust } from "../lib/architect-fact-write.js";
import { patchArchitectFactStatus } from "../handlers/architect-facts.js";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";

describe("deriveFactTrust", () => {
  it.each([
    [{ source: "raziel", companionId: "drevan", status: "active" }, 1.0],
    [{ source: "Raziel", companionId: null, status: "active" }, 1.0],
    [{ source: "drevan", companionId: "drevan", status: "active" }, 0.6],
    [{ source: "drevan", companionId: "drevan", status: "open" }, 0.5],
    [{ source: "raziel", companionId: null, status: "open" }, 0.5],
    [{ source: "gaia", companionId: "gaia", status: "active", inherited: 0.9 }, 0.9],   // correction keeps it
    [{ source: "gaia", companionId: "gaia", status: "active", inherited: null }, null], // legacy stays legacy
    [{ source: "raziel", companionId: "gaia", status: "active", inherited: 0.3 }, 1.0], // Raziel restating
  ] as const)("%o -> %s", (input, want) => {
    expect(deriveFactTrust(input as any)).toBe(want);
  });
});

function env(upTo?: number) {
  const { db, DB } = makeSqliteD1(upTo === undefined ? {} : { upTo });
  db.prepare(`INSERT INTO architect_facts (id, fact, category, status, companion_id, source, weight, created_at) VALUES ('f1', 'likes rain', 'general', 'active', 'drevan', 'drevan', 100, datetime('now'))`).run();
  return { db, env: { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" } as any };
}
const patch = (e: any, body: unknown) =>
  patchArchitectFactStatus(new Request("https://h/identity/architect-facts/f1", { method: "PATCH", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body) }), e, { id: "f1" });

describe("PATCH trust", () => {
  it("sets trust within 0..1 and refuses out of range", async () => {
    const { db, env: e } = env();
    expect((await patch(e, { trust: 0.4 })).status).toBe(200);
    expect((db.prepare("SELECT trust FROM architect_facts WHERE id = 'f1'").get() as any).trust).toBe(0.4);
    expect((await patch(e, { trust: 1.5 })).status).toBe(400);
    expect((await patch(e, { trust: "high" })).status).toBe(400);
  });
  it("before 0158 a trust PATCH answers 409, other fields still work", async () => {
    const { env: e } = env(157);
    expect((await patch(e, { trust: 0.4 })).status).toBe(409);
    expect((await patch(e, { weight: 50 })).status).toBe(200);
  });
});
