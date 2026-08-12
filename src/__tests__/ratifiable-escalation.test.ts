// The nightly reflection is a LOG by default; the companion RAISES what is canon-changing
// (2026-08-12, Raziel's call).
//
// These are pure predicate tests run against real SQLite semantics via a tiny in-memory matcher,
// because the whole change lives in two SQL string constants and the failure mode is silent: a
// wrong predicate does not throw, it just quietly decides which of a companion's self-reads a human
// ever sees.

import { describe, it, expect } from "vitest";
import {
  RATIFIABLE_PENDING_SQL,
  VAULT_WORTHY_SQL,
  LOGGED_REFLECTION_SQL,
  ESCALATION_TAG,
} from "../lib/ratifiable.js";

type Row = { source: string; review_status: string; tags: string[] };

const RAISED = ["vibecheck-reflection", ESCALATION_TAG];
const PLAIN = ["vibecheck-reflection"];

/**
 * Evaluate one of the SQL predicates against a row, by translating the three constructs these
 * predicates actually use (column compare, LIKE on tags_json, boolean algebra) into JS. Faithful
 * enough to catch an inverted NOT or a missing clause, which is the whole risk here.
 */
function evaluate(sql: string, row: Row): boolean {
  const tagsJson = JSON.stringify(row.tags);
  const js = sql
    .replace(/tags_json LIKE '%"([^"]+)"%'/g, (_m, tag) => JSON.stringify(tagsJson.includes(`"${tag}"`)))
    .replace(/source = '([^']+)'/g, (_m, v) => JSON.stringify(row.source === v))
    .replace(/review_status = '([^']+)'/g, (_m, v) => JSON.stringify(row.review_status === v))
    .replace(/\bNOT\b/g, "!")
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||");
  return Function(`"use strict";return (${js});`)() as boolean;
}

const rows: Record<string, Row> = {
  raisedReflection:   { source: "reflection",  review_status: "pending",  tags: RAISED },
  plainReflection:    { source: "reflection",  review_status: "pending",  tags: PLAIN },
  acceptedReflection: { source: "reflection",  review_status: "accepted", tags: PLAIN },
  declinedReflection: { source: "reflection",  review_status: "declined", tags: PLAIN },
  pendingAutonomous:  { source: "autonomous",  review_status: "pending",  tags: [] },
  acceptedAutonomous: { source: "autonomous",  review_status: "accepted", tags: [] },
};

describe("the ratification queue", () => {
  it("holds an autonomous entry unconditionally", () => {
    expect(evaluate(RATIFIABLE_PENDING_SQL, rows.pendingAutonomous)).toBe(true);
  });

  it("holds a nightly reflection ONLY when the companion raised it", () => {
    expect(evaluate(RATIFIABLE_PENDING_SQL, rows.raisedReflection)).toBe(true);
    // The 33-of-40 case: an ordinary nightly self-read no longer blocks in a to-do list.
    expect(evaluate(RATIFIABLE_PENDING_SQL, rows.plainReflection)).toBe(false);
  });

  it("never re-queues something already given a verdict", () => {
    for (const r of [rows.acceptedReflection, rows.declinedReflection, rows.acceptedAutonomous]) {
      expect(evaluate(RATIFIABLE_PENDING_SQL, r)).toBe(false);
    }
  });
});

describe("what belongs in the vault", () => {
  it("includes accepted canon AND unraised logs, so nothing becomes unsearchable", () => {
    expect(evaluate(VAULT_WORTHY_SQL, rows.acceptedAutonomous)).toBe(true);
    expect(evaluate(VAULT_WORTHY_SQL, rows.acceptedReflection)).toBe(true);
    // The reason this clause exists: an unraised reflection will never be accepted, so gating the
    // vault on acceptance would make every future nightly self-read unfindable.
    expect(evaluate(VAULT_WORTHY_SQL, rows.plainReflection)).toBe(true);
  });

  it("excludes a declined entry -- declining is a verdict, not an absence of one", () => {
    expect(evaluate(VAULT_WORTHY_SQL, rows.declinedReflection)).toBe(false);
  });

  it("excludes a RAISED reflection: it is awaiting a verdict, not sitting as a log", () => {
    expect(evaluate(VAULT_WORTHY_SQL, rows.raisedReflection)).toBe(false);
  });

  it("excludes a pending autonomous entry -- ratification still gates canon", () => {
    expect(evaluate(VAULT_WORTHY_SQL, rows.pendingAutonomous)).toBe(false);
  });

  it("classifies every row shape into exactly one destination", () => {
    // The write/delete thrash is prevented structurally (the sweep is literally `NOT
    // VAULT_WORTHY_SQL`, asserted in growth-handlers.test.ts) -- asserting `worthy && !worthy`
    // here would be a test that cannot fail. What IS worth pinning is the classification itself,
    // because a row that lands in neither bucket is invisible everywhere: not a to-do, not canon,
    // not in the vault.
    const expected: Record<string, "queue" | "vault" | "neither"> = {
      raisedReflection: "queue",
      plainReflection: "vault",
      acceptedReflection: "vault",
      declinedReflection: "neither", // declined on purpose: a verdict was given
      pendingAutonomous: "queue",
      acceptedAutonomous: "vault",
    };
    for (const [name, row] of Object.entries(rows)) {
      const queued = evaluate(RATIFIABLE_PENDING_SQL, row);
      const worthy = evaluate(VAULT_WORTHY_SQL, row);
      const got = queued ? "queue" : worthy ? "vault" : "neither";
      expect(got, `${name} landed in ${got}`).toBe(expected[name]);
    }
  });

  it("keeps queue and vault mutually exclusive: nothing is both a to-do and canon", () => {
    for (const [name, row] of Object.entries(rows)) {
      const queued = evaluate(RATIFIABLE_PENDING_SQL, row);
      const worthy = evaluate(VAULT_WORTHY_SQL, row);
      expect(queued && worthy, `${name} is queued for review AND already in the vault`).toBe(false);
    }
  });
});

describe("LOGGED_REFLECTION_SQL", () => {
  it("matches exactly the unraised, unreviewed nightly reflection", () => {
    expect(evaluate(LOGGED_REFLECTION_SQL, rows.plainReflection)).toBe(true);
    expect(evaluate(LOGGED_REFLECTION_SQL, rows.raisedReflection)).toBe(false);
    expect(evaluate(LOGGED_REFLECTION_SQL, rows.acceptedReflection)).toBe(false);
    expect(evaluate(LOGGED_REFLECTION_SQL, rows.pendingAutonomous)).toBe(false);
  });

  it("is not fooled by a tag that merely contains the escalation token", () => {
    const nearMiss: Row = {
      source: "reflection",
      review_status: "pending",
      tags: ["needs-raziel-eventually"],
    };
    // Quoted-token matching: '%"needs-raziel"%' must not match "needs-raziel-eventually", or a
    // companion could escalate by accident and a log would silently become a to-do.
    expect(evaluate(LOGGED_REFLECTION_SQL, nearMiss)).toBe(true);
    expect(evaluate(RATIFIABLE_PENDING_SQL, nearMiss)).toBe(false);
  });
});
