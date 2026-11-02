// make-d1-restore.mjs <dump.sql> <restore.sql>
//
// Turn a `wrangler d1 export` dump into a file D1 can actually import. Found 10-27 by rehearsal: D1's
// own export does NOT import back into D1 ("no such table: main.club_rounds"). The export writes each
// table's CREATE then its INSERTs, in creation order, and some child tables (club_*) were created
// before their parent, so a child's INSERT runs while the parent table does not exist yet.
//
// Reordered, the restore is: PRAGMAs -> every CREATE TABLE -> every row -> indexes, triggers, views.
// Triggers last on purpose: created earlier, they would FIRE on the restore's own INSERTs and change
// the data being restored. Statements are split on semicolons OUTSIDE quotes ('' and "" escapes), since
// stored notes contain ';' and newlines. Nothing is edited, only moved; the statement count is checked.
import { readFileSync, writeFileSync } from "node:fs";

export function splitStatements(sql) {
  const out = [];
  let start = 0, q = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) {
      if (c === q) { if (sql[i + 1] === q) i++; else q = null; }
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i); i = nl < 0 ? sql.length : nl;
    } else if (c === ";") {
      // A trigger body holds its own statements (BEGIN ...; ...; END;): one statement until its END.
      const sofar = sql.slice(start, i).trim();
      if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(sofar) && !/\bEND$/i.test(sofar)) continue;
      const s = sql.slice(start, i + 1).trim();
      if (s && s !== ";") out.push(s);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function phaseOf(stmt) {
  const head = stmt.replace(/^\s+/, "").slice(0, 40).toUpperCase();
  if (head.startsWith("PRAGMA")) return 0;
  if (/^CREATE\s+(VIRTUAL\s+)?TABLE/.test(head)) return 1;
  if (/^(INSERT|REPLACE|DELETE\s+FROM\s+"?SQLITE_SEQUENCE)/.test(head)) return 2;
  return 3; // CREATE INDEX / TRIGGER / VIEW, anything else
}

export function reorderDump(sql) {
  const stmts = splitStatements(sql);
  const phases = [[], [], [], []];
  for (const s of stmts) phases[phaseOf(s)].push(s);
  return { text: phases.flat().join("\n") + "\n", counts: phases.map((p) => p.length), total: stmts.length };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/").replace(/^\//, "")}`) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) { console.error("usage: make-d1-restore.mjs <dump.sql> <restore.sql>"); process.exit(2); }
  const r = reorderDump(readFileSync(src, "utf8"));
  writeFileSync(dst, r.text);
  console.log(`statements ${r.total}: pragma ${r.counts[0]}, tables ${r.counts[1]}, rows ${r.counts[2]}, indexes/triggers/views ${r.counts[3]} -> ${dst}`);
}
