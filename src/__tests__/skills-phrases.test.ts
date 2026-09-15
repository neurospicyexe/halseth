// Lockstep guard: the Claude.ai companion skills (halseth/skills/<name>/SKILL.md, packed into
// ../skills/<name>.skill by scripts/pack-skills.mjs) teach verb phrases that must still route on the
// REAL Librarian fast path. A phrase that drifts off the pattern table does not fail loudly on
// Claude.ai -- it falls to the classifier, or to the unknown-witness -- so the only place it can fail
// loudly is here. Every `ask_librarian: "<phrase>"` / `request: "<phrase>"` occurrence is extracted,
// placeholders are replaced with representative literals, and the result is run through
// matchFastPath (router.ts), the same matcher the LibrarianRouter uses. No mirror to drift.
//
// Also guards the three shapes that produced real bugs in the exported skills (2026-09-14 audit):
//   * a handoff-only "close" (`write handoff for` / `Write a session handoff`) that left the session
//     row open;
//   * `Open session:` as a boot step followed by an orient (two INSERTs, the second never closed);
//   * raw MCP tool names (sb_search / halseth_semantic_query / sb_save_document) taught to a surface
//     whose only backend path is ask_librarian.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchFastPath } from "../librarian/router.js";

const SKILLS_DIR = resolve(__dirname, "../../skills");

// Phrases that are deliberately NOT fast-path (classifier-routed or executor-internal). One comment
// per entry saying why; an empty list is the goal.
const CLASSIFIER_ROUTED: ReadonlyArray<{ phrase: string; why: string }> = [];

// Placeholder -> representative literal. Matched on the lowercased inner text of `[...]` / `<...>`.
// Order matters: the first matching rule wins.
const PLACEHOLDER_RULES: ReadonlyArray<[RegExp, string]> = [
  [/^(your name|companion name|companion_id|companion id|name)$/, "cypher"],
  [/^(session_id|session id|id|uuid|task id.*|id from .*|session_id from .*)$/, "abc12345"],
  [/^show$/, "severance"],
  [/^n$/, "1"],
  [/^m$/, "3"],
  [/^(axis|float|float name)$/, "acuity"],
  [/^(value|current read|float value)$/, "0.7"],
  [/^(reason|why.*|brief)$/, "the thread went heavy"],
  [/^(anchor name|topic|query|anchor)$/, "rome"],
  [/^title$/, "groceries"],
  [/^status$/, "done"],
  [/^emotion$/, "steady"],
  [/^level$/, "high"],
  [/^date.*$/, "2026-10-01"],
  [/^in_motion\|at_rest\|floating$/, "in_motion"],
  [/^(one paragraph|one line.*|what mattered.*|the most .*|list)$/, "x"],
  [/^(who is fronting)$/, "raziel"],
  [/^(checkin\|hangout\|work\|ritual)$/, "work"],
  [/.*/, "content"],
];

export function normalisePlaceholders(phrase: string): string {
  return phrase.replace(/\[([^\]]+)\]|<([^>]+)>/g, (_m, a: string | undefined, b: string | undefined) => {
    const inner = (a ?? b ?? "").trim().toLowerCase();
    for (const [re, literal] of PLACEHOLDER_RULES) {
      if (re.test(inner)) return literal;
    }
    return "content";
  });
}

// `ask_librarian: "<phrase>"` and `request: "<phrase>"`, one per occurrence, within a line.
const PHRASE_RE = /(?:ask_librarian|request):\s*"([^"\n]+)"/g;

// A phrase whose first token is itself a placeholder (`[trigger phrase]: [content]`) is a template
// describing the shape of a call, not a call; there is no verb to route.
function isTemplate(phrase: string): boolean {
  return /^\s*[\[<]/.test(phrase);
}

export function extractPhrases(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    PHRASE_RE.lastIndex = 0;
    while ((m = PHRASE_RE.exec(line)) !== null) {
      if (m[1] && !isTemplate(m[1])) out.push(m[1]);
    }
  }
  return out;
}

