// One-off: read pm2 jlist from stdin, report whether autonomous-worker has SOL_WEBHOOK_URL.
import { readFileSync } from "fs";
const d = JSON.parse(readFileSync(0, "utf8"));
const w = d.find((p) => p.name === "autonomous-worker");
console.log("worker found:", !!w);
if (w) {
  console.log("SOL_WEBHOOK_URL present:", !!w.pm2_env.SOL_WEBHOOK_URL);
  console.log("HEARTBEAT_CHANNEL_ID present:", !!w.pm2_env.HEARTBEAT_CHANNEL_ID);
}
