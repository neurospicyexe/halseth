// scripts/d1q.mjs -- run one read-only SQL statement against REMOTE D1 and print compact rows.
// Usage: node scripts/d1q.mjs "SELECT ..."    (wraps `wrangler d1 execute --remote --json`)
// Refuses anything that is not a SELECT/WITH so it can never be the thing that wrote to prod.
import { spawnSync } from "node:child_process";
const sql = process.argv.slice(2).join(" ").trim();
if (!/^(select|with)\b/i.test(sql)) { console.error("read-only: statement must start with SELECT or WITH"); process.exit(2); }
// Spawn wrangler's bin directly with process.execPath (no shell): `--file --remote` returns only a
// summary, so rows need `--command`, and with shell:true on Windows the SQL gets re-split on spaces.
const r = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "halseth", "--remote", "--config", "wrangler.prod.toml", "--json", "--command", sql], { encoding: "utf8" });
const out = r.stdout ?? "";
const i = out.indexOf("[");
if (i < 0) { console.error("no JSON in wrangler output:", (out + r.stderr).slice(0, 600)); process.exit(1); }
const j = JSON.parse(out.slice(i));
const rows = j[0]?.results ?? [];
console.log(JSON.stringify({ rows: rows.length, rows_read: j[0]?.meta?.rows_read }));
for (const row of rows) console.log(JSON.stringify(row));
