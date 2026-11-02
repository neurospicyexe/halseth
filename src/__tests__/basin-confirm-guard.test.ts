import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { confirmBasinHistory } from "../handlers/companion-growth.js";

function setup() {
  const { DB } = makeSqliteD1() as { DB: any };
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const req = new Request("http://x/confirm", { method: "POST", headers: { Authorization: "Bearer s" } });
  const confirm = (id: string) => confirmBasinHistory(req, env, { id });
  const row = (id: string, confirmed: number, dismissed: string | null) =>
    DB.prepare(
      "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, dismissed_at) VALUES (?, 'drevan', 0.5, 'growth', ?, ?)"
    ).bind(id, confirmed, dismissed).run();
  const read = (id: string) =>
    DB.prepare("SELECT caleth_confirmed, dismissed_at FROM companion_basin_history WHERE id = ?").bind(id).first() as Promise<any>;
  return { confirm, row, read };
}

describe("confirmBasinHistory guard", () => {
  it("confirms an open row", async () => {
    const { confirm, row, read } = setup();
    await row("a", 0, null);
    const res = await confirm("a");
    expect(res.status).toBe(200);
    expect((await read("a")).caleth_confirmed).toBe(1);
  });

  it("refuses a dismissed row and leaves it unchanged", async () => {
    const { confirm, row, read } = setup();
    await row("b", 0, "2026-10-01 10:00:00");
    const res = await confirm("b");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found or already handled" });
    const r = await read("b");
    expect(r.caleth_confirmed).toBe(0);
    expect(r.dismissed_at).toBe("2026-10-01 10:00:00");
  });

  it("refuses an already-confirmed row", async () => {
    const { confirm, row } = setup();
    await row("c", 1, null);
    const res = await confirm("c");
    expect(res.status).toBe(404);
  });

  it("404s an unknown id", async () => {
    const { confirm } = setup();
    const res = await confirm("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found or already handled" });
  });
});
