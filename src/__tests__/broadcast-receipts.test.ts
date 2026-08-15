// Broadcast mail must be per-recipient (mig 0120; write/read coherence review D1, 2026-08-15).
//
// Before receipts, "unread" was a predicate on the shared read_at column, so a broadcast
// (to_id IS NULL) was consumed for the WHOLE TRIAD by whichever surface polled first --
// Claude.ai orient, the Discord notes poll, or (worst) the Claude Code boot, whose copy also
// lacked a from_id guard and consumed the booting companion's own outgoing broadcasts.
//
// What this file pins:
//   1. Every unread read goes through the ONE predicate in db/inter_companion_note_reads.ts
//      (self-excluded, receipt-scoped) -- no consumer keeps a private read_at copy.
//   2. Acking writes a receipt for THE ACKING COMPANION ONLY, and touches read_at only on
//      notes addressed to that companion (read_at means "read by its addressee" now).
//   3. The three consumers (orient auto-ack, CC-boot session_load, the HTTP ack endpoint)
//      all route through ackNotesForCompanion -- the regression this guards is someone
//      "simplifying" one of them back to a raw UPDATE.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../types.js";
import {
  UNREAD_NOTES_SQL,
  unreadNotesFor,
  ackNotesForCompanion,
} from "../db/inter_companion_note_reads.js";

const srcRoot = resolve(__dirname, "..");

function fakeEnv() {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  function stmtFor(sql: string) {
    const call = { sql, bindings: [] as unknown[] };
    calls.push(call);
    const stmt = {
      bind(...b: unknown[]) { call.bindings = b; return stmt; },
      async all() { return { results: [] }; },
      async first() { return null; },
      async run() { return { meta: { changes: 0 } }; },
    };
    return stmt;
  }
  const env = {
    DB: {
      prepare(sql: string) { return stmtFor(sql); },
      async batch(stmts: unknown[]) { return stmts.map(() => ({ results: [] })); },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("the unread predicate", () => {
  it("scopes unread to the reading companion via receipts, not shared read_at", () => {
    expect(UNREAD_NOTES_SQL).toMatch(/NOT EXISTS/i);
    expect(UNREAD_NOTES_SQL).toMatch(/inter_companion_note_reads/);
    expect(UNREAD_NOTES_SQL).toMatch(/r\.companion_id = \?1/);
    // Shared-column consumption is the exact bug: unread must never key on n.read_at again.
    expect(UNREAD_NOTES_SQL).not.toMatch(/n\.read_at IS NULL/i);
  });

  it("excludes the companion's own notes (a boot must not eat its own broadcast)", () => {
    expect(UNREAD_NOTES_SQL).toMatch(/n\.from_id != \?1/);
  });

  it("still includes broadcasts", () => {
    expect(UNREAD_NOTES_SQL).toMatch(/n\.to_id IS NULL/);
  });

  it("binds the companion once for all three roles (address, self-guard, receipt)", async () => {
    const { env, calls } = fakeEnv();
    await unreadNotesFor(env, "cypher", 10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bindings).toEqual(["cypher", 10]);
  });
});

describe("ackNotesForCompanion", () => {
  it("writes one receipt per note FOR THE ACKING COMPANION ONLY", async () => {
    const { env, calls } = fakeEnv();
    await ackNotesForCompanion(env, "cypher", ["n1", "n2"], "claude-code:test");
    const receipts = calls.filter((c) => /INSERT OR IGNORE INTO inter_companion_note_reads/i.test(c.sql));
    expect(receipts).toHaveLength(2);
    for (const r of receipts) {
      expect(r.bindings[1], "receipt must belong to the acking companion").toBe("cypher");
      expect(r.bindings[2]).toBe("claude-code:test");
    }
  });

  it("touches read_at only on notes ADDRESSED to the acking companion", async () => {
    const { env, calls } = fakeEnv();
    await ackNotesForCompanion(env, "cypher", ["n1"], null);
    const updates = calls.filter((c) => /UPDATE inter_companion_notes SET read_at/i.test(c.sql));
    expect(updates).toHaveLength(1);
    // The scope that keeps a broadcast alive for the siblings: to_id = acker, never to_id IS NULL.
    expect(updates[0]!.sql).toMatch(/AND to_id = \?/);
    expect(updates[0]!.sql).not.toMatch(/to_id IS NULL/i);
  });

  it("is a no-op on an empty id list", async () => {
    const { env, calls } = fakeEnv();
    await ackNotesForCompanion(env, "cypher", [], null);
    expect(calls).toHaveLength(0);
  });
});

describe("no consumer keeps a private copy of the predicate", () => {
  // The three files that used to own divergent copies. Each must import the shared module
  // and must not query read_at IS NULL against inter_companion_notes on its own.
  const consumers = [
    "webmind/orient.ts",
    "mcp/tools/session_load.ts",
    "handlers/inter_companion_notes.ts",
  ];

  for (const rel of consumers) {
    it(`${rel} routes through db/inter_companion_note_reads`, () => {
      const src = readFileSync(resolve(srcRoot, rel), "utf8");
      expect(src, `${rel} must import the shared predicate/ack`).toMatch(/inter_companion_note_reads/);
      // A local unread query keyed on shared read_at is the regression itself.
      expect(src).not.toMatch(/FROM inter_companion_notes[^;]{0,200}read_at IS NULL[^;]{0,200}to_id IS NULL/is);
      // A raw unscoped consume: UPDATE ... read_at without the addressee scope.
      const rawUpdates = src.match(/UPDATE inter_companion_notes SET read_at[^`"']*/gi) ?? [];
      expect(rawUpdates, `${rel} must not hand-roll a read_at UPDATE`).toEqual([]);
    });
  }
});
