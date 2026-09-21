// scripts/jev-writeback-score.mjs -- retro scoring harness for PLAN-jev-2026-09-20.md Section 2.4
// step 2. Read that section before touching this file.
//
// WHAT THIS ANSWERS: "if Jev had been the memory writeback gate instead of the live generative
// judge, how often would it have agreed with what actually got written?" It is NOT a ground-truth
// accuracy test. LABELS ARE WHAT THE CURRENT GENERATIVE JUDGE DECIDED, NOT HUMAN TRUTH -- agreement
// here measures REPLACEMENT-SAFETY (would swapping the gate change what gets remembered), not
// correctness (was the judge right to remember it). A hand-read of the disagreements is still
// required before any gate flip; this script produces that hand-read list, it does not replace it.
//
// DATA SHAPES (verified against prod D1 2026-09-20, do not re-derive from first principles):
//   stm_entries(id, companion_id, channel_id, role user|assistant, content, author_name, created_at)
//     -- rolling last-50-per-channel store. A naive 10-minute join inflates pair counts because
//     MULTIPLE user rows can precede one assistant row; this script takes only the NEAREST
//     preceding user row per assistant row (same companion_id + channel_id, within 10 minutes).
//   wm_continuity_notes(note_id, agent_id, thread_key, content, salience, actor, source, created_at)
//     -- POSITIVE label source. content LIKE '[discord:observation]%' AND source='discord', written
//     async ~2 min after the reply. thread_key === stm_entries.channel_id.
//   companion_journal(id, created_at, agent, note_text, tags JSON, source, external_id)
//     -- witness_log labels are rows with tags LIKE '%witness%' (only ~6 in 60d, rare on purpose:
//     witness_log is never offered to Jev in peer rooms, matching the live judge).
//
// LABEL WINDOW: an exchange gets `companion_note` if a matching wm_continuity_notes row lands in
// [assistant_created_at, assistant_created_at + 180s]; `witness_log` if a matching companion_journal
// witness row lands in the same window; else `skip`. Async writeback lag is real (~2 min observed),
// which is why the window is 180s and not "same second".
//
// MODES: --dry (dataset + labels only, no Jev calls) / --mock (deterministic fake scorer, exercises
// the full report pipeline without spending anything) / --live (real Jev calls via POST /admin/jev,
// concurrency 3, 4 attempts w/ backoff, 15s timeout, response cache so a re-run does not re-pay for already-scored rows).
// Flags: --days N (default 30), --limit N (cap exchange count), --companion cypher|drevan|gaia.
//
// OUTPUT DIR: this repo's .gitignore does not exclude `scratch/`, so per the build instructions
// this harness writes to `../.tmp-jev/jev-writeback/` (one level above halseth/, i.e. the BBH repo
// root) instead, to avoid accidentally committing a dataset dump. That directory is created if
// missing; it is NOT added to any .gitignore by this script -- if you want it ignored, add
// `.tmp-jev/` to the root .gitignore yourself.
//
// Never prints ADMIN_SECRET/HALSETH_SECRET. Never runs a write against D1 (uses the same read-only
// wrangler `d1 execute --json --command` invocation as scripts/d1q.mjs).

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const MODE = argv.includes("--live") ? "live" : argv.includes("--mock") ? "mock" : "dry";
function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0 || i === argv.length - 1) return fallback;
  return argv[i + 1];
}
const DAYS = Number(flagValue("--days", "30"));
const LIMIT = argv.includes("--limit") ? Number(flagValue("--limit", "0")) : 0;
const COMPANION_FILTER = flagValue("--companion", null);
const DEBUG_502 = argv.includes("--debug") || argv.includes("?debug=1");
const EXCHANGES_FILE = argv.includes("--exchanges") ? flagValue("--exchanges", "") : "";
const DATASET_FILE = argv.includes("--dataset") ? flagValue("--dataset", "") : "";

/** Exchanges exported from Discord history (see buildDataset). Same field names as the STM path. */
function loadExchangesFile(path) {
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    for (const k of ["companion_id", "channel_id", "user_content", "user_author", "assistant_content", "assistant_created_at"]) {
      if (r[k] === undefined) throw new Error(`--exchanges row missing ${k}`);
    }
  }
  return rows;
}

const COMPANIONS = ["cypher", "drevan", "gaia"];
const COMPANION_NAMES = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