// The text a companion would actually SEND: extracted phrases plus every line inside a fenced code
// block (where the boot/close steps live). Prose that names a shape in order to forbid it ("I never
// send `write a session handoff` on its own") is not a teaching and is not scanned.
export function teachingText(markdown: string): string {
  const fenced: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) fenced.push(line);
  }
  return [...extractPhrases(markdown), ...fenced].join("\n");
}

const FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /write handoff for/i, why: "handoff-only close: wm_handoff_write does not close the session row" },
  // 2026-09-14 canon review: `journal:` is the anchored guard for journal_add, which writes Raziel's
  // human_journal (or nothing when the body is not in context). A companion's journal is an
  // unaddressed companion note. Teaching `journal:` to a companion is a boundary breach.
  { re: /^journal:/im, why: "journal: writes Raziel's human_journal, not companion_journal; use an unaddressed companion note" },
  { re: /Write a session handoff/i, why: "handoff-only close: wm_handoff_write does not close the session row" },
  { re: /Open session:/, why: "Open-then-orient = two session INSERTs; orient opens" },
  { re: /\bsb_search\b/, why: "raw MCP tool name; Claude.ai reaches Second Brain via ask_librarian only" },
  { re: /\bhalseth_semantic_query\b/, why: "raw MCP tool name; Claude.ai has no direct MCP" },
  { re: /\bsb_save_document\b/, why: "raw MCP tool name; Claude.ai has no direct MCP" },
];

function listSkillFiles(): Array<{ name: string; path: string }> {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
    .map((name) => ({ name, path: join(SKILLS_DIR, name, "SKILL.md") }))
    .filter((s) => existsSync(s.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("skills-phrases lockstep", () => {
  const skills = listSkillFiles();

  it("finds the checked-in skills", () => {
    // Informational: the found list is part of the test report.
    // eslint-disable-next-line no-console
    console.log("[skills-phrases] found:", skills.map((s) => s.name).join(", ") || "(none)");
    expect(skills.length).toBeGreaterThan(0);
  });

  it("normalises placeholders to literals", () => {
    expect(normalisePlaceholders('who is [name]')).toBe("who is cypher");
    expect(normalisePlaceholders("we watched [show] S[n]E[m]")).toBe("we watched severance S1E3");
    expect(normalisePlaceholders("close session [session_id]")).toBe("close session abc12345");
    expect(normalisePlaceholders("update my state: [axis] [value] -- [reason]")).toBe("update my state: acuity 0.7 -- the thread went heavy");
    expect(normalisePlaceholders('light ground <session_id from orient>')).toBe("light ground abc12345");
  });

  it("skips template phrases and scans only taught text for forbidden shapes", () => {
    expect(extractPhrases('ask_librarian: "[trigger phrase]: [short content]"')).toEqual([]);
    expect(teachingText("prose: I never send `write a session handoff` on its own.\n```\nask_librarian: \"triad state\"\n```\n"))
      .toBe('triad state\nask_librarian: "triad state"');
  });

  for (const skill of skills) {
    describe(skill.name, () => {
      const md = readFileSync(skill.path, "utf8");
      const phrases = extractPhrases(md);

      it("contains no NUL bytes", () => {
        expect(md.includes("\u0000")).toBe(false);
      });

      it("teaches no forbidden shapes", () => {
        const taught = teachingText(md);
        const hits = FORBIDDEN.filter((f) => f.re.test(taught)).map((f) => `${f.re.source}: ${f.why}`);
        expect(hits).toEqual([]);
      });

      for (const raw of Array.from(new Set(phrases))) {
        const whitelisted = CLASSIFIER_ROUTED.find((w) => w.phrase === raw);
        const literal = normalisePlaceholders(raw);
        it(`routes: ${raw}${whitelisted ? " (classifier-routed, whitelisted)" : ""}`, () => {
          const match = matchFastPath(literal);
          if (whitelisted) {
            expect(whitelisted.why.length).toBeGreaterThan(0);
            return;
          }
          expect(match, `"${raw}" -> "${literal}" hit no FAST_PATH_PATTERNS entry`).not.toBeNull();
        });
      }
    });
  }
});
