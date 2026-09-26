// THE TRAY SWEEP (imp tray pass 2, 2026-09-26). A static test over src/: every SQL literal that reads
// companion_journal or wm_continuity_notes must carry the review_state gate, or sit on the allowlist
// below with a written reason. Every INSERT into either table must go through webmind/tray-insert.ts.
//
// Why static: the first pass (mig 0132) gated the recall and orient reads it knew about. Two reviews
// then found a dozen it did not -- synthesis jobs, motifs, the creature nest, pattern recall, journal
// search, sit reads, note compaction -- each one a door a draft walked through into "memory". A list
// of known sites rots the day a new query is written; this fails on the new query instead.
//
// How: the TypeScript compiler API walks every string and template literal (regex over source text
// trips on multi-line templates, SQL `--` comments and JS comments naming the tables). A literal is
// GATED when its own text contains `review_state` or interpolates KEPT_SQL / KEPT_LIVE_SQL. A literal
// that interpolates a built WHERE (`${where}`, `${conditions.join(...)}`) is gated when its enclosing
// function's code (comments stripped) names the gate.
//
// Blind spot, stated: SQL whose TABLE NAME is interpolated (`FROM ${w.table}` in tray.ts,
// warmSql(...), tray-insert.ts's `INSERT INTO ${table}`) is invisible here. Those sites are few and
// each has its own behavioural test.

import { describe, it, expect } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../", import.meta.url).href);

interface Allow { file: string; match: string; reason: string }

