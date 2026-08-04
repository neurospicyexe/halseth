// q.mjs -- run SQL against prod halseth D1, print JSON rows.
// usage: node q.mjs <file.sql>   (SQL text is passed via --command so results come back as JSON)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HALSETH = "C:/dev/Bigger_Better_Halseth/halseth";
const WRANGLER = `${HALSETH}/node_modules/wrangler/bin/wrangler.js`;

export function query(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "halseth", "--remote", "--json", "--command", sql],
    { cwd: HALSETH, maxBuffer: 1024 * 1024 * 512, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const json = JSON.parse(out.slice(out.indexOf("[")));
  return json.flatMap(r => r.results ?? []);
}

if (process.argv[2]) {
  const sql = readFileSync(resolve(process.argv[2]), "utf8");
  process.stdout.write(JSON.stringify(query(sql)));
}
