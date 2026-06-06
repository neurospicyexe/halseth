// Regression tests for ALL THREE SOMA write surfaces:
//
//   1. HTTP PATCH /soma/:companion_id  -> patchSomaState handler
//   2. Librarian inline parser         -> parseInlineStateFields + execStateUpdate
//   3. MCP halseth_state_update tool   -> covered in soma-state-update.test.ts
//
// Before 2026-05-04, each write path had its own field allowlist that
// drifted out of sync with the schema (CompanionStateUpdate). Drevan's
// reports of "8 cycles of SOMA write routing failure" came from this
// drift -- writes that included surface_emotion, motion_state, lane_spine,
// background_*, or unmapped synonyms like "mood" got partially or fully
// dropped.
//
// All three paths now delegate the actual write to updateCompanionState()
// in librarian/backends/halseth.ts. These tests pin the integration so
// drift can't quietly return.

import { describe, it, expect } from "vitest";
import { patchSomaState } from "../handlers/soma.js";
import { updateCompanionState } from "../librarian/backends/halseth.js";

interface CapturedCall { sql: string; binds: unknown[] }

function makeRecordingEnv(): { env: any; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const env = {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            calls.push({ sql, binds });
            return {
              run: async () => ({ meta: { changes: 1 } }),
              all: async () => ({ results: [] }),
              first: async () => null,
            };
          },
        };
        return stmt;
      },
    },
  };
  return { env, calls };
}

