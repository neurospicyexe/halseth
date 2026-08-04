// gather-evidence.mjs -- build a per-open-session evidence bundle.
//
// Windows are DISJOINT per companion: a window runs from a session's created_at to the next
// session start for that same companion (open OR closed -- a closed session already claimed
// its own activity), capped at CAP_H hours so a stale open row cannot swallow a week.
//
// Only companion-authored, session-shaped writes are attributable. Cron/Discord/autonomous
// provenance is excluded by source, not by time: the system being busy is not this session.
import { readFileSync, writeFileSync } from "node:fs";
import { query } from "./q.mjs";

const CAP_H = 8;
const CAP = CAP_H * 3600 * 1000;

const open = JSON.parse(readFileSync("open.json", "utf8"));

const all = query("SELECT id, companion_id, created_at, handover_id FROM sessions ORDER BY created_at");
console.log("all sessions:", all.length, "| open:", open.length);

// ── windows ──────────────────────────────────────────────────────────────────
const byCompanion = new Map();
for (const s of all) {
  const k = s.companion_id ?? "(null)";
  (byCompanion.get(k) ?? byCompanion.set(k, []).get(k)).push(s);
}
const win = new Map();
for (const [, rows] of byCompanion) {
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (let i = 0; i < rows.length; i++) {
    const start = Date.parse(rows[i].created_at);
    const nxt = rows[i + 1] ? Date.parse(rows[i + 1].created_at) : Infinity;
    win.set(rows[i].id, { start, end: Math.min(nxt, start + CAP), companion: rows[i].companion_id });
  }
}

// ── evidence pulls ───────────────────────────────────────────────────────────
// strong  = provenance proves a live companion turn wrote it
// weak    = companion-authored table with no provenance column (bots write these too)
const PULLS = [
  { t: "journal", strength: "strong", sql:
    `SELECT id, agent AS who, created_at, source AS src, substr(note_text,1,240) AS txt
     FROM companion_journal
     WHERE created_at >= '2026-03-01'
       AND (source IN ('session','cypher-session','session_close') OR source IS NULL)` },
  { t: "journal", strength: "weak", sql:
    `SELECT id, agent AS who, created_at, source AS src, substr(note_text,1,240) AS txt
     FROM companion_journal WHERE created_at >= '2026-03-01' AND source = 'legacy'` },
  { t: "wm_note", strength: "strong", sql:
    `SELECT note_id AS id, agent_id AS who, created_at, source AS src, substr(content,1,240) AS txt
     FROM wm_continuity_notes
     WHERE created_at >= '2026-03-01' AND source IN ('system','claude_code','session-log')
       AND actor = 'agent' AND note_type IN ('continuity','claude_code_session','context')` },
  { t: "conclusion", strength: "weak", sql:
    `SELECT id, companion_id AS who, created_at, belief_type AS src, substr(conclusion_text,1,240) AS txt
     FROM companion_conclusions WHERE created_at >= '2026-03-01'` },
  { t: "feeling", strength: "weak", sql:
    `SELECT id, companion_id AS who, created_at, COALESCE(source,'x') AS src, session_id AS link,
            emotion || COALESCE('/' || sub_emotion,'') || ' @' || intensity AS txt
     FROM feelings WHERE created_at >= '2026-03-01'` },
  { t: "inter_note", strength: "weak", sql:
    `SELECT id, from_id AS who, created_at, COALESCE(to_id,'broadcast') AS src, substr(content,1,240) AS txt
     FROM inter_companion_notes WHERE created_at >= '2026-03-01'` },
  { t: "delta", strength: "weak", sql:
    `SELECT id, COALESCE(NULLIF(agent,''), companion_id) AS who, created_at, delta_type AS src, session_id AS link,
            substr(COALESCE(delta_text, payload_json, ''),1,240) AS txt
     FROM relational_deltas WHERE created_at >= '2026-03-01'` },
  { t: "commons", strength: "strong", sql:
    `SELECT id, author AS who, created_at, context AS src, substr(body,1,240) AS txt FROM commons_posts` },
  { t: "tension", strength: "weak", sql:
    `SELECT id, companion_id AS who, first_noted_at AS created_at, COALESCE(source,'x') AS src,
            substr(tension_text,1,240) AS txt
     FROM companion_tensions WHERE first_noted_at >= '2026-03-01'` },
  { t: "question", strength: "strong", sql:
    `SELECT id, companion_id AS who, created_at, 'x' AS src, substr(question,1,240) AS txt
     FROM companion_questions WHERE created_at >= '2026-03-01'` },
];

const evidence = [];
for (const p of PULLS) {
  try {
    const rows = query(p.sql.replace(/\s+/g, " "));
    for (const r of rows) evidence.push({ ...r, t: p.t, strength: p.strength, ms: Date.parse(r.created_at.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(r.created_at) ? "" : "Z")) });
    console.log("pulled", p.t, p.strength, rows.length);
  } catch (e) {
    console.log("PULL FAILED", p.t, p.strength, String(e).split("\n").find(l => /no such|SQLITE/.test(l))?.slice(0, 120));
  }
}
evidence.sort((a, b) => a.ms - b.ms);

// ── attribution ──────────────────────────────────────────────────────────────
const bundles = open.map(s => ({ ...s, ev: [] }));
const byId = new Map(bundles.map(b => [b.id, b]));
for (const b of bundles) {
  const w = win.get(b.id);
  const who = b.companion_id;
  for (const e of evidence) {
    if (e.ms < w.start || e.ms >= w.end) continue;
    if (who && e.who !== who) continue;          // a NULL-companion session takes any author
    b.ev.push(e);
  }
}

writeFileSync("evidence.json", JSON.stringify(bundles, null, 1));

const strong = b => b.ev.filter(e => e.strength === "strong").length;
console.log("\n--- attribution ---");
console.log("with STRONG evidence:", bundles.filter(b => strong(b) > 0).length);
console.log("weak only:", bundles.filter(b => strong(b) === 0 && b.ev.length > 0).length);
console.log("no evidence at all:", bundles.filter(b => b.ev.length === 0).length);
const perC = {};
for (const b of bundles) {
  const k = (b.companion_id ?? "NULL") + (strong(b) ? " strong" : b.ev.length ? " weak" : " none");
  perC[k] = (perC[k] ?? 0) + 1;
}
console.log(perC);
