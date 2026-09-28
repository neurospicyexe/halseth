// GET /mind/drives/:companion_id carries hours_since_event (B7 step 4, 2026-09-28).
//
// The bots' justification gate reads "he is here" from relational_need's last_event_at, which only
// contactDrive writes (an owner arrival on that companion's bot). The response never carried the
// stamp, so the gate could not see it. These tests fail on the old handler (no field at all), and
// pin the one trap: hoursSinceIso reads a missing or unparseable stamp as 0 hours, which would make
// "no stamp" look like "he was here a moment ago" and open the gate on nothing.

import { describe, it, expect, vi, afterEach } from "vitest";
import { getDrives } from "../handlers/drives.js";
import type { Env } from "../types.js";

type Row = { id: string; drive_key: string; level: number; accumulate_per_day: number; decay_on_contact: number; threshold: number; last_event_at: string | null };

function env(rows: Row[]): Env {
  return {
    ADMIN_SECRET: "admin-tok",
    DB: {
      prepare: (_sql: string) => ({
        bind: (..._b: unknown[]) => ({ all: async () => ({ results: rows }) }),
      }),
    },
  } as unknown as Env;
}

const req = () => new Request("https://h.example/mind/drives/drevan", { headers: { Authorization: "Bearer admin-tok" } });
const NOW = Date.parse("2026-09-28T18:00:00Z");
afterEach(() => vi.useRealTimers());

async function drives(rows: Row[]) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const res = await getDrives(req(), env(rows), { companion_id: "drevan" });
  expect(res.status).toBe(200);
  return (await res.json() as { drives: Array<Record<string, unknown>> }).drives;
}

const need = (last_event_at: string | null): Row => ({
  id: "d1", drive_key: "relational_need", level: 0.0013, accumulate_per_day: 0.4, decay_on_contact: 0.5, threshold: 0.6, last_event_at,
});

describe("GET /mind/drives: hours_since_event", () => {
  it("reports hours since the D1 stamp (space-separated UTC, as contactResetSql writes it)", async () => {
    const [d] = await drives([need("2026-09-28 16:30:00")]);
    expect(d!["hours_since_event"]).toBeCloseTo(1.5, 3);
  });

  it("reads an ISO stamp the same way", async () => {
    const [d] = await drives([need("2026-09-28T12:00:00.000Z")]);
    expect(d!["hours_since_event"]).toBeCloseTo(6, 3);
  });

  it("a missing stamp is null, never 0 (0 would read as 'he was just here')", async () => {
    const [d] = await drives([need(null)]);
    expect(d!["hours_since_event"]).toBeNull();
  });

  it("an unparseable stamp is null, never 0", async () => {
    const [d] = await drives([need("not a time")]);
    expect(d!["hours_since_event"]).toBeNull();
  });

  it("leaves the existing fields as they were", async () => {
    const [d] = await drives([need("2026-09-28 16:30:00")]);
    expect(d).toMatchObject({ drive_key: "relational_need", threshold: 0.6, fired: false, modality: null });
    expect(d!["level"]).toBeCloseTo(0.0013 + 0.4 * (1.5 / 24), 4);
  });
});
