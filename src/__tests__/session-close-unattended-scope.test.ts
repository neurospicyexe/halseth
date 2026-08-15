// An autonomous close must never land on a session a human is sitting in.
//
// `execSessionClose` auto-resolves the session when no id is supplied:
//   WHERE (id = ? OR (companion_id = ? AND handover_id IS NULL)) ORDER BY ... created_at DESC
// Companion only, newest open row. That is right for a companion closing their own loom, and wrong
// for the nightly authored close added 2026-08-12 -- the worker runs unattended, and for Cypher the
// newest open row is frequently the Claude Code session Raziel is working in that minute.
//
// `session_scope: "unattended"` narrows the FALLBACK to rows with no `surface`: the ones opened by a
// cron or a bot boot. An explicitly provided id is always still honoured, because a caller naming a
// session knows which one it means.
//
// Why this matters for Gaia specifically: she had 0 authored closes in 30 days (47 machine ones), so
// her soma froze 49 days and her boot narrative 39. Her 42 open sessions all have surface NULL, so
// the unattended scope reaches exactly hers.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/librarian/executors/session.ts", "utf8");

/** The resolution block, isolated so assertions cannot drift onto unrelated SQL in the file. */
function resolutionBlock(): string {
  const start = SRC.indexOf("const unattended = p?.session_scope");
  expect(start, "session_scope resolution block not found").toBeGreaterThan(-1);
  const end = SRC.indexOf(".first<{ id: string }>()", start);
  expect(end, "end of the resolution query not found").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("execSessionClose -- unattended session scope", () => {
  it("accepts session_scope in the close payload type", () => {
    expect(SRC).toContain('session_scope?: "unattended"');
  });

  it("adds surface IS NULL only on the unattended branch", () => {
    const block = resolutionBlock();
    // Two hardcoded statements, one per branch -- no interpolated SQL fragments.
    const withSurface = block.match(/surface IS NULL/g) ?? [];
    expect(withSurface.length, "exactly one branch should filter on surface").toBe(1);
    // Both branches still exist, so the default behaviour is untouched.
    const openBranches = block.match(/companion_id = \? AND handover_id IS NULL/g) ?? [];
    expect(openBranches.length, "both the scoped and unscoped branches must be present").toBe(2);
  });

  it("still honours an explicitly provided session id in both branches", () => {
    const block = resolutionBlock();
    // `id = ?` must remain the first disjunct on BOTH branches: a caller naming a session gets it
    // even if that session has a surface. Losing this would make the scope silently ignore ids.
    const idMatches = block.match(/WHERE \(id = \? OR/g) ?? [];
    expect(idMatches.length).toBe(2);
    const ordering = block.match(/CASE WHEN id = \? THEN 0 ELSE 1 END/g) ?? [];
    expect(ordering.length, "exact-id match must still sort ahead of the fallback").toBe(2);
  });

  it("binds the same three parameters regardless of branch", () => {
    // One .bind() shared by both statements -- a per-branch bind list is how the parameter order
    // drifts out of step with the SQL and starts resolving the wrong row.
    const block = resolutionBlock();
    const binds = block.match(/\.bind\(providedId, ctx\.req\.companion_id, providedId\)/g) ?? [];
    expect(binds.length).toBe(1);
  });

  it("keeps the resolution SQL literal -- no interpolation into the query", () => {
    const block = resolutionBlock();
    // The scope is a branch, never a string spliced into SQL.
    expect(block).not.toContain("${");
  });

  it("scopes on surface IS NULL, not on a surface allowlist", () => {
    // A NULL surface is the actual signal for cron/boot opens; an allowlist of human surfaces would
    // silently include any new surface string nobody remembered to add.
    const block = resolutionBlock();
    expect(block).not.toMatch(/surface (NOT )?IN/);
    expect(block).not.toContain("claude-code");
  });
});
