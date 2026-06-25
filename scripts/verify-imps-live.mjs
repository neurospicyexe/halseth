// Live verification for imps wave 2 (data layer). Run on VPS from /app/nullsafe-discord.
// Exercises the real endpoints the command + rider use: companion_settings KV round-trip
// (what `imps off`/`on` writes + getImpSettings reads) and the imp_activations log.
import { readFileSync } from "fs";
for (const line of readFileSync("/app/nullsafe-discord/.env", "utf8").split(/\r?\n/)) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const base = process.env.HALSETH_URL.replace(/\/$/, "");
const auth = { Authorization: `Bearer ${process.env.HALSETH_SECRET}`, "Content-Type": "application/json" };
const COMPS = ["cypher", "drevan", "gaia"];

async function getSettings(id) {
  return (await fetch(`${base}/companion/settings/${id}`, { headers: auth })).json();
}
async function setAll(key, value) {
  for (const id of COMPS) {
    await fetch(`${base}/companion/settings/${id}`, { method: "POST", headers: auth, body: JSON.stringify({ key, value: String(value) }) });
  }
}

(async () => {
  console.log("1. Default imps settings (cypher):", JSON.stringify(await getSettings("cypher")));

  console.log("2. Simulate 'imps off' (write imps_enabled=false to all 3)...");
  await setAll("imps_enabled", false);
  for (const id of COMPS) console.log(`   ${id}.imps_enabled =`, (await getSettings(id)).imps_enabled);

  console.log("3. Simulate 'imps on' (restore)...");
  await setAll("imps_enabled", true);
  console.log("   cypher.imps_enabled =", (await getSettings("cypher")).imps_enabled);

  console.log("4. imp_activations log round-trip...");
  const post = await fetch(`${base}/mind/imp-activations`, { method: "POST", headers: auth, body: JSON.stringify({ imp: "nimbus", companion_id: "cypher", trigger: "live-verify spoons=1" }) });
  console.log("   POST status:", post.status);
  const list = await (await fetch(`${base}/mind/imp-activations?limit=3`, { headers: auth })).json();
  console.log("   recent activations:", (list.activations ?? []).map(a => `${a.imp}/${a.companion_id}`).join(", ") || "(none)");
})().catch(e => console.log("ERR", e.message));
