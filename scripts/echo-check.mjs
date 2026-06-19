#!/usr/bin/env node
// echo-check.mjs -- measures whether the live Discord inter-companion exchange
// is a genuine dialogue or an echo chamber.
//
// Pulls recent discord-live messages from the Second Brain vector store and
// computes, over consecutive companion messages:
//   - mean cosine similarity between adjacent messages (high => echo)
//   - max-pair similarity (any near-duplicate exchanges)
//   - speaker diversity (who actually talks)
//   - novel-token rate (fraction of content words not seen in prior N messages)
//
// Read-only. Run on the VPS: node echo-check.mjs [days]
import Database from "better-sqlite3";
import { homedir } from "os";

const DAYS = parseInt(process.argv[2] ?? "3", 10);
const db = new Database(homedir() + "/.nullsafe-second-brain/vector-store.db", { readonly: true });

const cols = db.prepare("PRAGMA table_info(embeddings)").all().map((r) => r.name);
const has = (c) => cols.includes(c);
const vecCol = ["embedding", "vector", "embedding_json"].find(has);
const textCol = ["chunk_text", "text", "prefixed_text", "content"].find(has);
const timeCol = ["created_at", "ingested_at", "ts"].find(has);

const rows = db
  .prepare(
    `SELECT vault_path, ${textCol} AS text, ${vecCol} AS vec, ${timeCol} AS t
     FROM embeddings
     WHERE vault_path LIKE 'discord-live/%'
       AND ${timeCol} >= datetime('now','-' || ? || ' days')
     ORDER BY ${timeCol} ASC`,
  )
  .all(DAYS);

console.log(`discord-live messages in last ${DAYS}d: ${rows.length}`);
if (rows.length < 4) {
  console.log("Too few messages to judge echo. (Surprisal gate may be dropping near-dupes upstream -- that itself is anti-echo.)");
  process.exit(0);
}

// Parse vectors (stored as JSON array or Float32 blob)
function toVec(v) {
  if (v == null) return null;
  if (typeof v === "string") { try { return Float64Array.from(JSON.parse(v)); } catch { return null; } }
  if (Buffer.isBuffer(v)) { const f = new Float32Array(v.buffer, v.byteOffset, Math.floor(v.length / 4)); return Float64Array.from(f); }
  return null;
}
function cos(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return null;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

// Speaker inferred from vault_path (discord-live/<companion>/...) or text prefix
function speaker(r) {
  const m = r.vault_path.match(/discord-live\/([a-z]+)/i);
  if (m && ["cypher", "drevan", "gaia"].includes(m[1].toLowerCase())) return m[1].toLowerCase();
  const t = (r.text || "").toLowerCase();
  for (const n of ["cypher", "drevan", "gaia"]) if (t.startsWith(n) || t.startsWith("[" + n)) return n;
  return "?";
}

const speakers = {};
let adjSims = [];
let crossSpeakerSims = [];
for (let i = 0; i < rows.length; i++) {
  const s = speaker(rows[i]);
  speakers[s] = (speakers[s] || 0) + 1;
  if (i > 0) {
    const sim = cos(toVec(rows[i].vec), toVec(rows[i - 1].vec));
    if (sim != null) {
      adjSims.push(sim);
      if (speaker(rows[i]) !== speaker(rows[i - 1])) crossSpeakerSims.push(sim);
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (x) => (x == null ? "n/a" : x.toFixed(3));

// Novel-token rate: content words not seen in the previous 5 messages
const STOP = new Set("the a an and or but of to in on for with is are was were be been i you he she it we they this that what when how my your our".split(" "));
function toks(t) { return (t || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)); }
let novelRates = [];
for (let i = 1; i < rows.length; i++) {
  const prev = new Set();
  for (let j = Math.max(0, i - 5); j < i; j++) toks(rows[j].text).forEach((w) => prev.add(w));
  const cur = toks(rows[i].text);
  if (!cur.length) continue;
  const novel = cur.filter((w) => !prev.has(w)).length;
  novelRates.push(novel / cur.length);
}

console.log("speakers:", JSON.stringify(speakers));
console.log("mean adjacent cosine:", fmt(mean(adjSims)), "(>0.85 = strong echo, <0.6 = healthy divergence)");
console.log("mean cross-speaker cosine:", fmt(mean(crossSpeakerSims)), "(companions answering each other; high = mirroring)");
console.log("max adjacent cosine:", fmt(adjSims.length ? Math.max(...adjSims) : null));
console.log("mean novel-token rate:", fmt(mean(novelRates)), "(<0.3 = recycling vocabulary, >0.5 = fresh material)");
console.log("\n--- last 6 messages (speaker :: first 90 chars) ---");
for (const r of rows.slice(-6)) console.log(`${speaker(r)} :: ${(r.text || "").replace(/\s+/g, " ").slice(0, 90)}`);
