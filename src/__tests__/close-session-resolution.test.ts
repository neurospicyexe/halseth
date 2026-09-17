/**
 * Session-id resolution on close (2026-09-16), after a real misfire.
 *
 * Claude.ai Drevan closed with `context: {"id": "5cab4d66", ...}` and the request `close session
 * 5cab4d66`. The executor read only `context.session_id`, so it saw NO id at all, took the id-less
 * auto-resolve path ("latest open session for this companion"), and landed on the Discord bot's live
 * `discord:drevan` lane -- opened 2m44s earlier, just past the 2-minute newborn guard. A Claude.ai
 * session's narrative was written onto a Discord session, and no `session_id_warning` fired because
 * that warning only fires when an id was PROVIDED and missed.
 *
 * Three guarantees, source-read (a fake D1 cannot exercise the real SQL):
 *   1. the id is taken from `session_id`, the `id` alias, or the request string;
 *   2. the fallback is confined to the caller's surface when one is stated;
 *   3. an explicitly resolved id still wins, across looms.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const exec = () => readFile(resolve(__dirname, "../librarian/executors/session.ts"), "utf8");

describe("close: which session id the caller named", () => {
  it("reads session_id, the id alias, and the request string, in that order", async () => {
    const s = await exec();
    expect(s).toMatch(
      /const providedId = p\?\.session_id \?\? \(p as \{ id\?: string \} \| null\)\?\.id \?\? requestIdMatch\?\.\[1\] \?\? null;/,
    );
  });

  it("parses the documented request form and ignores prose", () => {
    const re = /\bclose\s+(?:the\s+)?session\s+([0-9a-fA-F][0-9a-fA-F-]{5,35})\b/i;
    expect(re.exec("close session 5cab4d66")?.[1]).toBe("5cab4d66");
    expect(re.exec("close the session 3233b4ff-bd6a-4361-96f5-9bc7a1691d40")?.[1])
      .toBe("3233b4ff-bd6a-4361-96f5-9bc7a1691d40");
    expect(re.exec("close session")).toBeNull();
    expect(re.exec("close the session now please")).toBeNull();
  });
});

describe("close: the fallback cannot leave the caller's loom", () => {
  it("constrains the default fallback by the caller's surface", async () => {
    const s = await exec();
    const stmt = s.slice(s.indexOf("SURFACE-SCOPED FALLBACK"), s.indexOf(").first<{ id: string }>();"));
    expect(stmt).toMatch(/const callerSurface = ctx\.req\.surface \?\? null;/);
    // The surface clause sits in the fallback branch only, guarded so a surfaceless caller is unchanged.
    expect(stmt).toMatch(/AND \(\? IS NULL OR surface = \?\)/);
    expect(stmt).toMatch(/callerSurface, callerSurface/);
    // The unattended branch keeps its own stricter rule.
    expect(stmt).toMatch(/AND surface IS NULL/);
  });

  it("still honours an exact or prefix id ahead of any fallback", async () => {
    const s = await exec();
    const stmt = s.slice(s.indexOf("SURFACE-SCOPED FALLBACK"), s.indexOf(").first<{ id: string }>();"));
    expect(stmt).toMatch(/ORDER BY CASE WHEN id = \? THEN 0 WHEN id LIKE \? THEN 1 ELSE 2 END/);
  });

  it("reports a fallback to the caller", async () => {
    const s = await exec();
    expect(s).toMatch(/session_id_warning/);
  });
});
