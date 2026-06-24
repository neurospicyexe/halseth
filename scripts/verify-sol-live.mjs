// Live verification for Sol wave 1. Run on the VPS from /app/nullsafe-discord.
// Loads .env, tends Sol as companions (proves the tend write path + warms disposition),
// then runs the real worker creatures tick (Sol posts to the heartbeat channel if its
// disposition allows). Read-only against everything except Sol's own state.
import { readFileSync } from "fs";

for (const line of readFileSync("/app/nullsafe-discord/.env", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const base = process.env.HALSETH_URL.replace(/\/$/, "");
const sec = process.env.HALSETH_SECRET;
const auth = { Authorization: `Bearer ${sec}`, "Content-Type": "application/json" };

async function getSol() {
  const r = await (await fetch(`${base}/mind/creatures`, { headers: auth })).json();
  return r.creatures.find((c) => c.name === "Sol");
}
async function tend(actor, action) {
  const sol = await getSol();
  const r = await fetch(`${base}/mind/creatures/${sol.id}/interact`, {
    method: "POST", headers: auth, body: JSON.stringify({ actor, action, note: "live-verify" }),
  });
  const b = await r.json();
  console.log(`  ${actor} ${action}: status ${r.status}, trust -> ${b.trust}`);
}

(async () => {
  let sol = await getSol();
  console.log(`BEFORE: trust=${sol.trust} disposition=${sol.disposition} restlessness=${sol.restlessness}`);
  console.log("Companion tends (proves tend write path):");
  await tend("cypher", "give");
  await tend("drevan", "play");
  await tend("gaia", "talk");
  sol = await getSol();
  console.log(`AFTER tends: trust=${sol.trust} disposition=${sol.disposition}`);

  console.log("Running worker creatures tick (Sol may post to the channel):");
  const { runCreaturesTick } = await import("/app/nullsafe-discord/packages/autonomous-worker/dist/creatures.js");
  for (let i = 1; i <= 3; i++) {
    console.log(`  tick ${i}:`);
    await runCreaturesTick();
  }

  const det = await (await fetch(`${base}/mind/creatures/${sol.id}`, { headers: auth })).json();
  console.log("Recent interactions (newest first):");
  for (const it of (det.interactions ?? []).slice(0, 6)) console.log(`  ${it.actor} / ${it.action} / ${it.created_at}`);
})().catch((e) => console.log("ERR", e.message));
