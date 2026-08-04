// scan-transcripts.mjs -- map open Halseth session ids to Claude Code transcripts and
// build a compact per-session digest that a spine can honestly be written from.
//
// Evidence rule: a transcript counts as evidence for session X only if X's id appears in it
// (the boot header prints it, or the halseth_session_open result carries it).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const ids = readFileSync("ids.txt", "utf8").trim().split(/\r?\n/);
const idSet = new Set(ids);
const short = new Map(ids.map(i => [i.slice(0, 8), i]));

const files = [];
for (const dir of readdirSync(PROJECTS)) {
  const p = join(PROJECTS, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) files.push(join(p, f));
}

/** per (halseth session id) -> digest */
const hits = new Map();

function digestFor(sid, ccFile) {
  const key = sid + "|" + ccFile;
  if (!hits.has(key)) {
    hits.set(key, {
      session_id: sid, cc_file: ccFile, cc_session: ccFile.split(/[\\/]/).pop().replace(".jsonl", ""),
      project: ccFile.split(/[\\/]/).slice(-2)[0],
      first_ts: null, last_ts: null, msgs: 0, matches: 0,
      user_first: null, user_msgs: [], assistant_last: null,
      files_touched: new Set(), commits: [], cwd: null,
    });
  }
  return hits.get(key);
}

const textOf = (m) => {
  const c = m?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter(b => b.type === "text").map(b => b.text).join("\n");
  return "";
};

for (const file of files) {
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { continue; }
  // cheap pre-filter: does this transcript mention any open session id at all?
  const present = ids.filter(i => raw.includes(i));
  if (!present.length) continue;

  const lines = raw.split("\n");
  // A transcript is one cc session; attribute the whole transcript to every open
  // session id it names (usually exactly one -- the one its boot header printed).
  const digests = present.map(sid => digestFor(sid, file));
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const ts = m.timestamp ?? null;
    for (const d of digests) {
      d.msgs++;
      if (ts) { if (!d.first_ts || ts < d.first_ts) d.first_ts = ts; if (!d.last_ts || ts > d.last_ts) d.last_ts = ts; }
      if (m.cwd && !d.cwd) d.cwd = m.cwd;
      if (m.type === "user" && !m.isMeta) {
        const t = textOf(m).trim();
        if (t && !t.startsWith("<") && !t.includes("tool_result")) {
          if (!d.user_first) d.user_first = t.slice(0, 400);
          if (d.user_msgs.length < 14) d.user_msgs.push(t.slice(0, 180));
        }
      }
      if (m.type === "assistant") {
        const t = textOf(m).trim();
        if (t) d.assistant_last = t.slice(-700);
        const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const fp = b.input?.file_path ?? b.input?.notebook_path;
          if (fp) d.files_touched.add(String(fp).split(/[\\/]/).slice(-2).join("/"));
          const cmd = b.input?.command;
          if (typeof cmd === "string" && /git commit/.test(cmd)) {
            const msg = /-m\s+["']?([^"'\n]{0,120})/.exec(cmd);
            if (msg) d.commits.push(msg[1]);
          }
        }
      }
      // How the id shows up decides whether the transcript is EVIDENCE OF PRESENCE or just a
      // transcript that printed a list. Only the boot header and a session-open tool result mean
      // "this session was opened here"; everything else is me querying the sessions table.
      if (line.includes(d.session_id) || line.includes(d.session_id.slice(0, 8))) {
        d.matches++;
        const isHeader = /\[Halseth\][^\n]{0,200}session\s+/.test(line) || /cc session\s+/.test(line);
        const isOpenResult = new RegExp(`"session_id"\\s*:\\s*"${d.session_id}"`).test(line)
          || new RegExp(`"id"\\s*:\\s*"${d.session_id}"[^\\n]{0,120}"front_state"`).test(line);
        if (isHeader && line.includes(d.session_id.slice(0, 8))) d.mention_header = (d.mention_header ?? 0) + 1;
        if (isOpenResult) d.mention_open = (d.mention_open ?? 0) + 1;
      }
    }
  }
}

const out = [...hits.values()].map(d => ({ ...d, files_touched: [...d.files_touched].slice(0, 25) }));
writeFileSync("transcript-digests.json", JSON.stringify(out, null, 1));
console.log("transcripts scanned:", files.length);
console.log("open sessions with transcript evidence:", new Set(out.map(d => d.session_id)).size, "/", ids.length);
console.log("digest rows (session x transcript):", out.length);
const multi = out.reduce((a, d) => (a[d.session_id] = (a[d.session_id] ?? 0) + 1, a), {});
console.log("sessions matched by >1 transcript:", Object.values(multi).filter(n => n > 1).length);