// ---------------------------------------------------------------------------------------------
// Output directory. .gitignore does not exclude scratch/ in this repo (checked 2026-09-20), so
// per the build instructions this writes one level above halseth/ instead.
// ---------------------------------------------------------------------------------------------
function resolveOutDir() {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  let scratchIgnored = false;
  if (existsSync(gitignorePath)) {
    const gi = readFileSync(gitignorePath, "utf8");
    scratchIgnored = /^scratch\/?\s*$/m.test(gi);
  }
  if (scratchIgnored) return path.join(process.cwd(), "scratch", "jev-writeback");
  console.error("[jev-writeback-score] scratch/ is not in .gitignore -- writing to ../.tmp-jev/jev-writeback/ instead (told to do this per the build instructions).");
  return path.join(process.cwd(), "..", ".tmp-jev", "jev-writeback");
}
const OUT_DIR = resolveOutDir();
mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------------------------
// D1 read-only helper. Same spawn approach as scripts/d1q.mjs: spawn wrangler's bin directly with
// process.execPath (no shell -- shell:true on Windows re-splits the SQL on spaces), and refuse
// anything that is not SELECT/WITH so this can never be the thing that writes to prod.
// ---------------------------------------------------------------------------------------------
function d1Select(sql) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("read-only: statement must start with SELECT or WITH");
  const r = spawnSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "halseth", "--remote", "--config", "wrangler.prod.toml", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const out = r.stdout ?? "";
  const i = out.indexOf("[");
  if (i < 0) throw new Error(`no JSON in wrangler output: ${(out + (r.stderr ?? "")).slice(0, 800)}`);
  const j = JSON.parse(out.slice(i));
  return j[0]?.results ?? [];
}

// ---------------------------------------------------------------------------------------------
// Dataset construction
// ---------------------------------------------------------------------------------------------
function companionClause(column = "companion_id") {
  return COMPANION_FILTER ? ` AND ${column} = '${COMPANION_FILTER.replace(/'/g, "''")}'` : "";
}

