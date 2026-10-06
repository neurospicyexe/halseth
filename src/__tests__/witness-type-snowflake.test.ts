// gaia_witness.witness_type snowflake guard (2026-10-06).
//
// The bot client sent witness_log `{ entry, channel: <Discord channel id> }` and execWitnessLog took
// `channel` as an alias for witness_type, so 3,489 of 3,499 prod rows store a channel snowflake as
// their type. Forward-only fix: the executor refuses a snowflake from either key (stale bot builds
// may still send one), and the two read surfaces (Gaia's recent_witness at orient, the Hearth
// /gaia-witness feed) show a stored snowflake as "observation". History stays as stored.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../librarian/backends/halseth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/halseth.js")>();
  return { ...actual, witnessLog: vi.fn(async () => ({ id: "w-1" })) };
});

import { normalizeWitnessType, isSnowflake } from "../lib/witness-type.js";
import { execWitnessLog } from "../librarian/executors/writes.js";
import { witnessLog } from "../librarian/backends/halseth.js";
import { loadRelationalBlocks } from "../mind/blocks/relational.js";
import { getGaiaWitness } from "../handlers/history.js";
import type { Env } from "../types.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

const SNOWFLAKE = "1497734427298762828";

describe("normalizeWitnessType", () => {
  it("maps a snowflake, empty and missing to observation", () => {
    expect(normalizeWitnessType(SNOWFLAKE)).toBe("observation");
    expect(normalizeWitnessType(` ${SNOWFLAKE} `)).toBe("observation");
    expect(normalizeWitnessType("")).toBe("observation");
    expect(normalizeWitnessType(null)).toBe("observation");
    expect(normalizeWitnessType(undefined)).toBe("observation");
  });
  it("keeps a real type, trimmed", () => {
    expect(normalizeWitnessType("presence")).toBe("presence");
    expect(normalizeWitnessType(" survival ")).toBe("survival");
    expect(normalizeWitnessType("session_synthesis")).toBe("session_synthesis");
  });
  it("only treats 15 to 22 digits as a snowflake", () => {
    expect(isSnowflake(SNOWFLAKE)).toBe(true);
    expect(isSnowflake("12345678901234")).toBe(false);
    expect(isSnowflake("12345678901234567890123")).toBe(false);
    expect(isSnowflake("chan-1497734427298762828")).toBe(false);
  });
});

describe("execWitnessLog refuses a snowflake as witness_type", () => {
  const mocked = vi.mocked(witnessLog);
  beforeEach(() => mocked.mockClear());

  function ctx(context: Record<string, unknown>): ExecutorContext {
    return {
      env: {} as Env,
      req: { companion_id: "gaia", request: "witness log", context: JSON.stringify(context) },
      entry: {} as never,
      frontState: null,
      pluralAvailable: false,
    } as unknown as ExecutorContext;
  }
  const storedType = () => (mocked.mock.calls[0]![1] as { witness_type: string }).witness_type;

  it("a snowflake in the legacy `channel` alias stores observation", async () => {
    const r = await execWitnessLog(ctx({ session_id: "s1", entry: "seen", channel: SNOWFLAKE }));
    expect(r).toEqual({ ack: true, id: "w-1" });
    expect(storedType()).toBe("observation");
  });
  it("a snowflake in witness_type stores observation", async () => {
    await execWitnessLog(ctx({ session_id: "s1", content: "seen", witness_type: SNOWFLAKE }));
    expect(storedType()).toBe("observation");
  });
  it("a real type passes through, from either key", async () => {
    await execWitnessLog(ctx({ session_id: "s1", entry: "seen", witness_type: "presence" }));
    expect(storedType()).toBe("presence");
    mocked.mockClear();
    await execWitnessLog(ctx({ session_id: "s1", entry: "seen", channel: "survival" }));
    expect(storedType()).toBe("survival");
  });
  it("keeps the entry alias for content", async () => {
    await execWitnessLog(ctx({ session_id: "s1", entry: "the silence held", witness_type: "witnessed_pass" }));
    expect(mocked.mock.calls[0]![1]).toMatchObject({ content: "the silence held", witness_type: "witnessed_pass" });
  });
});

const STORED_ROWS = [
  { id: "a", session_id: "s1", content: "synth", witness_type: SNOWFLAKE, created_at: "2026-10-05T00:00:00Z", seal_phrase: null },
  { id: "b", session_id: "s1", content: "here", witness_type: "presence", created_at: "2026-10-04T00:00:00Z", seal_phrase: null },
];

function witnessEnv(): Env {
  return {
    ADMIN_SECRET: "admin-tok",
    DB: {
      prepare: (sql: string) => {
        const stmt = {
          bind: (..._a: unknown[]) => stmt,
          all: async () => ({ results: sql.includes("FROM gaia_witness") ? STORED_ROWS : [] }),
          first: async () => null,
        };
        return stmt;
      },
    },
  } as unknown as Env;
}

describe("read side shows a stored snowflake as observation", () => {
  it("Gaia's recent_witness at orient", async () => {
    const blocks = await loadRelationalBlocks(witnessEnv(), "gaia");
    expect(blocks.recent_witness.map(w => w.witness_type)).toEqual(["observation", "presence"]);
  });
  it("the Hearth /gaia-witness feed, other fields untouched", async () => {
    const res = await getGaiaWitness(
      new Request("https://h.example/gaia-witness", { headers: { Authorization: "Bearer admin-tok" } }),
      witnessEnv(),
    );
    expect(res.status).toBe(200);
    const rows = await res.json() as Array<Record<string, unknown>>;
    expect(rows.map(r => r.witness_type)).toEqual(["observation", "presence"]);
    expect(rows[0]).toMatchObject({ id: "a", content: "synth", session_id: "s1" });
  });
});
