// scripts/orient-block-diff.mjs
//
// The parity harness for the execSessionOrient cutover (Phase 1 item 4, the last piece).
//
// WHY THIS EXISTS AND WHY IT IS PER-BLOCK. The bot cutover was gated on byte-identity of the whole payload.
// That gate does NOT transfer here: `ready_prompt` is not reproducible call-to-call. Measured 2026-08-01, two
// consecutive live orients differ by hundreds to thousands of characters, so a whole-string diff can only ever
// say "different" and would make the refactor unverifiable.
//
// A BLOCK-level diff is verifiable, because the churn turns out to be confined to a handful of blocks with
// legible causes. Everything else must be byte-identical.
//
// Usage:
//   node scripts/orient-block-diff.mjs capture <dir>    # snapshot all three companions
//   node scripts/orient-block-diff.mjs diff <a> <b>     # compare two snapshot dirs
//
// CAPTURE TAKES TWO CALLS PER COMPANION AND KEEPS THE SECOND. The first stamps `markAnswersDelivered`, so the
// second legitimately returns fewer answered questions -- comparing a first call against a second would report
// a mismatch that is not one. This is the same "the harness cannot run old-vs-new live" trap that
// execSessionOrient's writes create; capturing a fixture is the way around it.

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";

const URL_BASE = process.env.HALSETH_URL ?? "https://halseth.neurospicyexe.workers.dev";
const COMPANIONS = ["cypher", "drevan", "gaia"];

/**
 * Blocks allowed to differ, each with the reason it moves on its own. Anything NOT on this list changing is a
 * real regression. Keep the reasons: a volatile-list entry with no justification becomes a place to hide
 * failures, which is how an anti-loop rail turns into a rug.
 */
const VOLATILE = [
  { re: /^Active conclusions/, why: "orient WARMS conclusion heat on read, which reorders the next read (deliberate on this path -- the companion really is receiving)" },
  { re: /^Live conversation threads$/, why: "real traffic between calls" },
  { re: /^Guardian$/, why: "cards transition open -> surfaced on display (consume-once)" },
  { re: /^Motifs$/, why: "effective-trust decay + resurrection rotation, and resurrected motifs get last_surfaced_at stamped" },
  { re: /^SOMA arc$/, why: "new limbic/soma rows are written during the day; rendered by response/builder.ts, NOT by the extracted blocks" },
  { re: /^Last session narrative$/, why: "input is an sb_read over the Second Brain tunnel, which is intermittently unavailable -- absent vs present is an availability difference, not a rendering one" },
  { re: /^\(head\)$/, why: "the interoception line renders live SOMA floats, which the ferment tick moves between calls" },
  { re: /^Active forage$/, why: "relativeTime() on consumed_at -- 'picked up 9 hours ago' becomes 10 with no data change" },
  { re: /^Forage pool$/, why: "relativeTime() on gathered_at, same as Active forage" },
  // These two carry a live COUNT in the block NAME, so when the count moves the key itself changes and the
  // differ sees a renamed block rather than an edited one. Worth knowing about this harness: a block whose
  // header is data cannot be compared by name alone.
  { re: /^Active threads: \d+$/, why: "block NAME contains a live thread count; a changed count renames the key" },
  { re: /^Confirmed growth drift: \d+ entries$/, why: "block NAME contains a live entry count; drift rows accrue daily" },
  { re: /^Autonomous growth: \d+ recent entries$/, why: "block NAME contains a live entry count" },
  { re: /^Recognized patterns: \d+$/, why: "block NAME contains a live count" },
  { re: /^Queued seeds: \d+ available$/, why: "block NAME contains a live count" },
];

const isVolatile = (name) => VOLATILE.find(v => v.re.test(name));

/** Split a ready_prompt into `[Block name]` sections. Lines before the first header land in "(head)". */
function splitBlocks(prompt) {
  const out = {};
  let cur = "(head)";
  out[cur] = [];
  for (const line of String(prompt ?? "").split("\n")) {
    const m = line.match(/^\[([^\]]+)\]$/);
    if (m) { cur = m[1]; out[cur] = []; } else out[cur].push(line);
  }
  return out;
}

async function orient(companion, secret) {
  const res = await fetch(`${URL_BASE}/librarian`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ companion_id: companion, request: "orient" }),
  });
  if (!res.ok) throw new Error(`orient ${companion}: HTTP ${res.status}`);
  return res.json();
}

async function capture(dir) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET not set");
  mkdirSync(dir, { recursive: true });
  for (const c of COMPANIONS) {
    await orient(c, secret);                    // pass 1: absorbs the delivered_at stamping
    const second = await orient(c, secret);     // pass 2: the stable reference
    writeFileSync(`${dir}/${c}.json`, JSON.stringify(second, null, 2));
    console.log(`captured ${c} (${String(second.ready_prompt ?? "").length} chars)`);
  }
}

function diff(dirA, dirB) {
  let unexpected = 0;
  for (const c of COMPANIONS) {
    const A = splitBlocks(JSON.parse(readFileSync(`${dirA}/${c}.json`, "utf8")).ready_prompt);
    const B = splitBlocks(JSON.parse(readFileSync(`${dirB}/${c}.json`, "utf8")).ready_prompt);
    const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])];
    const changed = keys.filter(k => (A[k] ?? []).join("\n") !== (B[k] ?? []).join("\n"));
    const bad = changed.filter(k => !isVolatile(k));
    unexpected += bad.length;
    console.log(`== ${c}: ${keys.length} blocks | identical ${keys.length - changed.length} | volatile ${changed.length - bad.length} | UNEXPECTED ${bad.length}`);
    for (const k of changed.filter(isVolatile)) console.log(`   ~ ${k} -- ${isVolatile(k).why}`);
    for (const k of bad) {
      console.log(`   !! ${k}`);
      console.log(`      before: ${JSON.stringify((A[k] ?? []).join("\n").slice(0, 200))}`);
      console.log(`      after : ${JSON.stringify((B[k] ?? []).join("\n").slice(0, 200))}`);
    }
  }
  console.log(unexpected === 0
    ? "\nGATE PASS: every non-volatile block byte-identical"
    : `\nGATE FAIL: ${unexpected} unexpected block change(s)`);
  return unexpected === 0 ? 0 : 1;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "capture") await capture(a);
else if (cmd === "diff") process.exit(diff(a, b));
else {
  console.error("usage: orient-block-diff.mjs capture <dir> | diff <dirA> <dirB>");
  process.exit(2);
}