// file is relative to src/, forward slashes; match is a substring of the literal's source text.
const ALLOW: Allow[] = [
  // ── Idempotency / write gates: a draft must still dedupe, or it is re-written every run ──
  { file: "webmind/notes.ts", match: "SELECT note_id, content, created_at FROM wm_continuity_notes\n       WHERE agent_id = ? AND archived = 0 AND thread_key = ?", reason: "addNote's 10-minute thread write gate: drafts must dedupe too, or a pulse floods the thread" },
  { file: "librarian/executors/writes.ts", match: "WHERE agent_id = ? AND note_type = 'soma_arc' AND archived = 0", reason: "soma_arc 15-minute inflection gate (soma_arc is companion-authored, born kept)" },
  { file: "webmind/vibecheck.ts", match: "FROM companion_journal", reason: "vibecheck once-a-day idempotency lookup: today's digest is a draft, so gating it re-sends the letter every run" },
  { file: "webmind/briefing.ts", match: "WHERE agent = 'steward' AND created_at >= date('now') AND tags LIKE ?", reason: "briefing once-a-day idempotency lookup (steward letters, born kept)" },

  // ── Liveness / health / counts: a draft is still a WRITE ──
  { file: "guardian/writer-liveness.ts", match: "SELECT MAX(created_at) AS ts FROM companion_journal", reason: "writer liveness: is the speech journaler writing at all -- drafts are exactly its output" },
  { file: "guardian/writer-liveness.ts", match: "SELECT MAX(created_at) AS ts FROM wm_continuity_notes", reason: "writer liveness for the notes store" },
  { file: "handlers/health.ts", match: "SELECT MAX(created_at) AS t FROM companion_journal WHERE agent = ?", reason: "health: minutes since each companion last journaled (any state)" },
  { file: "librarian/executors/self-monitoring.ts", match: "SELECT created_at FROM companion_journal WHERE agent = 'guardian'", reason: "guardian's last letter timestamp; no text enters a prompt" },
  { file: "handlers/edges.ts", match: "SELECT COUNT(*) FROM wm_continuity_notes WHERE archived = 0", reason: "edge-provenance instrument: counts addressable notes, no text read" },
  { file: "handlers/sessions.ts", match: "SELECT session_id, COUNT(*) AS note_count", reason: "Hearth sessions list: per-session note counts" },
  { file: "soma/events.ts", match: "SELECT session_id, COUNT(*) AS n FROM companion_journal", reason: "soma attribution: counts rows per session, no text read" },
  { file: "webmind/stale-session-sweep.ts", match: "SELECT count(*) AS n FROM companion_journal", reason: "stale-session evidence: counts session-sourced rows in a window, reads no text" },
  { file: "webmind/stale-session-sweep.ts", match: "SELECT count(*) AS n FROM wm_continuity_notes", reason: "stale-session evidence: counts rows in a window, reads no text" },

  // ── Companion-authored lanes (born kept by the rule; the writer is the companion itself) ──
  { file: "webmind/orient.ts", match: "note_type = 'soma_arc' AND archived = 0", reason: "soma_arc: the companion's own state write echoed as a note -- companion-authored, born kept" },
  { file: "webmind/orient.ts", match: "note_type = 'conversation_capture' AND archived = 0", reason: "conversation_capture: what Raziel said, taken down by the companion in a human session (HUMAN_SOURCES) -- born kept" },

  // ── Ops that must reach EVERY state ──
  { file: "webmind/tray.ts", match: "FROM companion_journal WHERE id = ? AND agent = ?", reason: "the tray itself: read draft <id> shows any state (draft/kept/dropped) so a decision can be made or re-checked" },
  { file: "webmind/tray.ts", match: "FROM wm_continuity_notes WHERE note_id = ? AND agent_id = ?", reason: "the tray itself: read draft <id> for a note, any state" },
  { file: "webmind/notes.ts", match: "DELETE FROM wm_continuity_notes WHERE note_id IN", reason: "cap eviction deletes exactly the ids the KEPT-gated overflow SELECT above chose" },
  { file: "webmind/vocabulary-guards.ts", match: "'companion_journal' AS source", reason: "contamination detector: counts who SAID a token -- drafts are the speech; yields a verdict, never recall" },
  { file: "handlers/retract.ts", match: "SELECT id, archived FROM companion_journal WHERE agent = ? AND external_id IN", reason: "retract must find drafts (the usual case) and already-archived rows" },
  { file: "handlers/retract.ts", match: "SELECT note_id, archived FROM wm_continuity_notes WHERE agent_id = ? AND correlation_id IN", reason: "retract must find drafts and already-archived rows" },
  { file: "handlers/admin.ts", match: "SELECT id, note_text, agent FROM companion_journal", reason: "rebuild-embeddings: the index mirrors D1 (drafts are embedded; the READ hydration gates them)" },
  { file: "handlers/admin.ts", match: "SELECT note_id AS id, content, agent_id FROM wm_continuity_notes", reason: "rebuild-embeddings (notes)" },
  { file: "handlers/admin.ts", match: "SELECT note_id AS id FROM wm_continuity_notes", reason: "vector coverage audit: id sets only" },
  { file: "handlers/admin.ts", match: "SELECT id FROM companion_journal", reason: "vector coverage audit: id sets only" },
  { file: "handlers/admin.ts", match: "SELECT note_id AS id, content AS text, agent_id AS companion FROM wm_continuity_notes", reason: "vector coverage fill: embeds missing rows, index mirrors D1" },
  { file: "handlers/admin.ts", match: "SELECT id, note_text AS text, agent AS companion FROM companion_journal", reason: "vector coverage fill (journal)" },
  { file: "mind/note-provenance.ts", match: "SELECT note_id, thread_key, created_at FROM wm_continuity_notes WHERE note_id IN", reason: "provenance of note ids ALREADY selected by a gated read; reads no text" },

  // ── Human (Raziel) display / signal plumbing ──
  { file: "handlers/presence.ts", match: "FROM companion_journal ORDER BY created_at DESC LIMIT 6", reason: "Hearth /halseth + /house display only (see comment at the call site); no companion prompt reads /presence" },
  { file: "librarian/backends/halseth.ts", match: "WHERE agent = ? AND tags LIKE '%signal_audit%'", reason: "signal-audit rows are Cypher's own authored audits (source NULL, born kept); tag-scoped" },
  { file: "mcp/tools/session_load.ts", match: "WHERE agent = ? AND tags LIKE '%signal_audit%'", reason: "signal-audit presence flag (id + date only)" },
];

