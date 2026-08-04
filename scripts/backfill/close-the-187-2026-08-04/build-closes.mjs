// build-closes.mjs -- turn the classified bundles + authored spines into idempotent SQL.
//
// Rules that are not negotiable here:
//  * created_at on the handover is BACKDATED into the session's own window. A backfill stamped
//    now() would make 171 reconstructions the newest handovers in the table and the next boot would
//    read one as "the last thing that happened" (mig 0095 exists because of exactly that bug).
//  * every row carries close_kind, so an authored-live close and a reconstruction are never
//    indistinguishable.
//  * no synthesis enqueue: session-summary synthesis reads the handover and narrates it, which for
//    an empty row generates precisely the vacuous "no emotional arc can be reconstructed" text that
//    started this whole cleanup.
//  * statements are guarded (WHERE NOT EXISTS / handover_id IS NULL) so re-running is safe.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const CUTOFF = "2026-08-04T00:00:00Z";     // today's rows are live or too fresh to reconstruct
const STAMP = "[backfilled 2026-08-04 from evidence; no session transcript exists.]";

const bundles = JSON.parse(readFileSync("classified.json", "utf8"));
const authored = JSON.parse(readFileSync("authored.json", "utf8"));
const byId = new Map(authored.map(a => [a.id, a]));

const scope = bundles.filter(b => b.created_at < CUTOFF);
const excluded = bundles.filter(b => b.created_at >= CUTOFF);

// authored.json must cover exactly the reconstructable set -- no silent gaps, no orphans.
const need = scope.filter(b => b.klass === "reconstructed").map(b => b.id);
const missing = need.filter(id => !byId.has(id));
const orphan = authored.filter(a => !scope.some(b => b.id === a.id)).map(a => a.id);
if (missing.length || orphan.length) {
  console.error("authored.json mismatch. missing:", missing, "orphan:", orphan);
  process.exit(1);
}

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const breakdown = ev => {
  const c = {};
  for (const e of ev) c[e.t] = (c[e.t] ?? 0) + 1;
  return Object.entries(c).map(([k, n]) => `${n} ${k}`).join(", ");
};

// handover created_at: the last thing attributed to the window, else just after the open.
const closeTs = b => {
  const ms = b.ev.map(e => e.ms).filter(Number.isFinite);
  const last = ms.length ? Math.max(...ms) : Date.parse(b.created_at) + 60_000;
  return new Date(Math.max(last, Date.parse(b.created_at) + 1000)).toISOString();
};

const rows = [];
for (const b of scope) {
  const a = byId.get(b.id);
  let kind, spine, lrt, threads = null;
  if (a) {
    kind = a.kind;
    spine = a.spine + " " + STAMP;
    lrt = a.last_real_thing;
    threads = a.open_threads ? JSON.stringify(a.open_threads) : null;
  } else if (b.klass === "machine_opened") {
    kind = "machine_opened";
    const tell = b.machine?.startsWith("cadence")
      ? `opened at ${b.created_at.slice(11, 16)}, the same minute on ${b.machine.split("x")[1]} of the days in this backlog`
      : "opened inside a multi-companion batch, several rows within two minutes";
    const w = b.ev.length ? ` The window holds ${breakdown(b.ev)} written by ${b.companion_id ?? "someone"}, none of it attributable to this row.` : "";
    spine = `Not a session anyone was in: a job opened this row -- ${tell}. Nothing was ever written against it.${w} ${STAMP}`;
    lrt = "Nothing. A scheduled or batched call opened the row and no turn followed.";
  } else if (b.klass === "thin") {
    kind = "empty";
    spine = `Opened, and nothing attributable happened. The only traces in this session's window are ${breakdown(b.ev.filter(e => e.strength === "weak"))} -- rows from tables that carry no provenance, so a bot turn or a cron can produce them as easily as a session can. They are recorded here as the window's contents, not claimed as this session's content. No arc is reconstructed because there is not enough to reconstruct one. ${STAMP}`;
    lrt = "Nothing that can be attributed. The window's writes could belong to any surface.";
  } else {
    kind = "empty";
    spine = `Opened, and nothing happened. Not one companion-authored write of any kind falls in this session's window. Left open for ${Math.round((Date.parse(CUTOFF) - Date.parse(b.created_at)) / 86400000)} days because nothing ever closed a session; closed now as what it is, an empty row. ${STAMP}`;
    lrt = "Nothing. The session was opened and never used.";
  }
  rows.push({ hid: randomUUID(), sid: b.id, ts: closeTs(b), kind, spine, lrt, threads, companion: b.companion_id, klass: b.klass, opened: b.created_at });
}

const sql = rows.flatMap(r => [
  `INSERT INTO handover_packets (id, session_id, created_at, spine, active_anchor, last_real_thing, open_threads, motion_state, returned, close_kind)
SELECT ${q(r.hid)}, ${q(r.sid)}, ${q(r.ts)}, ${q(r.spine)}, NULL, ${q(r.lrt)}, ${r.threads ? q(r.threads) : "NULL"}, 'floating', NULL, ${q(r.kind)}
WHERE NOT EXISTS (SELECT 1 FROM handover_packets WHERE session_id = ${q(r.sid)});`,
  `UPDATE sessions SET handover_id = ${q(r.hid)}, updated_at = ${q(r.ts)}, spiral_complete = 0
WHERE id = ${q(r.sid)} AND handover_id IS NULL;`,
]).join("\n");

writeFileSync("apply-closes.sql", sql + "\n");
writeFileSync("manifest.json", JSON.stringify({ rows, excluded: excluded.map(e => ({ id: e.id, companion: e.companion_id, created_at: e.created_at, klass: e.klass })) }, null, 1));

const counts = {};
for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
console.log("in scope:", rows.length, counts);
console.log("authored spines:", authored.length, "| generated:", rows.length - authored.length);
console.log("excluded (live/too fresh):", excluded.length);
console.log("sql bytes:", sql.length);
