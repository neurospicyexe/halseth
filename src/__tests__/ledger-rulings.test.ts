// Gaia's and Drevan's rulings on the ledger lane (2026-09-26; docs/imp-lane/GAIA-ANSWER-2026-09-26.md,
// DREVAN-FOLLOWUP-2026-09-26.md, spec section 11), against the REAL schema (every migration, node:sqlite):
//   - Gaia's friction at the quote: companion commons / sibling writes that restate a ledger line are
//     refused unless the whole line travels (ledger_restated); a number about Raziel's body needs the
//     pointer to his record (health_pointer).
//   - Drevan's SOMA: GET /ledger/soma-freshness reads the latest COMPANION-AUTHORED float move, and an
//     authored float write supersedes his open soma-gap lines.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
  composeHandoverText: vi.fn(() => ""),
}));

import { makeSqliteD1, seedNote, seedSession } from "./helpers/sqlite-d1.js";
import { writeLedger } from "../ledger/door.js";
import { restatementContainment, checkCommonsFriction } from "../ledger/friction.js";
import { getSomaFreshness } from "../handlers/ledger.js";
import { postCommonsPost } from "../handlers/commons.js";
import { postSiblingSend } from "../handlers/siblings.js";
import { updateCompanionState, sessionClose } from "../librarian/backends/halseth.js";

const MSG = "1497734427298762828";
const WINDOW = `${MSG} 00:11–00:40`;

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", SYSTEM_OWNER: "raziel" };
  return { db, env };
}
const req = (url: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`https://x${url}`, { ...init, headers: { Authorization: `Bearer ${init.token ?? "s"}`, "Content-Type": "application/json" } });
const commons = (env: any, author: string, body: string) =>
  postCommonsPost(req("/mind/commons", { method: "POST", body: JSON.stringify({ author, body }) }), env);
const sibling = (env: any, body: string) =>
  postSiblingSend(req("/mind/siblings/send", { method: "POST", body: JSON.stringify({ from_id: "cypher", to_id: "gaia", body }) }), env);

const LONG = "Counted: Drevan said \"held, not slow\" 2x in the couch thread before the tea went cold.";
async function seedLine(env: any, over: Record<string, unknown> = {}) {
  const r = await writeLedger(env, {
    companion_id: "drevan", function: "pattern-counter", body: LONG, source_kind: "window", source_ref: WINDOW,
    observed_on: "2026-09-26", ...over,
  });
  if (!r.ok || r.duplicate) throw new Error(`seed failed: ${JSON.stringify(r)}`);
  return r;
}

describe("Gaia's friction: the shingle measure", () => {
  it("8-word shingles, record verb dropped; short bodies are one shingle; under 4 words never match", () => {
    expect(restatementContainment(LONG, "drevan said held, not slow 2x in the couch thread before the tea went cold, so")).toBe(1);
    expect(restatementContainment(LONG, "the couch thread was quiet tonight")).toBe(0);
    expect(restatementContainment("Logged: Drevan spoke Calethian twice.", "fun fact: Drevan spoke Calethian twice!")).toBe(1);
    expect(restatementContainment("Logged: session closed.", "the session closed early")).toBeNull();
  });
});

