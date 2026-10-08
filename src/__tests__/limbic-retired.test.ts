// P3-4 (BUGS.md 2026-10-08). felt.limbic was retired by ruling 2026-09-14; the synthesis that wrote
// limbic_states stopped 2026-09-01. Both readers (Librarian `limbic_read` and GET /mind/limbic/current)
// used to hand the fossil row back as if it were current. They now wrap it so no reader can take it
// as live: stale: true, stale_since = generated_at, and a one-line note. Tables and routes stay.
import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import type { WmLimbicState } from "../webmind/types.js";
import { withLimbicRetirement, LIMBIC_RETIRED_NOTE } from "../webmind/limbic.js";
import { execLimbicRead } from "../librarian/executors/companion-growth.js";
import { getMindLimbicCurrent } from "../handlers/webmind.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

const FOSSIL: WmLimbicState = {
  state_id: "abc123",
  generated_at: "2026-09-01T06:00:00.000Z",
  synthesis_source: "halseth:sessions+feelings",
  active_concerns: "[]",
  live_tensions: "[]",
  drift_vector: "steady",
  open_questions: "[]",
  emotional_register: "pattern-lit",
  swarm_threads: "[]",
  companion_notes: "{}",
  companion_id: null,
  created_at: "2026-09-01T06:00:01.000Z",
};

function envReturning(row: WmLimbicState | null): Env {
  const stmt = {
    bind: () => stmt,
    first: async () => row,
    run: async () => ({}),
    all: async () => ({ results: [] }),
  };
  return { DB: { prepare: () => stmt }, ADMIN_SECRET: "s3cret" } as unknown as Env;
}

describe("withLimbicRetirement", () => {
  it("flags a row stale with stale_since = generated_at and the retirement note", () => {
    const out = withLimbicRetirement(FOSSIL);
    expect(out.stale).toBe(true);
    expect(out.stale_since).toBe("2026-09-01T06:00:00.000Z");
    expect(out.note).toBe(LIMBIC_RETIRED_NOTE);
    expect(out.note).toMatch(/retired 2026-09-14/);
    expect(out.limbic_state).toBe(FOSSIL);
  });

  it("is unconditional: a null row is still stale and still carries the note", () => {
    const out = withLimbicRetirement(null);
    expect(out).toEqual({ limbic_state: null, stale: true, stale_since: null, note: LIMBIC_RETIRED_NOTE });
  });
});

describe("execLimbicRead (Librarian limbic_read)", () => {
  it("returns the row with stale/stale_since/note", async () => {
    const ctx = { env: envReturning(FOSSIL), req: { companion_id: "cypher", request: "limbic read" } } as unknown as ExecutorContext;
    const r = await execLimbicRead(ctx) as Record<string, unknown>;
    expect(r.limbic_state).toBe(FOSSIL);
    expect(r.stale).toBe(true);
    expect(r.stale_since).toBe(FOSSIL.generated_at);
    expect(r.note).toBe(LIMBIC_RETIRED_NOTE);
    expect(r.meta).toEqual({ operation: "limbic_read", companion_id: "cypher" });
  });

  it("still requires companion_id", async () => {
    const ctx = { env: envReturning(FOSSIL), req: { request: "limbic read" } } as unknown as ExecutorContext;
    const r = await execLimbicRead(ctx) as Record<string, unknown>;
    expect(r.error).toBe("limbic_read_failed");
  });
});

describe("GET /mind/limbic/current", () => {
  const req = () => new Request("https://test.local/mind/limbic/current", { headers: { Authorization: "Bearer s3cret" } });

  it("returns the row with stale/stale_since/note", async () => {
    const res = await getMindLimbicCurrent(req(), envReturning(FOSSIL));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.limbic_state as WmLimbicState).state_id).toBe("abc123");
    expect(body.stale).toBe(true);
    expect(body.stale_since).toBe(FOSSIL.generated_at);
    expect(body.note).toBe(LIMBIC_RETIRED_NOTE);
  });

  it("returns stale + note even when there is no row", async () => {
    const res = await getMindLimbicCurrent(req(), envReturning(null));
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ limbic_state: null, stale: true, stale_since: null, note: LIMBIC_RETIRED_NOTE });
  });

  it("stays behind authGuard", async () => {
    const res = await getMindLimbicCurrent(new Request("https://test.local/mind/limbic/current"), envReturning(FOSSIL));
    expect(res.status).toBe(401);
  });
});
