// GET /mind/imps/activity (the Imps page's read) against the REAL schema. Raziel-facing, so the tests pin
// what must never leave: reply-ride trigger text (his mood/spoons/pain), open imp lines, and any Hex line.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getImpsActivity, errandPhrase } from "../handlers/imps-activity.js";

const ENV = { ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
const req = (auth: string | null = "Bearer s") =>
  new Request("https://x/mind/imps/activity", { headers: auth ? { Authorization: auth } : {} });

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ...ENV };
  let n = 0;
  const act = (imp: string, comp: string, trigger: string | null, at: string) =>
    db.prepare("INSERT INTO imp_activations (id, imp, companion_id, trigger, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`ia_${++n}`, imp, comp, trigger, at);
  const line = (id: string, comp: string, rider: string | null, state: string, text: string, at = "2026-11-06T10:00:00.000Z") =>
    db.prepare("INSERT INTO ledger_entries (id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, state, state_at, rider) VALUES (?, ?, 'sort', ?, ?, 'row', 'companion_journal:abc', '2026-11-06', ?, ?, ?, ?)")
      .run(id, comp, text, text, at, state, state === "open" ? null : at, rider);
  return { db, env, act, line };
}
const call = async (env: any) => (await getImpsActivity(req(), env)).json() as Promise<any>;

describe("GET /mind/imps/activity", () => {
  it("requires auth", async () => {
    const { env } = setup();
    expect((await getImpsActivity(req(null), env)).status).toBe(401);
    expect((await getImpsActivity(req("Bearer wrong"), env)).status).toBe(401);
    expect((await getImpsActivity(req(), env)).status).toBe(200);
  });

  it("never returns trigger text or health substrings; reply rides become kind=reply", async () => {
    const { env, act } = setup();
    act("mossling", "drevan", "mood=okay,spoons=4,pain=7", "2026-11-06T09:00:00.000Z");
    act("iris", "cypher", "spoons=2", "2026-11-06T09:30:00.000Z");
    act("nimbus", "cypher", "errand:gap-reader", "2026-11-06T09:45:00.000Z");
    const res = await getImpsActivity(req(), env);
    const text = await res.text();
    for (const bad of ["spoons", "pain", "mood=", "trigger", "errand:"]) expect(text).not.toContain(bad);
    const body = JSON.parse(text);
    expect(body.recent.map((r: any) => [r.imp, r.kind, r.errand])).toEqual([
      ["nimbus", "errand", "checked for gaps"], ["iris", "reply", null], ["mossling", "reply", null],
    ]);
    expect(body.last_by_imp.mossling).toEqual({ created_at: "2026-11-06T09:00:00.000Z", companion_id: "drevan", kind: "reply", errand: null });
    expect(body.last_by_imp.rock).toBeNull();
    expect(Object.keys(body.last_by_imp).sort()).toEqual(["hex", "iris", "mossling", "nimbus", "rock"]);
  });

  it("maps every errand trigger to its plain phrase; unknown is 'ran an errand'", () => {
    expect(errandPhrase("nimbus", "errand:gap-reader")).toBe("checked for gaps");
    expect(errandPhrase("rock", "errand:pattern-counter")).toBe("counted loops");
    expect(errandPhrase("rock", "errand:fetch")).toBe("fetched");
    expect(errandPhrase("hex", "errand:salt")).toBe("left a pointer");
    expect(errandPhrase("hex", "errand:fetch")).toBe("left a pointer");
    expect(errandPhrase("mossling", "errand:sort")).toBe("sorted the tray");
    expect(errandPhrase("mossling", "errand:tend")).toBe("tended Sol");
    expect(errandPhrase("iris", "errand:tend")).toBe("tended Sol");
    expect(errandPhrase("mossling", "errand:flag")).toBe("checked the care lane");
    expect(errandPhrase("iris", "errand:flag")).toBe("marked cooling interests");
    expect(errandPhrase("rock", "errand:mystery")).toBe("ran an errand");
    expect(errandPhrase("rock", "mood=okay")).toBeNull();
    expect(errandPhrase("rock", null)).toBeNull();
  });

  it("recent is capped at 40 newest, but last_by_imp still reaches a quiet imp", async () => {
    const { env, act } = setup();
    act("hex", "gaia", "errand:salt", "2026-10-01T00:00:00.000Z");
    for (let i = 0; i < 45; i++) act("rock", "drevan", "errand:fetch", `2026-11-0${1 + (i % 5)}T00:${String(i).padStart(2, "0")}:00.000Z`);
    const body = await call(env);
    expect(body.recent).toHaveLength(40);
    expect(body.last_by_imp.hex.errand).toBe("left a pointer");
  });

  it("kept: only kept non-Hex imp lines; open lines and every Hex line (open or kept) are absent", async () => {
    const { env, line } = setup();
    line("led_k1", "drevan", "rock", "kept", "Found: 2 rows about the garden.");
    line("led_o1", "drevan", "rock", "open", "OPEN-SECRET one");
    line("led_hk", "cypher", "hex", "kept", "HEX-KEPT-SECRET");
    line("led_ho", "cypher", "hex", "open", "HEX-OPEN-SECRET");
    line("led_d1", "gaia", "mossling", "dropped", "DROPPED-SECRET");
    line("led_p1", "cypher", null, "kept", "PLAIN-LEDGER-LINE");
    const res = await getImpsActivity(req(), env);
    const text = await res.text();
    for (const bad of ["OPEN-SECRET", "HEX-KEPT-SECRET", "HEX-OPEN-SECRET", "DROPPED-SECRET", "PLAIN-LEDGER-LINE"]) expect(text).not.toContain(bad);
    const body = JSON.parse(text);
    expect(body.kept).toEqual([{ id: "led_k1", imp: "rock", companion_id: "drevan", content: "Found: 2 rows about the garden.", state_at: "2026-11-06T10:00:00.000Z" }]);
  });

  it("kept is capped at 20, newest kept first", async () => {
    const { env, line } = setup();
    for (let i = 0; i < 25; i++) line(`led_k${i}`, "cypher", "nimbus", "kept", `Counted: ${i}.`, `2026-11-06T10:${String(i).padStart(2, "0")}:00.000Z`);
    const body = await call(env);
    expect(body.kept).toHaveLength(20);
    expect(body.kept[0].id).toBe("led_k24");
  });

  it("waiting: open non-Hex imp lines per companion; Hex excluded; kept and plain lines do not count", async () => {
    const { env, line } = setup();
    line("led_a", "drevan", "rock", "open", "Found: one.");
    line("led_b", "drevan", "nimbus", "open", "Counted: two.");
    line("led_c", "cypher", "hex", "open", "Recorded: one pointer left.");
    line("led_d", "cypher", "mossling", "kept", "Counted: three.");
    line("led_e", "gaia", null, "open", "Plain clerk line.");
    const body = await call(env);
    expect(body.waiting).toEqual({ drevan: 2, cypher: 0, gaia: 0 });
  });

  it("empty database: zeros, nulls, empty lists", async () => {
    const { env } = setup();
    const body = await call(env);
    expect(body).toEqual({
      recent: [], waiting: { drevan: 0, cypher: 0, gaia: 0 }, kept: [],
      last_by_imp: { iris: null, nimbus: null, hex: null, mossling: null, rock: null },
    });
  });
});
