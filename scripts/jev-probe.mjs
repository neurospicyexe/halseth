// scripts/jev-probe.mjs -- one live Jev call through POST /admin/jev, using the Cloudflare docs
// example so the answer shape can be compared against the published one. Never prints the secret.
//
// Usage (from halseth/):  node scripts/jev-probe.mjs
// Reads ADMIN_SECRET from .dev.vars (same loader as verify-imps-live.mjs) unless HALSETH_SECRET is
// already in the environment. HALSETH_URL overrides the worker base.
import { readFileSync, existsSync } from "node:fs";

// scripts/.env holds the PROD secret as HALSETH_SECRET (the autonomous-time convention); .dev.vars
// holds the LOCAL dev ADMIN_SECRET and is only a fallback for `wrangler dev`.
function loadEnvFile(path, wantKey, intoKey) {
  if (process.env[intoKey] || !existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    if (t.slice(0, i).trim() === wantKey) process.env[intoKey] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile("scripts/.env", "HALSETH_SECRET", "HALSETH_SECRET");
loadEnvFile(".dev.vars", "ADMIN_SECRET", "HALSETH_SECRET");
if (!process.env.HALSETH_SECRET) { console.error("no ADMIN_SECRET in .dev.vars and HALSETH_SECRET unset"); process.exit(1); }

const BASE = (process.env.HALSETH_URL ?? "https://halseth.neurospicyexe.workers.dev").replace(/\/$/, "");
const body = {
  purpose: "probe",
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    is_urgent: { type: "noul", instructions: "Does this convey urgency?", criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" } },
    department: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments, invoicing, refunds", technical: "Bugs, outages, integrations", sales: "Pricing, upgrades, new accounts" } },
    frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm", "Frustrated", "Very angry"] },
  },
};

const t0 = Date.now();
const res = await fetch(`${BASE}/admin/jev`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.HALSETH_SECRET}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const wall = Date.now() - t0;
const text = await res.text();
console.log(`HTTP ${res.status} wall_ms=${wall}`);
try {
  const j = JSON.parse(text);
  console.log(JSON.stringify({ model: j.model, latency_ms: j.latency_ms, usage: j.usage, answers: j.answers, error: j.error }, null, 2));
} catch {
  console.log(text.slice(0, 800));
}