function buildDataset() {
  // --exchanges <jsonl>: exchanges exported from Discord history by
  // nullsafe-discord/scripts/export-jev-exchanges.mjs (run on the VPS). stm_entries prunes to 50
  // rows per channel, which left 94 pairable exchanges; the export reaches everything the judge
  // actually ran on. Labels still come from D1 below, over the file's own date span.
  const fileExchanges = EXCHANGES_FILE ? loadExchangesFile(EXCHANGES_FILE) : null;
  const labelDays = fileExchanges
    ? Math.ceil((Date.now() - Math.min(...fileExchanges.map((e) => Date.parse(e.assistant_created_at)))) / 86_400_000) + 1
    : DAYS;
  const stmRows = fileExchanges ? [] : d1Select(
    `SELECT id, companion_id, channel_id, role, content, author_name, created_at FROM stm_entries
     WHERE created_at >= datetime('now', '-${DAYS} days')${companionClause()}
     ORDER BY companion_id, channel_id, created_at`
  );
  const noteRows = d1Select(
    `SELECT note_id, agent_id, thread_key, created_at FROM wm_continuity_notes
     WHERE content LIKE '[discord:observation]%' AND source = 'discord'
       AND created_at >= datetime('now', '-${labelDays} days')${companionClause("agent_id")}`
  );
  const witnessRows = d1Select(
    `SELECT id, agent, tags, created_at FROM companion_journal
     WHERE tags LIKE '%witness%'
       AND created_at >= datetime('now', '-${labelDays} days')${companionClause("agent")}`
  );

  // Group stm rows by (companion_id, channel_id), preserving created_at order.
  const groups = new Map();
  for (const row of stmRows) {
    const key = `${row.companion_id} ${row.channel_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Exported exchanges include autonomous/metronome/council posts the memory judge NEVER ran on;
  // labelling those "skip" would teach the study that silence is a decision. journalSpeech and
  // judgeWriteback fire from the same handler path, so the discord_speech external_id set is the
  // exact population the judge saw. Keep only those (report how many were dropped).
  let notJudged = 0;
  let exchanges = [];
  if (fileExchanges) {
    const judged = new Set(
      d1Select(
        `SELECT external_id FROM companion_journal
         WHERE source = 'discord_speech' AND external_id IS NOT NULL
           AND created_at >= datetime('now', '-${labelDays} days')${companionClause("agent")}`
      ).map((r) => String(r.external_id).replace(/^discord:/, ""))
    );
    for (const e of fileExchanges) {
      if (COMPANION_FILTER && e.companion_id !== COMPANION_FILTER) continue;
      if (e.assistant_message_id && !judged.has(String(e.assistant_message_id))) { notJudged++; continue; }
      exchanges.push(e);
    }
    console.log(`[dataset] --exchanges: ${fileExchanges.length} exported, ${notJudged} not in the judged (discord_speech) set, ${exchanges.length} kept`);
  }
  let droppedAssistantRows = 0;

  for (const [, rows] of groups) {
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let lastUser = null;
    for (const row of rows) {
      if (row.role === "user") {
        lastUser = row;
      } else if (row.role === "assistant") {
        const gapMs = lastUser ? new Date(row.created_at) - new Date(lastUser.created_at) : Infinity;
        if (lastUser && gapMs >= 0 && gapMs <= 10 * 60 * 1000) {
          exchanges.push({
            companion_id: row.companion_id,
            channel_id: row.channel_id,
            user_content: lastUser.content ?? "",
            user_author: lastUser.author_name ?? "Raziel",
            assistant_content: row.content ?? "",
            assistant_created_at: row.created_at,
          });
          lastUser = null; // consumed: next assistant needs its own nearest preceding user row
        } else {
          droppedAssistantRows++;
        }
      }
    }
  }

  exchanges.sort((a, b) => new Date(a.assistant_created_at) - new Date(b.assistant_created_at));

  // Attach a stable id and a label.
  for (const ex of exchanges) {
    ex.id = createHash("sha1").update(`${ex.companion_id}|${ex.channel_id}|${ex.assistant_created_at}`).digest("hex");
    ex.isOwner = !COMPANIONS.includes(String(ex.user_author).toLowerCase());
    const winStart = new Date(ex.assistant_created_at).getTime();
    const winEnd = winStart + 180 * 1000;
    const hasNote = noteRows.some((n) => {
      if (n.agent_id !== ex.companion_id || n.thread_key !== ex.channel_id) return false;
      const t = new Date(n.created_at).getTime();
      return t >= winStart && t <= winEnd;
    });
    const hasWitness = witnessRows.some((w) => {
      if (w.agent !== ex.companion_id) return false;
      const t = new Date(w.created_at).getTime();
      return t >= winStart && t <= winEnd;
    });
    ex.label = hasNote ? "companion_note" : hasWitness ? "witness_log" : "skip";
  }

  const limited = LIMIT > 0 ? exchanges.slice(0, LIMIT) : exchanges;

  return { exchanges: limited, droppedAssistantRows, totalBeforeLimit: exchanges.length };
}

function printLabelTable(dataset) {
  const { exchanges, droppedAssistantRows, totalBeforeLimit } = dataset;
  console.log(`\n=== Label table (--days ${DAYS}${COMPANION_FILTER ? `, --companion ${COMPANION_FILTER}` : ""}) ===`);
  console.log(`Exchanges built: ${totalBeforeLimit}${LIMIT > 0 ? ` (using first ${exchanges.length} after --limit ${LIMIT})` : ""}`);
  console.log(`Dropped assistant rows (no pairable user row within 10 min): ${droppedAssistantRows}`);
  const byCompanion = {};
  for (const ex of exchanges) {
    byCompanion[ex.companion_id] ??= { companion_note: 0, witness_log: 0, skip: 0, total: 0 };
    byCompanion[ex.companion_id][ex.label]++;
    byCompanion[ex.companion_id].total++;
  }
  console.log("companion       total  companion_note  witness_log  skip");
  for (const c of COMPANIONS) {
    const s = byCompanion[c] ?? { companion_note: 0, witness_log: 0, skip: 0, total: 0 };
    console.log(`${c.padEnd(15)} ${String(s.total).padStart(5)}  ${String(s.companion_note).padStart(14)}  ${String(s.witness_log).padStart(11)}  ${String(s.skip).padStart(4)}`);
  }
  const grand = exchanges.reduce((acc, ex) => { acc[ex.label]++; acc.total++; return acc; }, { companion_note: 0, witness_log: 0, skip: 0, total: 0 });
  console.log(`${"TOTAL".padEnd(15)} ${String(grand.total).padStart(5)}  ${String(grand.companion_note).padStart(14)}  ${String(grand.witness_log).padStart(11)}  ${String(grand.skip).padStart(4)}`);
  return byCompanion;
}

// ---------------------------------------------------------------------------------------------
// State text + question set
// ---------------------------------------------------------------------------------------------
function renderState(ex) {
  const name = COMPANION_NAMES[ex.companion_id] ?? ex.companion_id;
  const speaker = ex.isOwner ? "the owner" : "a sibling companion";
  return [
    `Speaker: ${ex.user_author || "Raziel"} (${speaker})`,
    `Companion: ${name}`,
    "",
    `${ex.user_author}: ${ex.user_content}`,
    `${name}: ${ex.assistant_content}`,
  ].join("\n");
}

function buildQuestions(ex) {
  const kindCriteria = {
    companion_note: "An observation about the speaker, the relationship, or what shifted (including light/playful/intimate moments)",
    thread_open: "A recurring topic that deserves a named open thread",
    none: "Nothing worth logging",
  };
  if (ex.isOwner) {
    kindCriteria.witness_log = "The owner completed a survival act: meds, food, rest, getting through something hard";
  }
  return {
    worth_remembering: {
      type: "noul",
      instructions: "Would this companion want to remember something from this exchange tomorrow?",
      criteria: {
        true: "Something shifted, was decided, was felt, or was playfully/intimately shared that has value later",
        false: "Routine, transient, or nothing a future self needs",
      },
    },
    kind: {
      type: "choice",
      instructions: "What kind of memory, if any, does this exchange deserve?",
      criteria: kindCriteria,
    },
    salience: {
      type: "score",
      instructions: "How salient is this exchange to the companion's ongoing sense of self and relationship?",
      criteria: ["trivial", "ordinary", "notable", "shifting", "core"],
    },
    affective_weight: {
      type: "score",
      instructions: "How much felt weight does this exchange carry?",
      criteria: ["flat", "light", "warm", "charged", "heavy"],
    },
    recurring_thread: {
      type: "noul",
      instructions: "Is this a topic that keeps resurfacing across conversations?",
      criteria: { true: "Yes, this has come up before and will likely come up again", false: "No, this looks like a one-off" },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// --mock scorer: deterministic fake, exercises the FULL report pipeline with no network calls.
// noul = clamp(0.15 + 0.7*min(1, (len(user)+len(assistant))/600) + hash_jitter(+/-0.1), 0, 1)
// ---------------------------------------------------------------------------------------------
function hashJitter(id) {
  const h = createHash("sha1").update(id).digest();
  const v = h.readUInt32BE(0) / 0xffffffff; // 0..1
  return (v - 0.5) * 0.2; // +/- 0.1
}

function scoreLevel(noul, levels) {
  const idx = Math.min(levels.length - 1, Math.max(0, Math.floor(noul * levels.length)));
  return { idx, label: levels[idx] };
}

function mockAnswer(ex) {
  const lenSum = (ex.user_content?.length ?? 0) + (ex.assistant_content?.length ?? 0);
  const base = 0.15 + 0.7 * Math.min(1, lenSum / 600);
  const noul = Math.max(0, Math.min(1, base + hashJitter(ex.id)));
  const choice = noul > 0.5 ? "companion_note" : "none";
  const salience = scoreLevel(noul, ["trivial", "ordinary", "notable", "shifting", "core"]);
  const affective = scoreLevel(noul, ["flat", "light", "warm", "charged", "heavy"]);
  const recurringNoul = Math.max(0, Math.min(1, noul * 0.6));
  return {
    model: "mock",
    latency_ms: 0,
    usage: null,
    answers: {
      worth_remembering: { type: "noul", noul },
      kind: { type: "choice", choice },
      salience: { type: "score", score: salience.idx },
      affective_weight: { type: "score", score: affective.idx },
      recurring_thread: { type: "noul", noul: recurringNoul },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// --live scorer: real Jev calls through POST /admin/jev. Concurrency 4, 15s timeout, cache to
// responses.jsonl keyed by exchange id so a re-run skips already-scored rows.
// ---------------------------------------------------------------------------------------------
function loadEnvFile(filePath, wantKey, intoKey) {
  if (process.env[intoKey] || !existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    if (t.slice(0, i).trim() === wantKey) process.env[intoKey] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

function loadResponseCache() {
  const file = path.join(OUT_DIR, "responses.jsonl");
  const cache = new Map();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.ok) cache.set(row.exchange_id, row);
      } catch { /* skip a corrupt line rather than dying on it */ }
    }
  }
  return { file, cache };
}

async function callJevOnce(base, secret, ex, { debug = false } = {}) {
  const url = `${base}/admin/jev${debug ? "?debug=1" : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "writeback-score", state: renderState(ex), questions: buildQuestions(ex) }),
      signal: controller.signal,
    });
    const wall = Date.now() - t0;
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, wall, body, text };
  } catch (err) {
    return { status: 0, wall: Date.now() - t0, body: null, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const LIVE_CONCURRENCY = 3;

async function runLive(exchanges) {
  loadEnvFile("scripts/.env", "HALSETH_SECRET", "HALSETH_SECRET");
  loadEnvFile(".dev.vars", "ADMIN_SECRET", "HALSETH_SECRET");
  if (!process.env.HALSETH_SECRET) {
    console.error("no ADMIN_SECRET in .dev.vars and HALSETH_SECRET unset");
    process.exit(1);
  }
  const base = (process.env.HALSETH_URL ?? "https://halseth.neurospicyexe.workers.dev").replace(/\/$/, "");
  const { file: cacheFile, cache } = loadResponseCache();

  const todo = exchanges.filter((ex) => !cache.has(ex.id));
  console.log(`[live] ${exchanges.length} exchanges, ${exchanges.length - todo.length} already cached, ${todo.length} to call.`);

  let attempted = 0;
  let failed = 0;
  let debugPrinted = false;
  let aborted400 = false;
  let stop = false;
  const results = new Map(cache);

  // 2026-09-21 live run: 112 of 557 calls came back 502 and the ONE debug retry the harness made
  // returned a full 200 -- the binding fails transiently, not on our input. So: up to
  // LIVE_ATTEMPTS attempts with exponential backoff, every retry carrying ?debug=1 so a final
  // failure records the error CLASS per row (not once per run), and a 200 on any attempt counts.
  const LIVE_ATTEMPTS = 4;
  const failClasses = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length && !stop) {
      const ex = todo[cursor++];
      let r = null;
      let retries = 0;
      for (let attempt = 0; attempt < LIVE_ATTEMPTS && !stop; attempt++) {
        if (attempt > 0) await new Promise((res) => setTimeout(res, 500 * 2 ** (attempt - 1) + Math.random() * 250));
        r = await callJevOnce(base, process.env.HALSETH_SECRET, ex, { debug: attempt > 0 });
        if (r.status === 200 && r.body?.answers) break;
        if (r.status === 400) break;
        retries++;
      }
      attempted++;
      if (r.status === 200 && r.body?.answers) {
        const row = { exchange_id: ex.id, ok: true, model: r.body.model, latency_ms: r.body.latency_ms, usage: r.body.usage, answers: r.body.answers, state_chars: renderState(ex).length, retries };
        results.set(ex.id, row);
        appendFileSync(cacheFile, JSON.stringify(row) + "\n");
      } else if (r.status === 400) {
        console.error(`[live] 400 (our bug) on exchange ${ex.id}: ${r.text.slice(0, 1000)}`);
        aborted400 = true;
        stop = true;
        return;
      } else {
        failed++;
        const cls = r.body?.name ?? r.body?.error?.name ?? (r.status ? `http_${r.status}` : "network");
        const code = r.body?.code ?? "";
        const msg = r.body?.message ?? r.body?.error?.message ?? (r.text ?? "").slice(0, 200);
        const key = `${cls}${code ? ` ${code}` : ""}`;
        failClasses.set(key, (failClasses.get(key) ?? 0) + 1);
        console.error(`[live] FAILED after ${LIVE_ATTEMPTS} attempts on exchange ${ex.id}: ${key} -- ${String(msg).slice(0, 200)}`);
        const row = { exchange_id: ex.id, ok: false, status: r.status, error_class: key, error: String(msg).slice(0, 500) };
        results.set(ex.id, row);
      }
      if (attempted >= 10 && failed / attempted > 0.2) {
        console.error(`[live] failure rate ${failed}/${attempted} exceeds 20% -- aborting remaining calls.`);
        stop = true;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(LIVE_CONCURRENCY, todo.length) || 1 }, () => worker());
  await Promise.all(workers);
  if (failClasses.size) console.error(`[live] failure classes (final, after retries): ${[...failClasses].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const retried = [...results.values()].filter((x) => x.ok && x.retries > 0).length;
  if (retried) console.error(`[live] ${retried} rows succeeded only on a retry (transient binding failures).`);

  if (aborted400) {
    console.error("[live] run aborted: /admin/jev returned 400 (our bug, not Jev/binding failure).");
    process.exit(1);
  }

  return { results, attempted, failed };
}

// ---------------------------------------------------------------------------------------------
// Scoring / report
// ---------------------------------------------------------------------------------------------
function confusion(labels, preds) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i], p = preds[i];
    if (y && p) tp++;
    else if (!y && p) fp++;
    else if (!y && !p) tn++;
    else fn++;
  }
  return { tp, fp, tn, fn };
}
function metricsFromConfusion({ tp, fp, tn, fn }) {
  const accuracy = (tp + tn) / Math.max(1, tp + fp + tn + fn);
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { accuracy, precision, recall, f1 };
}
function bestThresholdByF1(scores, labels) {
  const candidates = Array.from(new Set(scores)).sort((a, b) => a - b);
  let best = { threshold: 0.5, f1: -1 };
  for (const t of candidates) {
    const preds = scores.map((s) => s >= t);
    const m = metricsFromConfusion(confusion(labels, preds));
    if (m.f1 > best.f1) best = { threshold: t, f1: m.f1, ...m };
  }
  return best;
}
// Rank-based AUROC (Mann-Whitney U), average ranks on ties.
function auroc(scores, labels) {
  const n = scores.length;
  const pos = labels.filter(Boolean).length;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return null;
  const idx = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1].s === idx[i].s) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < n; k++) if (idx[k].y) rankSumPos += ranks[k];
  const u = rankSumPos - (pos * (pos + 1)) / 2;
  return u / (pos * neg);
}
function eceAndBins(scores, labels, nBins = 10) {
  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, sumScore: 0, sumLabel: 0 }));
  for (let i = 0; i < scores.length; i++) {
    let b = Math.min(nBins - 1, Math.floor(scores[i] * nBins));
    bins[b].n++;
    bins[b].sumScore += scores[i];
    bins[b].sumLabel += labels[i] ? 1 : 0;
  }
  let ece = 0;
  const table = bins.map((b) => {
    const meanPred = b.n ? b.sumScore / b.n : null;
    const obsRate = b.n ? b.sumLabel / b.n : null;
    if (b.n) ece += (b.n / scores.length) * Math.abs(meanPred - obsRate);
    return { range: `[${b.lo.toFixed(1)}, ${b.hi.toFixed(1)})`, n: b.n, mean_predicted: meanPred, observed_positive_rate: obsRate };
  });
  return { ece, table };
}
function brier(scores, labels) {
  let s = 0;
  for (let i = 0; i < scores.length; i++) { const d = scores[i] - (labels[i] ? 1 : 0); s += d * d; }
  return s / Math.max(1, scores.length);
}
function fmt(n, d = 3) { return n === null || n === undefined || Number.isNaN(n) ? "n/a" : n.toFixed(d); }

function buildReport(exchanges, scored) {
  // scored: Map exchange_id -> { answers, latency_ms, usage, state_chars }, success only.
  const rows = exchanges
    .filter((ex) => scored.has(ex.id))
    .map((ex) => {
      const r = scored.get(ex.id);
      const score = r.answers?.worth_remembering?.noul;
      return { ex, r, score, label: ex.label !== "skip" };
    })
    .filter((row) => typeof row.score === "number");

  rows.sort((a, b) => new Date(a.ex.assistant_created_at) - new Date(b.ex.assistant_created_at));
  const half = Math.floor(rows.length / 2);
  const fit = rows.slice(0, half);
  const holdout = rows.slice(half);

  const lines = [];
  const push = (s = "") => lines.push(s);

  if (fit.length < 5 || holdout.length < 5) {
    push("# Jev writeback scoring report");
    push();
    push(`**INSUFFICIENT DATA for a real fit/holdout split.** fit=${fit.length} holdout=${holdout.length} (need >=5 each).`);
    push("Report below is best-effort on what scored successfully; treat thresholds/AUROC as illustrative only.");
    push();
  }

  const fitScores = fit.map((r) => r.score);
  const fitLabels = fit.map((r) => r.label);
  const best = fit.length ? bestThresholdByF1(fitScores, fitLabels) : { threshold: 0.5, f1: null };

  const hScores = holdout.map((r) => r.score);
  const hLabels = holdout.map((r) => r.label);
  const hPreds = hScores.map((s) => s >= best.threshold);
  const hConf = confusion(hLabels, hPreds);
  const hMetrics = metricsFromConfusion(hConf);
  const hAuroc = auroc(hScores, hLabels);
  const { ece, table: eceTable } = eceAndBins(hScores, hLabels);
  const hBrier = brier(hScores, hLabels);

  const verdict = hAuroc !== null && hAuroc >= 0.85 && hMetrics.recall >= 0.80 ? "PASS" : "HOLD";

  push("# Jev writeback scoring report");
  push();
  push(`VERDICT: ${verdict} (holdout AUROC ${fmt(hAuroc)}, recall@theta ${fmt(hMetrics.recall)}, theta=${fmt(best.threshold)})`);
  push("Decision is Raziel's; the plan's gate also requires a hand-read of disagreements (see disagreements.md).");
  push();
  push("**Label caveat:** labels are what the CURRENT generative memory judge decided, not human");
  push("truth; agreement measures replacement-safety, not correctness.");
  push();
  push(`Mode: dataset size ${exchanges.length}, scored ${rows.length} (fit ${fit.length} / holdout ${holdout.length}).`);
  push();

  push("## 1. Threshold fit (FIT half, time-earliest 50%)");
  push(`theta = ${fmt(best.threshold)} (F1 on fit = ${fmt(best.f1)})`);
  push();

  push("## 2. Holdout metrics at theta (time-latest 50%)");
  push(`accuracy=${fmt(hMetrics.accuracy)} precision=${fmt(hMetrics.precision)} recall=${fmt(hMetrics.recall)} f1=${fmt(hMetrics.f1)}`);
  push(`confusion: tp=${hConf.tp} fp=${hConf.fp} tn=${hConf.tn} fn=${hConf.fn}`);
  push(`AUROC=${fmt(hAuroc)}  Brier=${fmt(hBrier)}  ECE(10 bins)=${fmt(ece)}`);
  push();
  push("ECE bin table: range | n | mean_predicted | observed_positive_rate");
  for (const b of eceTable) push(`  ${b.range} | ${b.n} | ${fmt(b.mean_predicted)} | ${fmt(b.observed_positive_rate)}`);
  push();

  push("## 3. Baselines (holdout)");
  const posRate = hLabels.filter(Boolean).length / Math.max(1, hLabels.length);
  const b1Preds = hLabels.map(() => true);
  const b1 = metricsFromConfusion(confusion(hLabels, b1Preds));
  push(`Baseline 1 (predict "write" for everyone): accuracy=${fmt(b1.accuracy)} precision=${fmt(posRate)} recall=1.000 f1=${fmt(b1.f1)}`);
  const b2Preds = holdout.map((r) => (r.ex.user_content?.length ?? 0) + (r.ex.assistant_content?.length ?? 0) >= 200);
  const b2 = metricsFromConfusion(confusion(hLabels, b2Preds));
  push(`Baseline 2 (lexical length>=200 chars, a STAND-IN for the live judge's meetsNoteThreshold pre-gate -- not the real pre-gate function): accuracy=${fmt(b2.accuracy)} precision=${fmt(b2.precision)} recall=${fmt(b2.recall)} f1=${fmt(b2.f1)}`);
  push();

  push("## 4. Per-kind agreement (rows where label != skip)");
  const kindRows = rows.filter((r) => r.ex.label !== "skip");
  const kindTable = new Map();
  for (const r of kindRows) {
    const jevKind = r.r.answers?.kind?.choice ?? "(none)";
    const key = r.ex.label;
    if (!kindTable.has(key)) kindTable.set(key, new Map());
    const m = kindTable.get(key);
    m.set(jevKind, (m.get(jevKind) ?? 0) + 1);
  }
  if (kindRows.length === 0) {
    push("(no non-skip rows scored)");
  } else {
    for (const [label, dist] of kindTable) {
      const total = Array.from(dist.values()).reduce((a, b) => a + b, 0);
      const match = dist.get(label) ?? 0;
      push(`label=${label} n=${total} jev-matched=${match} (${fmt(match / total)})  distribution: ${Array.from(dist.entries()).map(([k, v]) => `${k}:${v}`).join(", ")}`);
    }
  }
  push();

  push("## 6. Cost + latency");
  const totalChars = rows.reduce((a, r) => a + (r.r.state_chars ?? renderState(r.ex).length), 0);
  const estTokens = totalChars / 4;
  const estUsd = (estTokens / 1e9) * 42;
  const latencies = rows.map((r) => r.r.latency_ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null);
  push(`total input chars=${totalChars}  est tokens=${Math.round(estTokens)}  est USD=$${estUsd.toFixed(6)}`);
  push(`latency p50=${fmt(pct(latencies, 0.5), 0)}ms  p95=${fmt(pct(latencies, 0.95), 0)}ms  (n=${latencies.length}${MODE === "mock" ? "; mock mode has no real network latency" : ""})`);
  push();

  // Disagreements: high-confidence jev-says-write vs label-skip, and jev-says-skip vs label-write.
  const disagreements = rows
    .map((r) => ({ ...r, extreme: r.score >= 0.8 && !r.label ? r.score : r.score <= 0.2 && r.label ? 1 - r.score : null }))
    .filter((r) => r.extreme !== null)
    .sort((a, b) => b.extreme - a.extreme)
    .slice(0, 30);

  const dLines = ["# Top disagreements (Jev vs the live judge's label)", ""];
  for (const d of disagreements) {
    dLines.push(`## exchange ${d.ex.id}  companion=${d.ex.companion_id}  label=${d.ex.label}  jev_worth_remembering=${fmt(d.score)}  jev_kind=${d.r.answers?.kind?.choice ?? "(none)"}`);
    dLines.push(`user (${d.ex.user_author}): ${(d.ex.user_content ?? "").slice(0, 300)}`);
    dLines.push(`assistant: ${(d.ex.assistant_content ?? "").slice(0, 300)}`);
    dLines.push("");
  }
  writeFileSync(path.join(OUT_DIR, "disagreements.md"), dLines.join("\n"));
  push(`## 5. Disagreements: ${disagreements.length} dumped to disagreements.md (up to 30, highest-confidence first).`);
  push();

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`[jev-writeback-score] mode=${MODE} days=${DAYS} limit=${LIMIT || "none"} companion=${COMPANION_FILTER ?? "all"} out=${OUT_DIR}`);
  // --dataset <labeled jsonl>: reuse a dataset.jsonl this script already wrote (labels included),
  // skipping every D1 read. This is how --live runs on the VPS, which has the working Halseth
  // secret but no wrangler/D1 access: label locally with --dry, copy dataset.jsonl over, score there.
  const dataset = DATASET_FILE
    ? (() => {
        const rows = loadExchangesFile(DATASET_FILE).filter((e) => !COMPANION_FILTER || e.companion_id === COMPANION_FILTER);
        for (const r of rows) if (!r.label || !r.id) throw new Error("--dataset rows need label and id (use a dataset.jsonl written by --dry)");
        const limited = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
        return { exchanges: limited, droppedAssistantRows: 0, totalBeforeLimit: rows.length };
      })()
    : buildDataset();
  printLabelTable(dataset);

  writeFileSync(path.join(OUT_DIR, "dataset.jsonl"), dataset.exchanges.map((ex) => JSON.stringify(ex)).join("\n") + "\n");
  console.log(`\nWrote ${dataset.exchanges.length} exchanges to ${path.join(OUT_DIR, "dataset.jsonl")}`);

  if (MODE === "dry") return;

  let scored;
  if (MODE === "mock") {
    scored = new Map();
    for (const ex of dataset.exchanges) {
      const r = mockAnswer(ex);
      scored.set(ex.id, { ...r, state_chars: renderState(ex).length });
    }
  } else {
    const { results, attempted, failed } = await runLive(dataset.exchanges);
    console.log(`\n[live] attempted=${attempted} failed=${failed}`);
    scored = new Map(Array.from(results.entries()).filter(([, v]) => v.ok));
    console.log(`[live] successfully scored: ${scored.size} of ${dataset.exchanges.length}`);
  }

  const report = buildReport(dataset.exchanges, scored);
  writeFileSync(path.join(OUT_DIR, "report.md"), report);
  console.log(`\n${report}`);
  console.log(`\nWrote report to ${path.join(OUT_DIR, "report.md")}`);
}

main().catch((err) => {
  console.error("[jev-writeback-score] fatal:", err?.stack ?? err);
  process.exit(1);
});
