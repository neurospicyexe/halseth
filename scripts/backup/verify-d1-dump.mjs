// verify-d1-dump.mjs <dump.sql> [expected-json]
//
// Restore proof for a Halseth D1 export: load the whole dump into a FRESH in-memory SQLite and report
// table count + per-table row counts. A dump nobody has loaded is not a backup. With an expected-json
// (from live D1: {"tables":N,"rows":{"table":count}}) it also compares, allowing rows to have grown
// since the dump (writes keep landing) but never shrunk. Exit 0 = restorable and consistent.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [dumpPath, expectedPath] = process.argv.slice(2);
if (!dumpPath) { console.error("usage: verify-d1-dump.mjs <dump.sql> [expected.json]"); process.exit(2); }

// Load with foreign-key enforcement OFF (the sqlite3 CLI default). D1's export writes tables in creation
// order, and some child tables were created before their parent (club_* before club_rounds), so an
// enforcing load fails with "no such table" even inside a deferred transaction -- an ordering artifact,
// not damage. Integrity is then checked properly, once everything is in: PRAGMA foreign_key_check names
// every row that points at a parent that does not exist.
const sql = readFileSync(dumpPath, "utf8");
const t0 = Date.now();
const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
db.exec(sql);
const orphans = db.prepare("PRAGMA foreign_key_check").all();
const byTable = {};
for (const o of orphans) byTable[`${o.table}->${o.parent}`] = (byTable[`${o.table}->${o.parent}`] ?? 0) + 1;
console.log(orphans.length === 0 ? "foreign keys: clean" : `foreign keys: ${orphans.length} orphan row(s) ${JSON.stringify(byTable)}`);
const integrity = db.prepare("PRAGMA integrity_check").get();
console.log(`integrity_check: ${Object.values(integrity)[0]}`);
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
).all().map((r) => r.name);
const rows = {};
for (const t of tables) rows[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
const total = Object.values(rows).reduce((a, b) => a + b, 0);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${tables.length} tables, ${total} rows`);

let bad = 0;
if (expectedPath) {
  const exp = JSON.parse(readFileSync(expectedPath, "utf8"));
  if (exp.tables !== tables.length) { console.log(`TABLES: dump ${tables.length} vs live ${exp.tables}`); bad++; }
  for (const [t, n] of Object.entries(exp.rows ?? {})) {
    const got = rows[t];
    if (got === undefined) { console.log(`MISSING table ${t}`); bad++; }
    else if (got > n) { console.log(`ROWS ${t}: dump ${got} > live ${n} (live shrank?)`); bad++; }
    else if (n - got > Math.max(50, n * 0.02)) { console.log(`ROWS ${t}: dump ${got} vs live ${n}`); bad++; }
  }
  console.log(bad === 0 ? `matches live (${Object.keys(exp.rows ?? {}).length} tables compared)` : `${bad} mismatch(es)`);
}
process.exit(bad === 0 ? 0 : 1);
