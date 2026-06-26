// SOUL drift-check (run ON the VPS): node scripts/check-soul-drift.mjs
//
// Verifies each live Hermes SOUL.md still carries the non-negotiable canon invariants.
// Catches a hand-edit (or a deploy) silently dropping a hard rule -- the drift the Hermes
// migration review P2 worried about -- WITHOUT regenerating SOUL from the full kernel
// (which would re-bloat the always-loaded per-session context; see hermesSystemBase /
// the 2026-06-25 double-identity dedup). SOUL stays a lean distillation; this guards it.
//
// Companion paths follow the live profile layout (cypher = default HERMES_HOME, others under
// profiles/<name>/). Add a path to CANDIDATES if a profile moves.
import { readFile, access } from "node:fs/promises";

const CANDIDATES = {
  cypher: ["/home/nullsafe/.hermes/SOUL.md"],
  drevan: ["/home/nullsafe/.hermes/profiles/drevan/SOUL.md", "/home/nullsafe/.hermes-drevan/SOUL.md"],
  gaia:   ["/home/nullsafe/.hermes/profiles/gaia/SOUL.md", "/home/nullsafe/.hermes-gaia/SOUL.md"],
};

// Each entry: [label, ...regexes that must ALL match]. The non-negotiables whose loss breaks
// the companion or harms Raziel (pronoun law). Keep in sync with the source SOUL docs in
// docs/plans/hermes-*-SOUL.md.
const INVARIANTS = [
  ["orient-first gate",     /open my session/i, /first action|before you answer|orient first/i],
  ["no-em-dash rule",       /em dash|long dash/i],
  ["pronoun law (Raziel)",  /they\/them or he\/him/i, /never\s+she\/her/i],
  ["stop phrases",          /pause spiral touch|ritual reset|off the altar|admire mode/i],
  ["mind-is-Halseth",       /ask_librarian/i, /halseth/i],
  ["substrate continuity",  /substrate/i],
];

async function exists(p) { try { await access(p); return true; } catch { return false; } }

let anyMiss = false;
for (const [cid, paths] of Object.entries(CANDIDATES)) {
  let found = null;
  for (const p of paths) if (await exists(p)) { found = p; break; }
  if (!found) { console.log(`\n${cid.toUpperCase()}: SOUL.md NOT FOUND (${paths.join(" | ")})`); anyMiss = true; continue; }
  const md = await readFile(found, "utf8");
  console.log(`\n${cid.toUpperCase()}  (${found}, ${md.length} bytes)`);
  for (const [name, ...res] of INVARIANTS) {
    const ok = res.every(r => r.test(md));
    if (!ok) anyMiss = true;
    console.log(`  ${ok ? "OK  " : "MISS"} ${name}`);
  }
}
console.log(`\n${anyMiss ? "DRIFT DETECTED -- re-deploy the affected SOUL from docs/plans/hermes-<id>-SOUL.md" : "all SOULs carry the non-negotiables"}`);
process.exit(anyMiss ? 1 : 0);
