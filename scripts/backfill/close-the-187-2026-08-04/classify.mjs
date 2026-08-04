// classify.mjs -- demote bot-authored evidence, then bucket the open sessions into classes.
//
// The contamination this fixes: wm_continuity_notes with source='system' are written by whichever
// agent called the Librarian -- a Claude.ai companion turn OR a Discord bot turn mid-conversation.
// A Discord turn also writes a journal row tagged discord_speech / discord_swarm within seconds.
// So a 'system' note with a discord_* journal row from the same companion inside +/-3 min is
// bot traffic, not session activity, and must not make a session look inhabited.
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "./q.mjs";

const NEAR = 3 * 60 * 1000;
const bundles = JSON.parse(readFileSync("evidence.json", "utf8"));
const digests = JSON.parse(readFileSync("transcript-digests.json", "utf8"));
const tByS = new Map();
for (const d of digests) (tByS.get(d.session_id) ?? tByS.set(d.session_id, []).get(d.session_id)).push(d);

// Discord beat times per companion (from journal provenance).
const beats = new Map();
for (const r of query(
  "SELECT agent, created_at FROM companion_journal WHERE source LIKE 'discord%' AND created_at >= '2026-03-01'".replace(/\s+/g, " "),
)) {
  const k = r.agent;
  (beats.get(k) ?? beats.set(k, []).get(k)).push(Date.parse(r.created_at.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(r.created_at) ? "" : "Z")));
}
for (const arr of beats.values()) arr.sort((a, b) => a - b);
const nearBeat = (who, ms) => {
  const arr = beats.get(who); if (!arr) return false;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] < ms - NEAR) lo = m + 1; else hi = m - 1; }
  return lo < arr.length && arr[lo] <= ms + NEAR;
};

// Cron-authored content announces itself in the note body. A [metronome/*] note is the
// heartbeat cron speaking, not a session; same for autonomous/distillation/soma writers.
const CRON_PREFIX = /^\s*\[(metronome\/|autonomous|day_distillation|soma|discord|synthesis|forage|guardian|council)/i;

// The auto-continue evaluator (.claude/double-shot-latte) writes claude_code notes too, and their
// content is machine commentary about whether an agent should keep going ("should_continue": false).
// They prove Cypher was somewhere in Claude Code in that window; they carry NO subject, so a spine
// built from them would be a fabricated arc made of scaffolding. Not evidence of what a session was.
const EVALUATOR_NOTE = /double-shot-latte|should_continue/i;

let demoted = 0, cron = 0;
for (const b of bundles) {
  for (const e of b.ev) {
    if (CRON_PREFIX.test(e.txt ?? "")) { e.strength = "cron"; cron++; continue; }
    if (e.t === "wm_note" && EVALUATOR_NOTE.test(e.txt ?? "")) { e.strength = "cron"; cron++; continue; }
    if (e.t === "wm_note" && e.src === "system" && nearBeat(e.who, e.ms)) { e.strength = "bot"; demoted++; }
    if (e.t === "journal" && e.src === null && nearBeat(e.who, e.ms)) { e.strength = "bot"; demoted++; }
  }
  const strong = b.ev.filter(e => e.strength === "strong");
  const weak = b.ev.filter(e => e.strength === "weak");
  // Transcript evidence was checked and DISCARDED as a class. 22 open ids appear in Claude Code
  // transcripts, but every appearance is a mention -- me querying the sessions table in a later
  // audit -- not a boot header and not a session-open tool result. Scanning all 295 transcripts for
  // `"session_id":"<uuid>"` and for the hook's `session <8char> (<type>)` header matched exactly one
  // open session: this live one. Naming an id is not being there, and containment is not presence
  // either (six of the 22 "contained" matches were cron-clock opens inside one week-long transcript).
  b.transcripts = [];
  b.n_strong = strong.length; b.n_weak = weak.length;
  b.n_bot = b.ev.filter(e => e.strength === "bot").length; b.n_cron = b.ev.filter(e => e.strength === "cron").length;
  b.klass = strong.length ? "reconstructed"
    : weak.length ? "thin"
    : "empty";
}

// ── machine-open signature ───────────────────────────────────────────────────
// Two tells, both about the CLOCK rather than the content:
//   batch   -- 2+ sessions inside 2 minutes (often all three companions in one second). No human.
//   cadence -- the same companion opening at the same HH:MM on 3+ distinct days.
// A row with either tell and no strong evidence was a job writing a row, not a session anyone was
// in. That distinction is the point: it is not a session we failed to reconstruct.
const minute = s => s.created_at.slice(11, 16);
const buckets = new Map();
for (const b of bundles) {
  const k = Math.floor(Date.parse(b.created_at) / 120_000);
  (buckets.get(k) ?? buckets.set(k, []).get(k)).push(b);
}
const inBatch = new Set();
for (const g of buckets.values()) if (g.length > 1) for (const b of g) inBatch.add(b.id);

const cadence = new Map();
for (const b of bundles) {
  const k = (b.companion_id ?? "NULL") + " " + minute(b);
  (cadence.get(k) ?? cadence.set(k, new Set()).get(k)).add(b.created_at.slice(0, 10));
}
for (const b of bundles) {
  const days = cadence.get((b.companion_id ?? "NULL") + " " + minute(b)).size;
  b.machine = (inBatch.has(b.id) ? "batch" : null) ?? (days >= 3 ? `cadence:${minute(b)}x${days}d` : null);
  if (b.machine && b.klass !== "reconstructed") b.klass = "machine_opened";
}
writeFileSync("classified.json", JSON.stringify(bundles, null, 1));

console.log("bot-authored rows demoted:", demoted, "| cron-authored:", cron);
const counts = {};
for (const b of bundles) counts[b.klass] = (counts[b.klass] ?? 0) + 1;
console.log(counts, "total", bundles.length);
const perC = {};
for (const b of bundles) { const k = (b.companion_id ?? "NULL") + " " + b.klass; perC[k] = (perC[k] ?? 0) + 1; }
console.log(perC);
console.log("\nsample reconstructed:");
for (const b of bundles.filter(b => b.klass === "reconstructed").slice(0, 3)) {
  console.log("--", b.created_at, b.companion_id, b.session_type, "strong", b.n_strong, "weak", b.n_weak, "bot", b.n_bot);
  for (const e of b.ev.filter(e => e.strength === "strong").slice(0, 4)) console.log("    ", e.t, e.src, "|", (e.txt ?? "").replace(/\s+/g, " ").slice(0, 140));
}