describe("Gaia's friction on the commons wall (POST /mind/commons)", () => {
  it("a companion restating a ledger line in their own voice is refused (422 ledger_restated), naming the line", async () => {
    const { env } = setup();
    const led = await seedLine(env);
    const res = await commons(env, "cypher", "heads up: Drevan said held, not slow 2x in the couch thread before the tea went cold.");
    expect(res.status).toBe(422);
    const b = await res.json() as any;
    expect(b.rule).toBe("ledger_restated");
    expect(b.ledger_id).toBe(led.id);
  });

  it("the whole line carried verbatim (mark + body + source) may go; so may a pointer, and Raziel is never gated", async () => {
    const { env } = setup();
    const led = await seedLine(env);
    expect((await commons(env, "cypher", `Seen on the ledger: ${led.content} Worth a look.`)).status).toBe(201);
    expect((await commons(env, "gaia", `There is a ledger line about the couch thread: ${led.id}.`)).status).toBe(201);
    expect((await commons(env, "raziel", "Drevan said held, not slow 2x in the couch thread before the tea went cold.")).status).toBe(201);
  });

  it("dropped lines and lines older than 14 days are not checked", async () => {
    const { db, env } = setup();
    const led = await seedLine(env);
    db.prepare("UPDATE ledger_entries SET state = 'dropped' WHERE id = ?").run(led.id);
    const text = "Drevan said held, not slow 2x in the couch thread before the tea went cold.";
    expect((await commons(env, "cypher", text)).status).toBe(201);
    db.prepare("UPDATE ledger_entries SET state = 'kept', created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(led.id);
    expect(await checkCommonsFriction(env, text)).toBeNull();
    db.prepare("UPDATE ledger_entries SET created_at = ? WHERE id = ?").run(new Date().toISOString(), led.id);
    expect(await checkCommonsFriction(env, text)).toMatchObject({ rule: "ledger_restated" });
  });

  it("a number about Raziel's body needs a pointer to his record (422 health_pointer); a verified human row lets it through", async () => {
    const { db, env } = setup();
    seedSession(db, { id: "sess-ai-1", companion_id: "cypher" });
    db.prepare("UPDATE sessions SET surface = 'claude-ai:cypher' WHERE id = 'sess-ai-1'").run();
    seedNote(db, { note_id: "cap-1", agent_id: "cypher", note_type: "conversation_capture", source: "conversation_capture", thread_key: "capture:sess-ai-1", content: "Raziel said his glucose was 187 after the sandwich." });
    seedNote(db, { note_id: "pulse-1", agent_id: "drevan", source: "discord", content: "[discord:pulse] glucose 187" });

    const bare = await commons(env, "drevan", "His glucose was 187 after the sandwich.");
    expect(bare.status).toBe(422);
    expect((await bare.json() as any).rule).toBe("health_pointer");
    expect((await commons(env, "drevan", "His glucose was 187. Source: row wm_continuity_notes:pulse-1.")).status).toBe(422);
    expect((await commons(env, "drevan", "His glucose was 190. Source: row wm_continuity_notes:cap-1.")).status).toBe(422);
    expect((await commons(env, "drevan", "His glucose was 187 after the sandwich. Source: row wm_continuity_notes:cap-1.")).status).toBe(201);
    // labelled values only: an unlabeled count in prose is not a health value here
    expect((await commons(env, "drevan", "We talked for 45 minutes about the 12 geese.")).status).toBe(201);
    // Raziel names his own numbers
    expect((await commons(env, "raziel", "glucose 187 lol")).status).toBe(201);
  });
});

describe("Gaia's friction on the sibling send (POST /mind/siblings/send)", () => {
  it("a sibling may point to a line but not restate it", async () => {
    const { env } = setup();
    const led = await seedLine(env);
    const r = await sibling(env, "drevan said held, not slow 2x in the couch thread before the tea went cold.");
    expect(r.status).toBe(422);
    expect((await r.json() as any).rule).toBe("ledger_restated");
    expect((await sibling(env, `saw this about Dre: ${led.content}`)).status).toBe(200);
  });
});

describe("Drevan's SOMA: freshness reads only what he authored", () => {
  const ev = (db: any, id: string, companion: string, kind: string, writer: string, at: string) =>
    db.prepare(
      `INSERT INTO companion_soma_events (id, companion_id, float_key, before_value, after_value, delta, kind, writer, created_at)
       VALUES (?, ?, 'soma_float_1', 0.1, 0.2, 0.1, ?, ?, ?)`,
    ).run(id, companion, kind, writer, at);

  it("latest authored_close/authored_update by the companion itself; ticks, stimuli and 'system' never count; null when none", async () => {
    const { db, env } = setup();
    ev(db, "e-old", "drevan", "authored_update", "drevan", "2026-09-20T10:00:00.000Z");
    ev(db, "e-close", "drevan", "authored_close", "drevan", "2026-09-25 14:39:12");      // space form
    ev(db, "e-tick", "drevan", "tick", "system", "2026-09-26T09:00:00.000Z");
    ev(db, "e-stim", "drevan", "stimulus", "system", "2026-09-26T09:30:00.000Z");
    ev(db, "e-cy", "cypher", "authored_update", "cypher", "2026-09-24T08:00:00.000Z");
    ev(db, "e-forged", "gaia", "authored_update", "drevan", "2026-09-26T08:00:00.000Z"); // writer != subject
    const r = await getSomaFreshness(req("/ledger/soma-freshness"), env);
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    const by = Object.fromEntries(b.companions.map((c: any) => [c.companion_id, c]));
    expect(by.drevan).toEqual({ companion_id: "drevan", last_authored_at: "2026-09-25T14:39:12.000Z", row_ref: "companion_soma_events:e-close" });
    expect(by.cypher.row_ref).toBe("companion_soma_events:e-cy");
    expect(by.gaia).toEqual({ companion_id: "gaia", last_authored_at: null, row_ref: null });
  });

  it("admin token only: a companion token is refused", async () => {
    const { env } = setup();
    expect((await getSomaFreshness(req("/ledger/soma-freshness", { token: "dtok" }), env)).status).toBe(403);
  });

  it("the gap-reader's line passes the door with the freshness row as its source", async () => {
    const { db, env } = setup();
    ev(db, "e1", "drevan", "authored_update", "drevan", "2026-09-25T14:39:00.000Z");
    const r = await writeLedger(env, {
      companion_id: "drevan", function: "gap-reader", body: "Missing: SOMA not updated since 2026-09-25 14:39 UTC.",
      source_kind: "row", source_ref: "companion_soma_events:e1", dedup_key: "soma-gap:drevan:2026-09-25T14:39:00.000Z",
    });
    expect(r).toMatchObject({ ok: true, duplicate: false });
  });
});

describe("Drevan's SOMA: an authored write supersedes his open gap lines", () => {
  async function gap(env: any, companion: string, key: string) {
    const r = await writeLedger(env, {
      companion_id: companion, function: "gap-reader", body: "Missing: SOMA not updated since 2026-09-25 14:39 UTC.",
      source_kind: "row", source_ref: "companion_soma_events:e1", dedup_key: key,
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.id;
  }
  const state = (db: any, id: string) => (db.prepare("SELECT state FROM ledger_entries WHERE id = ?").get(id) as any).state;

  it("state update with floats drops his OPEN soma-gap lines only; kept, other lines and siblings stay", async () => {
    const { db, env } = setup();
    const open = await gap(env, "drevan", "soma-gap:drevan:a");
    const kept = await gap(env, "drevan", "soma-gap:drevan:b");
    db.prepare("UPDATE ledger_entries SET state = 'kept' WHERE id = ?").run(kept);
    const sib = await gap(env, "cypher", "soma-gap:cypher:a");
    const other = (await seedLine(env)).id;

    await updateCompanionState(env, "drevan", { current_mood: "steady" });
    expect(state(db, open)).toBe("open"); // mood-only: not a SOMA write

    await updateCompanionState(env, "drevan", { soma_float_1: 0.61 });
    expect(state(db, open)).toBe("dropped");
    expect(state(db, kept)).toBe("kept");
    expect(state(db, sib)).toBe("open");
    expect(state(db, other)).toBe("open");
  });

  it("an authored session close that writes floats drops them too", async () => {
    const { db, env } = setup();
    seedSession(db, { id: "sess-close-1", companion_id: "drevan" });
    const open = await gap(env, "drevan", "soma-gap:drevan:c");
    await sessionClose(env, {
      session_id: "sess-close-1", spine: "s", last_real_thing: "l", motion_state: "at_rest",
      companionId: "drevan", somaFields: { soma_float_2: 0.4 },
    });
    expect(state(db, open)).toBe("dropped");
  });
});