// ── the scan ──────────────────────────────────────────────────────────────────────────────────────

const READ_RE = /\b(?:FROM|JOIN)\s+(?:companion_journal|wm_continuity_notes)\b/i;
const INSERT_RE = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(?:companion_journal|wm_continuity_notes)\b/i;
// A PREDICATE on review_state -- a SELECT that merely lists the column is not a gate.
const GATE_RE = /review_state\s*(?:=|IN\b)|\$\{\s*KEPT_(?:LIVE_)?SQL\s*\}/i;
const DYNAMIC_WHERE_RE = /\$\{\s*(?:where|conditions\.join\([^)]*\))\s*\}/;

interface Hit { file: string; line: number; text: string; gated: boolean }

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__") walk(p, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function scan(): { reads: Hit[]; inserts: Hit[] } {
  const files: string[] = [];
  walk(SRC, files);
  const reads: Hit[] = [];
  const inserts: Hit[] = [];
  for (const abs of files) {
    const rel = path.relative(SRC, abs).split(path.sep).join("/");
    const src = fs.readFileSync(abs, "utf8");
    if (!/companion_journal|wm_continuity_notes/.test(src)) continue;
    const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node, insideTemplate: boolean): void => {
      const isLit = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      if (isLit && !insideTemplate) {
        const text = node.getText(sf);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (INSERT_RE.test(text)) inserts.push({ file: rel, line, text, gated: false });
        if (READ_RE.test(text)) {
          let gated = GATE_RE.test(text);
          if (!gated && DYNAMIC_WHERE_RE.test(text)) {
            let fn: ts.Node | undefined = node.parent;
            while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
            if (fn) gated = /\bKEPT_(?:LIVE_)?SQL\b|["'`]review_state\s*(?:=|IN\b)/i.test(stripComments(fn.getText(sf)));
          }
          reads.push({ file: rel, line, text, gated });
        }
      }
      ts.forEachChild(node, (c) => visit(c, insideTemplate || ts.isTemplateExpression(node)));
    };
    visit(sf, false);
  }
  return { reads, inserts };
}

const normalize = (s: string) => s.replace(/\r\n/g, "\n");

describe("tray sweep: every read of the two first-person stores is gated or allowlisted with a reason", () => {
  const { reads, inserts } = scan();

  it("finds the reads at all (the scanner is not silently blind)", () => {
    expect(reads.length).toBeGreaterThan(40);
    expect(reads.filter(r => r.gated).length).toBeGreaterThan(25);
  });

  it("no ungated read outside the allowlist", () => {
    const ungated = reads.filter(r => !r.gated);
    const unexplained = ungated.filter(r => !ALLOW.some(a => a.file === r.file && normalize(r.text).includes(a.match)));
    const report = unexplained.map(r => `${r.file}:${r.line}  ${normalize(r.text).replace(/\s+/g, " ").slice(0, 160)}`);
    expect(report, "ungated reads of companion_journal / wm_continuity_notes -- add the review_state gate, or an ALLOW entry with a reason").toEqual([]);
  });

  it("every allowlist entry still matches an ungated read (no stale exemptions)", () => {
    const ungated = reads.filter(r => !r.gated);
    const stale = ALLOW.filter(a => !ungated.some(r => r.file === a.file && normalize(r.text).includes(a.match)));
    expect(stale.map(a => `${a.file}: ${a.match.slice(0, 80)}`)).toEqual([]);
    for (const a of ALLOW) expect(a.reason.length, a.match).toBeGreaterThan(15);
  });

  it("no INSERT INTO either store outside webmind/tray-insert.ts (the birth rule is the only door in)", () => {
    expect(inserts.map(i => `${i.file}:${i.line}`)).toEqual([]);
    const helper = fs.readFileSync(path.join(SRC, "webmind/tray-insert.ts"), "utf8");
    expect(helper).toMatch(/reviewStateFor\(/);
  });
});
