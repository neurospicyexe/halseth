// GET /ingest/tensions filters (2026-08-14).
//
// Two defects behind one symptom: Raziel reported the settle/release buttons on Hearth "aren't
// clickable". Both buttons worked -- a real settle through the Hearth route returned 200 and moved
// gaia's charge from 2 to 0 in prod. What was broken was the READ behind them:
//
//   1. `companion_id` was ACCEPTED AND IGNORED, so every per-companion tension view showed all
//      three companions' rows.
//   2. There was no status filter at all, so Hearth's "Active Tensions" listed crystallized and
//      released tensions too -- a released one came straight back on the next load, which is
//      exactly what a broken button looks like from the outside.
//
// The invariant that matters most here is the DEFAULT. This endpoint is also the second-brain sync
// feed (`since` / `updated_since`), and a status change TO released is precisely what that sweep
// carries. Defaulting to simmering would have hidden those rows and broken status syncing silently.

import { describe, it, expect } from "vitest";
import { getIngestTensions } from "../handlers/ingest.js";

interface Captured { sql: string; args: unknown[] }

function makeEnv(captured: Captured[]) {
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare(sql: string) {
        const entry: Captured = { sql, args: [] };
        const stmt = {
          bind(...a: unknown[]) { entry.args = a; captured.push(entry); return stmt; },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
    },
  } as unknown as Parameters<typeof getIngestTensions>[1];
}

async function call(query: string): Promise<Captured> {
  const captured: Captured[] = [];
  const res = await getIngestTensions(
    new Request(`https://x/ingest/tensions${query}`, {
      headers: { Authorization: "Bearer test-secret" },
    }),
    makeEnv(captured),
  );
  expect(res.status).toBe(200);
  expect(captured.length).toBe(1);
  return captured[0]!;
}

/** Collapse whitespace so assertions test the QUERY, not its formatting. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("GET /ingest/tensions -- companion_id", () => {
  it("filters by companion_id, which it used to accept and ignore", async () => {
    const { sql, args } = await call("?companion_id=gaia");
    expect(norm(sql)).toContain("companion_id = ?");
    expect(args).toContain("gaia");
  });

  it("rejects an unknown companion rather than silently returning the whole house", async () => {
    const res = await getIngestTensions(
      new Request("https://x/ingest/tensions?companion_id=nobody", {
        headers: { Authorization: "Bearer test-secret" },
      }),
      makeEnv([]),
    );
    expect(res.status).toBe(400);
  });

  it("omits the clause entirely when no companion is named", async () => {
    const { sql } = await call("");
    expect(norm(sql)).not.toContain("companion_id = ?");
  });
});

describe("GET /ingest/tensions -- status", () => {
  it("filters by status so a tending surface can ask for only live tensions", async () => {
    const { sql, args } = await call("?status=simmering");
    expect(norm(sql)).toContain("status = ?");
    expect(args).toContain("simmering");
  });

  it("rejects a status outside the enum", async () => {
    const res = await getIngestTensions(
      new Request("https://x/ingest/tensions?status=bogus", {
        headers: { Authorization: "Bearer test-secret" },
      }),
      makeEnv([]),
    );
    expect(res.status).toBe(400);
  });

  it("DEFAULTS TO UNFILTERED -- the sync feed must still see released rows", async () => {
    // The load-bearing assertion. `updated_since` exists to carry status CHANGES to second brain;
    // if a default hid released rows, releases would stop syncing and nothing would say so.
    const { sql } = await call("?updated_since=2026-08-01T00:00:00Z");
    expect(norm(sql)).not.toContain("status = ?");
    expect(norm(sql)).toContain("last_surfaced_at > ?");
  });

  it("combines both filters with the sync window instead of replacing it", async () => {
    const { sql, args } = await call("?companion_id=cypher&status=released&since=2026-08-01T00:00:00Z");
    const n = norm(sql);
    expect(n).toContain("companion_id = ?");
    expect(n).toContain("status = ?");
    expect(n).toContain("first_noted_at > ?");
    expect(args.slice(0, 3)).toEqual(["cypher", "released", "2026-08-01T00:00:00Z"]);
  });
});

describe("GET /ingest/tensions -- charge", () => {
  it("returns charge, without which settle moves a number no surface can show", async () => {
    const { sql } = await call("");
    expect(norm(sql)).toContain("charge");
  });
});
