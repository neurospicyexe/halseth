// A close-shaped request must never open a session (2026-08-15, task 6473947d).
//
// Live failure, 2026-08-15: a drafted close ("close session c3571d8c ...") missed the
// session_close fast-path triggers, fell to the classifier, which guessed a session-OPENING
// key. execSessionLoad INSERTed a NULL-surface shell session (opened_by librarian:session_load),
// and seconds later the close's latest-open fallback closed that newborn shell instead of the
// real session. Three fixes, three layers:
//   1. patterns.ts: "close the session" / "close my session" now hit the fast path directly.
//   2. router.ts: SESSION_OPENING_KEYS + isCloseShaped() reroute a close-shaped classifier
//      guess to session_close (the belt -- the classifier can still guess wrong on phrasings
//      nobody anticipated).
//   3. executors/session.ts: prefix resolution + the newborn guard (tested in
//      session-close-unattended-scope.test.ts).
// This is the mig-0114 shape again: a read-or-close-shaped request on a route that INSERTs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { matchFastPath, isCloseShaped } from "../librarian/router.js";

const ROUTER_SRC = readFileSync("src/librarian/router.ts", "utf8");

describe("close-shaped requests route to session_close", () => {
  it("fast path catches the phrasings that fell through on 2026-08-15", () => {
    for (const req of [
      "close the session",
      "close my session",
      "Close my session. Spine: shipped the capture verb.",
      "close session c3571d8c",
    ]) {
      const m = matchFastPath(req);
      expect(m?.key, `"${req}" must fast-path to session_close`).toBe("session_close");
    }
  });

  it("no close phrasing can fast-path to a session-opening key", () => {
    for (const req of [
      "close the session", "close my session", "closing session now",
      "close this halseth session", "wrap up session",
    ]) {
      const m = matchFastPath(req);
      expect(["session_open", "session_orient"]).not.toContain(m?.key ?? "");
    }
  });

  it("isCloseShaped recognizes close intent and nothing else", () => {
    expect(isCloseShaped("close session c3571d8c with spine ...")).toBe(true);
    expect(isCloseShaped("Closing the session -- here is the handover")).toBe(true);
    expect(isCloseShaped("I closed the session earlier")).toBe(true);
    // Opening intent must never be captured -- rerouting a real open would break boot.
    expect(isCloseShaped("open my session")).toBe(false);
    expect(isCloseShaped("good morning, checking in")).toBe(false);
    // "close" without session context is not a session close.
    expect(isCloseShaped("close the loop on the roster work")).toBe(false);
  });

  it("the guard reroutes rather than refuses, and tier 3 executes the guarded key", () => {
    // Source shape: the classifier's key passes through the guard before any execution.
    expect(ROUTER_SRC).toContain('const SESSION_OPENING_KEYS = new Set(["session_open", "session_orient"])');
    expect(ROUTER_SRC).toMatch(/const guardedKey = patternKey && SESSION_OPENING_KEYS\.has\(patternKey\) && isCloseShaped\(req\.request\)\s*\? "session_close"/);
    // Both tier-3 lookups must consume guardedKey -- a guard that only covers the fast-path
    // lookup leaves the KV branch still able to execute the unguarded key.
    expect(ROUTER_SRC).toContain("FAST_PATH_PATTERNS[guardedKey]");
    expect(ROUTER_SRC).toMatch(/LIBRARIAN_KV\.get\(guardedKey/);
  });
});
