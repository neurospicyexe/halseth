import { describe, it, expect } from "vitest";
import { writeLimbicState } from "../webmind/limbic.js";
import type { Env } from "../types.js";
import type { WmLimbicStateInput } from "../webmind/types.js";

/** Captures every SQL string the unit under test prepares. */
function recordingEnv() {
  const sql: string[] = [];
  const env = {
    DB: {
      prepare: (q: string) => {
        sql.push(q);
        return { bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
      },
      batch: async () => [],
    },
  } as unknown as Env;
  return { env, sql };
}

const input = (over: Partial<WmLimbicStateInput> = {}): WmLimbicStateInput => ({
  synthesis_source: "halseth:sessions+feelings+tensions+notes+dreams+loops",
  active_concerns: ["the pool is running empty"],
  // Gaia's first-person tension. Before 2026-07-09 this was written into companion_tensions
  // for cypher, drevan AND gaia -- one companion's interiority became all three's.
  live_tensions: [
    "I surfaced the vaselrin seed in autonomous time and came into tonight's session reaching toward it.",
    "Add a tension for drevan: the vow outruns the substrate.",
  ],
  drift_vector: "steady",
  open_questions: [],
  emotional_register: "pattern-lit",
  swarm_threads: [],
  companion_notes: {},
  ...over,
});

describe("writeLimbicState", () => {
  it("writes the limbic_states row", async () => {
    const { env, sql } = recordingEnv();
    await writeLimbicState(env, input());
    expect(sql.some(q => /INSERT INTO limbic_states/i.test(q))).toBe(true);
  });

  it("NEVER writes live_tensions into companion_tensions", async () => {
    // Three separate patches (07-08, 07-09 x2) each tried to route unowned swarm text into this
    // owned, aging, per-companion table. Each produced a new symptom: duplicate accumulation,
    // then first_noted_at/charge reset every hour, then one companion's first-person tension
    // fanned out to all three. The table is off limits from here.
    const { env, sql } = recordingEnv();
    await writeLimbicState(env, input());
    expect(sql.some(q => /companion_tensions/i.test(q))).toBe(false);
  });

  it("does not DELETE anything", async () => {
    const { env, sql } = recordingEnv();
    await writeLimbicState(env, input());
    expect(sql.some(q => /^\s*DELETE/i.test(q))).toBe(false);
  });

  it("is inert with respect to tensions even when live_tensions is empty", async () => {
    const { env, sql } = recordingEnv();
    await writeLimbicState(env, input({ live_tensions: [] }));
    expect(sql.some(q => /companion_tensions/i.test(q))).toBe(false);
  });

  it("still returns live_tensions on the row, for read-only surfacing", async () => {
    const { env } = recordingEnv();
    const row = await writeLimbicState(env, input());
    expect(JSON.parse(row.live_tensions as unknown as string)).toHaveLength(2);
  });
});
