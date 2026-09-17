/**
 * A council question is refused, never silently shortened (2026-09-16).
 *
 * `convene` did `question` + slice(0, 2000) on the way into D1 and then echoed the caller's FULL
 * text back in the 201 body. Raziel pasted a ~9,000-char brief from Hearth; the form has no counter,
 * the response said success and showed him his own words, and what landed was the first 2,000
 * characters -- all background, cut off mid-sentence before the brief asked anything. Council would
 * then have convened three companions on a question that never arrives at its question.
 *
 * The rule this encodes: a cap refuses, it does not quietly rewrite the payload, and it names the
 * limit and the actual length so the caller can cut it themselves. Same family as the truncation
 * lesson in `feedback_truncated_is_not_empty` -- a non-empty answer can still be cut off.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_QUESTION_CHARS } from "../handlers/council.js";

const source = () => readFile(resolve(__dirname, "../handlers/council.ts"), "utf8");
/** Comments legitimately quote the old call while explaining why it is gone; assert on code only. */
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const conveneFn = (s: string) =>
  s.slice(s.indexOf("export async function convene"), s.indexOf("// GET /mind/council/current"));

describe("POST /mind/council/convene -- question length", () => {
  it("exports the cap instead of burying a magic number", () => {
    expect(MAX_QUESTION_CHARS).toBe(2000);
  });

  it("never slices the question into the insert", async () => {
    const code = codeOnly(conveneFn(await source()));
    expect(code).not.toMatch(/question\.slice\(/);
    expect(code).toMatch(/\.bind\(id, question, askedBy\)/);
  });

  it("refuses over the cap, before any write, naming limit and length", async () => {
    const fn = conveneFn(await source());
    const guardAt = fn.indexOf("question.length > MAX_QUESTION_CHARS");
    const insertAt = fn.indexOf("insertQuestionSql()");
    expect(guardAt, "the length guard must exist").toBeGreaterThan(-1);
    expect(guardAt, "the guard must run before the insert").toBeLessThan(insertAt);
    expect(fn).toMatch(/limit: MAX_QUESTION_CHARS/);
    expect(fn).toMatch(/length: question\.length/);
    expect(fn).toMatch(/\}, 413\);/);
    // "Nothing was written" is what makes the refusal actionable rather than alarming.
    expect(fn).toMatch(/Nothing was written/);
  });

  it("still rejects an empty question with 400, unchanged", async () => {
    const s = await source();
    expect(s).toMatch(/if \(!question\) return json\(\{ error: "question is required" \}, 400\);/);
  });
});