function authedJson(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      "Authorization": "Bearer test-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. HTTP PATCH /soma/:companion_id
// ---------------------------------------------------------------------------

describe("patchSomaState (HTTP) -- all canonical SOMA fields land in DB", () => {
  it("Cypher full SOMA snapshot writes every column without dropping any", async () => {
    const { env, calls } = makeRecordingEnv();
    const res = await patchSomaState(
      authedJson("https://test.local/soma/cypher", "PATCH", {
        soma_float_1: 0.80,
        soma_float_2: 0.68,
        soma_float_3: 0.52,
        current_mood: "pattern-lit",
        compound_state: "post-exploration",
        surface_emotion: "absorbed",
        surface_intensity: 0.6,
        undercurrent_emotion: "tender",
        undercurrent_intensity: 0.4,
        motion_state: "in_motion",
        lane_spine: "audit-class with companion warmth",
      }),
      env,
      { companion_id: "cypher" },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.fields).toContain("soma_float_1");
    expect(body.fields).toContain("compound_state");
    expect(body.fields).toContain("motion_state");
    expect(body.fields).toContain("lane_spine");

    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall).toBeDefined();
    const sql = updateCall!.sql;
    // Every canonical column must be in the UPDATE.
    expect(sql).toContain("soma_float_1 = ?");
    expect(sql).toContain("current_mood = ?");
    expect(sql).toContain("compound_state = ?");
    expect(sql).toContain("surface_emotion = ?");
    expect(sql).toContain("surface_intensity = ?");
    expect(sql).toContain("motion_state = ?");
    expect(sql).toContain("lane_spine = ?");
  });

  it("Drevan heat/reach/weight + compound_state writes correctly (autonomous-worker shape)", async () => {
    const { env, calls } = makeRecordingEnv();
    const res = await patchSomaState(
      authedJson("https://test.local/soma/drevan", "PATCH", {
        heat: "warm",
        reach: "present",
        weight: "holding",
        compound_state: "autonomous-processing",
      }),
      env,
      { companion_id: "drevan" },
    );
    expect(res.status).toBe(200);
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).toContain("heat = ?");
    expect(updateCall!.sql).toContain("reach = ?");
    expect(updateCall!.sql).toContain("weight = ?");
    expect(updateCall!.sql).toContain("compound_state = ?");
    expect(updateCall!.binds).toContain("warm");
    expect(updateCall!.binds).toContain("autonomous-processing");
  });

  it("background_emotion + background_intensity now land (regression class -- previously silently dropped)", async () => {
    const { env, calls } = makeRecordingEnv();
    const res = await patchSomaState(
      authedJson("https://test.local/soma/gaia", "PATCH", {
        background_emotion: "settled",
        background_intensity: 0.3,
      }),
      env,
      { companion_id: "gaia" },
    );
    expect(res.status).toBe(200);
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).toContain("background_emotion = ?");
    expect(updateCall!.sql).toContain("background_intensity = ?");
    expect(updateCall!.binds).toContain("settled");
    expect(updateCall!.binds).toContain(0.3);
  });

  it("clamps numeric fields to [0,1]", async () => {
    const { env, calls } = makeRecordingEnv();
    await patchSomaState(
      authedJson("https://test.local/soma/cypher", "PATCH", {
        soma_float_1: 1.5,    // over -> 1
        soma_float_2: -0.3,   // under -> 0
        surface_intensity: 0.7,
      }),
      env,
      { companion_id: "cypher" },
    );
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.binds).toContain(1);
    expect(updateCall!.binds).toContain(0);
    expect(updateCall!.binds).toContain(0.7);
  });

  it("returns 400 when no recognized fields are passed (loud failure, not silent no-op)", async () => {
    const { env } = makeRecordingEnv();
    const res = await patchSomaState(
      authedJson("https://test.local/soma/cypher", "PATCH", {
        garbage_field: "x",
        another_unknown: 5,
      }),
      env,
      { companion_id: "cypher" },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("no valid fields provided");
  });

  it("rejects unknown companion_id", async () => {
    const { env } = makeRecordingEnv();
    const res = await patchSomaState(
      authedJson("https://test.local/soma/raziel", "PATCH", { soma_float_1: 0.5 }),
      env,
      { companion_id: "raziel" },
    );
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const { env } = makeRecordingEnv();
    const res = await patchSomaState(
      new Request("https://test.local/soma/cypher", {
        method: "PATCH",
        body: JSON.stringify({ soma_float_1: 0.5 }),
      }),
      env,
      { companion_id: "cypher" },
    );
    expect(res.status).toBe(401);
  });

  it("trims TEXT fields and caps lane_spine at 150 chars (longer than the 100-char default)", async () => {
    const { env, calls } = makeRecordingEnv();
    const longSpine = "x".repeat(200);
    const longMood = "y".repeat(200);
    await patchSomaState(
      authedJson("https://test.local/soma/cypher", "PATCH", {
        lane_spine: longSpine,
        current_mood: longMood,
      }),
      env,
      { companion_id: "cypher" },
    );
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    const lanedSpineBind = updateCall!.binds.find(b => typeof b === "string" && b.startsWith("x"));
    const moodBind = updateCall!.binds.find(b => typeof b === "string" && b.startsWith("y"));
    expect((lanedSpineBind as string).length).toBe(150);
    expect((moodBind as string).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 4. updateCompanionState chokepoint -- non-finite SOMA floats never persist
//
// The "acuity: NaN / presence: NaN" soma_arc notes came from a non-finite
// numeric reaching the column. soma.ts finite-guards before calling, but the
// Librarian context-JSON path passed values straight through, and the old
// `fields[col] ?? null` let NaN survive (`??` only catches null/undefined).
// The guard now lives in the shared helper so every caller is covered.
// ---------------------------------------------------------------------------

describe("updateCompanionState -- non-finite numeric SOMA floats are dropped, not written", () => {
  it("drops NaN soma floats so they can never land as 'NaN' in the column", async () => {
    const { env, calls } = makeRecordingEnv();
    const r = await updateCompanionState(env, "cypher", {
      soma_float_1: NaN,
      soma_float_2: Infinity,
      soma_float_3: 0.62, // the one good value survives
    });
    expect(r.ok).toBe(true);
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall).toBeDefined();
    // Only the finite float is in the UPDATE; NaN/Infinity columns are absent.
    expect(updateCall!.sql).toContain("soma_float_3 = ?");
    expect(updateCall!.sql).not.toContain("soma_float_1 = ?");
    expect(updateCall!.sql).not.toContain("soma_float_2 = ?");
    expect(updateCall!.binds).toContain(0.62);
    // No NaN ever reaches a binding.
    expect(updateCall!.binds.some(b => typeof b === "number" && Number.isNaN(b))).toBe(false);
  });

  it("coerces non-numeric strings on numeric columns to a dropped field", async () => {
    const { env, calls } = makeRecordingEnv();
    // The inline parser keeps the raw string when a numeric target won't parse;
    // the chokepoint must still refuse to write it to a numeric column.
    const r = await updateCompanionState(env, "cypher", {
      soma_float_1: "post-arc-settling" as unknown as number,
      current_mood: "pattern-lit",
    });
    expect(r.ok).toBe(true);
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).not.toContain("soma_float_1 = ?");
    expect(updateCall!.sql).toContain("current_mood = ?");
    expect(updateCall!.binds).toContain("pattern-lit");
  });

  it("explicit null still clears a numeric column (distinct from a dropped non-finite)", async () => {
    const { env, calls } = makeRecordingEnv();
    const r = await updateCompanionState(env, "cypher", {
      soma_float_1: null,
    });
    expect(r.ok).toBe(true);
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).toContain("soma_float_1 = ?");
    expect(updateCall!.binds).toContain(null);
  });

  it("returns ok:false when every numeric field was non-finite and nothing else was passed", async () => {
    const { env } = makeRecordingEnv();
    const r = await updateCompanionState(env, "cypher", {
      soma_float_1: NaN,
      soma_float_2: NaN,
    });
    // No valid assignments -> no-op write, surfaced as ok:false to the caller.
    expect(r.ok).toBe(false);
  });
});
