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
  // Starts at prefixPattern (2026-08-15) so the short-id branch is inside the asserted block.
  const start = SRC.indexOf("const prefixPattern = providedId");
  expect(start, "session resolution block not found").toBeGreaterThan(-1);
  const end = SRC.indexOf(".first<{ id: string }>()", start);
  expect(end, "end of the resolution query not found").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("execSessionClose -- unattended session scope", () => {
  it("accepts session_scope in the close payload type", () => {
    expect(SRC).toContain('session_scope?: "unattended"');
  });

  it("adds surface IS NULL only on the unattended branch", () => {
    // Count in the SQL only -- the block's comments legitimately name the phrase.
    const block = resolutionBlock().split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
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
    // Three-way ordering (2026-08-15): exact id, then prefix hit, then the open-session fallback.
    const ordering = block.match(/CASE WHEN id = \? THEN 0 WHEN id LIKE \? THEN 1 ELSE 2 END/g) ?? [];
    expect(ordering.length, "exact-id then prefix must sort ahead of the fallback").toBe(2);
  });

  it("binds the same seven parameters regardless of branch", () => {
    // One .bind() shared by both statements -- a per-branch bind list is how the parameter order
    // drifts out of step with the SQL and starts resolving the wrong row.
    const block = resolutionBlock();
    const binds = block.match(/\.bind\(providedId, prefixPattern, ctx\.req\.companion_id, ctx\.req\.companion_id, providedId, providedId, prefixPattern\)/g) ?? [];
    expect(binds.length).toBe(1);
  });

  // ── Short-id prefix resolution + newborn guard (2026-08-15, task 6473947d) ──────────

  it("resolves a short id by prefix, scoped to this companion", () => {
    const block = resolutionBlock();
    // The LIKE branch must carry the companion scope -- an unscoped prefix could close a
    // SIBLING's session on a 6-char collision.
    const scoped = block.match(/id LIKE \? AND companion_id = \?/g) ?? [];
    expect(scoped.length, "prefix branch must be companion-scoped in both statements").toBe(2);
  });

  it("only builds a prefix pattern from a bare hex/dash prefix, never a full id or wildcards", () => {
    // The pattern is charset-gated so a caller-supplied string can never smuggle % or _
    // into the LIKE. A full 36-char UUID takes the exact-match branch instead.
    expect(SRC).toContain("providedId.length < 36");
    expect(SRC).toMatch(/\^\[0-9a-fA-F\]\[0-9a-fA-F-\]\{5,34\}\$/);
  });

  it("the fallback never closes a session younger than the request when an id was provided", () => {
    const block = resolutionBlock();
    // `? IS NULL` binds providedId: the guard is active ONLY when an id was provided and
    // missed -- the id-less auto-resolve path (companion closing its own loom) is untouched.
    const guards = block.match(/\? IS NULL OR datetime\(created_at\) <= datetime\('now','-2 minutes'\)/g) ?? [];
    expect(guards.length, "newborn guard must sit on the fallback branch of both statements").toBe(2);
  });

  it("normalizes created_at before comparing -- sessions are stamped ISO, datetime('now') is not", () => {
    const block = resolutionBlock();
    // Raw string comparison between '2026-08-15T...' and '2026-08-15 ...' excludes every
    // same-day row ('T' > ' '), which would silently disable the fallback for the whole day.
    expect(block).toContain("datetime(created_at)");
    expect(block).not.toMatch(/\bcreated_at <= datetime/);
  });

  it("a prefix hit is a resolution, not a fallback", () => {
    // The session_id_warning must not fire when the caller's short id resolved to its own
    // session -- an accepted-and-warned close reads as a misfire and trains warning blindness.
    expect(SRC).toContain("resolvedViaPrefix");
    expect(SRC).toMatch(/sessionIdFallback = providedId !== null && resolvedSessionId !== null\s*&& resolvedSessionId !== providedId && !resolvedViaPrefix/);
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
