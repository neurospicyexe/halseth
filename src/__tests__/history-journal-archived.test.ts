// GET /companion-journal never serves archived rows (2026-09-26).
//
// This listing is what Second Brain's puller reads (`?since=<hwm>`) to mirror journal rows into the
// vault as rag/companion_journal/<id>, each wrapped in a synthesis book report. It had no
// `archived` filter. So a row retracted in Halseth (archived = 1, release logged) was still pulled
// on the next 20-minute cycle if it was newer than the high-water mark, and the retracted mistake
// reappeared in the vault, top-ranked, in the companion's own voice. Measured live: every copy of
// a fabricated number swept from three stores, then re-mirrored from the rows that named it.
// An archive that a downstream reader ignores is not an archive.

import { describe, it, expect } from "vitest";
import { getCompanionJournal } from "../handlers/history.js";

function env(capture: { sql: string[] }) {
  return {
    ADMIN_SECRET: "admin-tok",
    DB: {
      prepare: (sql: string) => {
        capture.sql.push(sql);
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    },
  } as never;
}
const req = (qs: string) => new Request(`https://h.example/companion-journal${qs}`, { headers: { Authorization: "Bearer admin-tok" } });

describe("GET /companion-journal and archived rows", () => {
  it("filters archived = 0 on the plain listing", async () => {
    const cap = { sql: [] as string[] };
    const res = await getCompanionJournal(req("?agent=drevan"), env(cap));
    expect(res.status).toBe(200);
    expect(cap.sql[0]).toMatch(/archived = 0/);
  });
  it("filters archived = 0 on the puller's since= listing too", async () => {
    const cap = { sql: [] as string[] };
    const res = await getCompanionJournal(req("?agent=drevan&since=2026-09-26T00:00:00Z"), env(cap));
    expect(res.status).toBe(200);
    expect(cap.sql[0]).toMatch(/archived = 0/);
    expect(cap.sql[0]).toMatch(/created_at > \?/);
  });
});
