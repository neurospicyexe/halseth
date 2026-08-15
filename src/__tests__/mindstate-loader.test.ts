// MindState loader covenant tests (Phase 1 slice 1, docs/mindstate-contract.md).
//
// The covenant under test: loadMindState() is a PURE READ. Loading a companion's
// state must never consume it -- no incoming-note auto-ack, no heat warming, no
// home-event surfaced_at stamping, no identity-anchor seeding write. The legacy
// aggregators consumed state as a side effect of reading, bound to whichever loom
// booted first; the loader is the replacement, and this test keeps it honest.

import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import { loadMindState } from "../mind/loader.js";
import { MINDSTATE_CONTRACT_VERSION, NOT_YET_LOADED } from "../mind/contract.js";
import { mindOrient } from "../webmind/orient.js";

/** Fake D1 env: captures every prepared SQL string. Generic reads return empty;
 *  targeted overrides let specific SELECTs return rows (to arm side-effect paths).
 *  first() returns a truthy generic row so the identity-anchor auto-seed (a write)
 *  is not triggered by anchor-missing. */
function fakeEnv(overrides: Array<{ match: RegExp; rows: unknown[] }> = []) {
  const prepared: string[] = [];
  function stmtFor(sql: string) {
    const hit = overrides.find((o) => o.match.test(sql));
    const rows = hit ? hit.rows : [];
    const stmt = {
      bind(..._b: unknown[]) { return stmt; },
      async all() { return { results: rows }; },
      async first() { return rows[0] ?? { agent_id: "cypher", cnt: 0 }; },
      async run() { return { meta: { changes: rows.length } }; },
    };
    return stmt;
  }
  const env = {
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare(sql: string) { prepared.push(sql); return stmtFor(sql); },
      async batch(stmts: unknown[]) { return stmts.map(() => ({ results: [] })); },
    },
  } as unknown as Env;
  return { env, prepared };
}

/** Overrides that ARM every consume-on-read path: an unread incoming note (ack),
 *  surfaced continuity notes (warm), unsurfaced home events (stamp). */
function armedOverrides() {
  return [
    {
      match: /FROM inter_companion_notes n\s+WHERE \(n\.to_id = \?/i,
      rows: [{ id: "note-1", from_id: "drevan", to_id: "cypher", content: "hi", read_at: null, created_at: "2026-07-01T00:00:00Z" }],
    },
    {
      match: /FROM wm_continuity_notes\s+WHERE agent_id = \? AND salience = 'high'/i,
      rows: [{ note_id: "cn-1", content: "c", salience: "high", actor: "agent", created_at: "2026-07-01T00:00:00Z" }],
    },
    {
      match: /FROM home_events WHERE companion_id = \? AND surfaced_at IS NULL/i,
      rows: [{ id: "he-1", companion_id: "cypher", created_at: "2026-07-01T00:00:00Z" }],
    },
  ];
}

const MUTATION = /^\s*(INSERT|UPDATE|DELETE)\b/im;

describe("loadMindState is a pure read", () => {
  it("prepares zero INSERT/UPDATE/DELETE even when every consume path is armed", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await loadMindState(env, "cypher", "raw");
    const mutations = prepared.filter((s) => MUTATION.test(s));
    expect(
      mutations,
      "loadMindState must never write -- consumption is an explicit verb, not a boot side effect"
    ).toEqual([]);
  });

  it("contrast: legacy mindOrient WITHOUT readOnly still consumes (auto-ack fires)", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await mindOrient(env, "cypher");
    expect(
      prepared.some((s) => /UPDATE inter_companion_notes SET read_at/i.test(s)),
      "legacy path keeps its behavior until cutover -- if this stops firing, the cutover happened and this test should be updated"
    ).toBe(true);
  });

  it("readOnly mindOrient suppresses ack, warm, and home stamping", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await mindOrient(env, "cypher", { readOnly: true });
    expect(prepared.filter((s) => MUTATION.test(s))).toEqual([]);
  });
});

describe("MindState contract shape", () => {
  it("carries version, loom, and every top-level block", async () => {
    const { env } = fakeEnv();
    const ms = await loadMindState(env, "gaia", "hearth");
    expect(ms.contract_version).toBe(MINDSTATE_CONTRACT_VERSION);
    expect(ms.companion_id).toBe("gaia");
    expect(ms.loom).toBe("hearth");
    for (const block of ["identity", "felt", "continuity", "carried", "beliefs", "relational", "oversight", "world", "meta"] as const) {
      expect(ms[block], `missing block: ${block}`).toBeDefined();
    }
    expect(ms.meta.not_yet_loaded).toEqual(NOT_YET_LOADED);
  });

  it("orient-only and ground-only blocks both arrive (sits from ground, tensions from orient)", async () => {
    const { env } = fakeEnv([
      { match: /FROM companion_journal cj\s+JOIN companion_journal_sits/i, rows: [{ note_id: "s1", content: "sitting", sit_text: null, sat_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" }] },
      // \s+ not a literal space: the query went multi-line in 0119 when the decayed-charge
      // expression was added, and a matcher that breaks on reformatting tests the whitespace
      // rather than the query.
      { match: /FROM companion_tensions\s+WHERE companion_id = \? AND status = 'simmering'/i, rows: [{ id: "t1", tension_text: "hm", status: "simmering", first_noted_at: "2026-07-01T00:00:00Z", last_surfaced_at: null, notes: null }] },
    ]);
    const ms = await loadMindState(env, "drevan", "discord");
    expect(ms.carried.sits.map((s) => s.note_id)).toEqual(["s1"]);
    expect(ms.carried.tensions.map((t) => t.id)).toEqual(["t1"]);
  });
});
