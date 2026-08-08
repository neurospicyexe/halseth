// "I need to ratify some but last time I tried they wouldn't all load" (Raziel, 2026-08-01).
//
// He was right, and the number he was fighting was a floor he could never get below.
//
// Measured: 52 pending. `source='autonomous'` = 11 (reachable via every read path).
// `source='reflection'` = 41, oldest 22 DAYS -- unreachable, because every read filtered
// `source = 'autonomous'`. Unlistable means unratifiable means pending forever, while the health digest
// counted all 52.
//
// It had ALREADY been diagnosed once: `getGrowthPendingCount` carries the note "The first draft here
// filtered source = 'autonomous' and reported 10 when 55 were actually waiting: 45 of them carry
// source = 'reflection'... Both are machine-written and both need a human." The COUNT was fixed; the READ
// was not. A rule that lives in nine places diverges in eight of them, so it now lives in one.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RATIFIABLE_SOURCES, RATIFIABLE_PENDING_SQL } from "../lib/ratifiable.js";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__") walk(p, out); }
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);

describe("RATIFIABLE_PENDING_SQL", () => {
  it("covers both machine-written sources -- reflection is what was stranded", () => {
    expect(RATIFIABLE_SOURCES).toContain("autonomous");
    expect(RATIFIABLE_SOURCES).toContain("reflection");
    expect(RATIFIABLE_PENDING_SQL).toContain("'reflection'");
    expect(RATIFIABLE_PENDING_SQL).toContain("review_status = 'pending'");
  });

  it("is a bare predicate with no bind params, so it drops into any query safely", () => {
    // Inlined literals rather than `?` placeholders: adding a bind param mid-query would silently
    // reassign every positional argument after it.
    expect(RATIFIABLE_PENDING_SQL).not.toContain("?");
  });
});

describe("no read path reintroduces the autonomous-only filter", () => {
  // The regression guard. If someone re-adds `source = 'autonomous' AND review_status = 'pending'`
  // anywhere, 41 entries silently vanish from the surface again and the count stops matching.
  // ONE exemption, named explicitly rather than by loosening the pattern: the clearing pass is meant to
  // stay autonomous-only (see the next test for why). An allowlist of exact paths keeps the guard sharp --
  // a regex that tolerated the filter everywhere would let the real regression back in.
  const EXEMPT = ["clearing/pass.ts"];

  it("the stranding filter appears nowhere in src/ except the named exemption", () => {
    const offenders = FILES.filter(f => {
      const rel = f.replace(SRC, "").replace(/\\/g, "/").replace(/^\//, "");
      if (EXEMPT.includes(rel)) return false;
      const t = readFileSync(f, "utf8");
      return /source\s*=\s*'autonomous'\s+AND\s+review_status\s*=\s*'pending'/i.test(t);
    }).map(f => f.replace(SRC, "src"));
    expect(offenders).toEqual([]);
  });

  it("the exemption is not vacuous -- the exempt file still exists and still has the filter", () => {
    // If clearing/pass.ts is renamed or rewritten, this exemption must be revisited rather than sitting
    // there protecting nothing.
    const pass = readFileSync(join(SRC, "clearing", "pass.ts"), "utf8");
    expect(/source\s*=\s*'autonomous'\s+AND\s+review_status\s*=\s*'pending'/i.test(pass)).toBe(true);
  });

  it("every interpolation site is a TEMPLATE literal, not a plain string", () => {
    // A plain string containing ${RATIFIABLE_PENDING_SQL} compiles fine and ships the literal text
    // "${RATIFIABLE_PENDING_SQL}" into SQL, where it either errors or gets caught and returns 0. tsc
    // cannot catch this, so it is checked here.
    // The check is "which quote is OPEN at the interpolation", which needs a scanner, not
    // last-index arithmetic. The nearest-quote-wins version this replaces flagged any template
    // whose SQL contained a quoted literal before the interpolation -- e.g. a
    // `SUM(CASE WHEN source = 'autonomous' ...)` column ahead of the WHERE clause -- which is
    // exactly the shape of correct code. A guard that fires on correct code gets deleted.
    /** The innermost still-open string context at `index`, or "code" if none. */
    function contextAt(text: string, index: number): "code" | "'" | '"' | "`" {
      const stack: Array<"code" | "'" | '"' | "`"> = ["code"];
      const braces: number[] = [0];
      for (let i = 0; i < index; i++) {
        const c = text[i];
        const top = stack[stack.length - 1];
        if (c === "\\" && top !== "code") { i++; continue; }        // escape inside a string
        if (top === "code") {
          if (c === "'" || c === '"' || c === "`") { stack.push(c); braces.push(0); }
          else if (c === "{") braces[braces.length - 1] = (braces[braces.length - 1] ?? 0) + 1;
          else if (c === "}") {
            if ((braces[braces.length - 1] ?? 0) === 0 && stack.length > 1) { stack.pop(); braces.pop(); }
            else braces[braces.length - 1] = (braces[braces.length - 1] ?? 0) - 1;
          } else if (c === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) break; }
          else if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 1; if (i < 1) break; }
        } else if (top === "`") {
          if (c === "`") { stack.pop(); braces.pop(); }
          else if (c === "$" && text[i + 1] === "{") { stack.push("code"); braces.push(0); i++; }
        } else if (c === top) { stack.pop(); braces.pop(); }
      }
      return stack[stack.length - 1] ?? "code";
    }

    const bad: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      let at = text.indexOf("${RATIFIABLE_PENDING_SQL}");
      while (at >= 0) {
        if (contextAt(text, at) !== "`") bad.push(f.replace(SRC, "src"));
        at = text.indexOf("${RATIFIABLE_PENDING_SQL}", at + 1);
      }
    }
    expect(bad).toEqual([]);

    // The guard is not vacuous: a plain-string interpolation IS caught, a template one is not,
    // and a quoted SQL literal earlier in the same template does not fool it.
    const ctxOfMarker = (src: string) => contextAt(src, src.indexOf("${RATIFIABLE_PENDING_SQL}"));
    expect(ctxOfMarker('const s = "WHERE ${RATIFIABLE_PENDING_SQL}"')).toBe('"');
    expect(ctxOfMarker("const s = 'WHERE ${RATIFIABLE_PENDING_SQL}'")).toBe("'");
    expect(ctxOfMarker("const s = `WHERE ${RATIFIABLE_PENDING_SQL}`")).toBe("`");
    expect(ctxOfMarker("const s = `WHEN x = 'a' AND ${RATIFIABLE_PENDING_SQL}`")).toBe("`");
  });

  it("the clearing pass is DELIBERATELY excluded -- widening what a model may DISPOSE OF is Raziel's call", () => {
    // Widening what he can SEE is safe. The clearing pass asks a model for a dismiss verdict, and
    // extending that to a new class of his entries is the line drawn for supersession in mig 0112.
    const pass = readFileSync(join(SRC, "clearing", "pass.ts"), "utf8");
    expect(pass).not.toContain("RATIFIABLE_PENDING_SQL");
    expect(pass).toContain("source = 'autonomous'");
  });
});
