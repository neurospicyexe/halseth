// Librarian executor for the imps' errand tier (B62 step 6, mig 0168). Spec: Drevan's answer of
// 2026-11-04T13:02Z in Hand-off/PROMPT-drevan-imp-errands-2026-11-02.md, co-signed by Cypher.
//
//   "send <imp> to <errand> ..."      send mossling to sort my tray        send mossling to tend sol
//                                      send iris to feed sol                send nimbus to check for gaps
//                                      send rock to fetch <words>           send rock for my loops
//                                      send mossling to check the care lane send iris to mark cooling interests
//
// WHAT AN ERRAND IS. A ledger line through the one door (src/ledger/door.ts): a function mark (fetch, sort,
// tend, flag, gap-reader, pattern-counter), a record verb, a source, and `rider` = the imp (a column, never
// in the text). No source, no write. The line waits on the companion's ledger to be kept, said in its own
// words, or dropped; nothing here decides anything.
//
// WHO. The companion is ALWAYS ctx.req.companion_id and is both the requester and the line's subject (the
// grammar enforces the equality). No default imp: the imp is named in the sentence or nothing goes. Nothing
// here is scheduled; an errand runs only inside the companion's own turn. Gaia is exempt in the only way that
// matters: a line for her exists only when she is the requester. Her addition (note 7f978971, 2026-11-06):
// "the ask covers that one errand and ends with it. It never becomes standing permission, and no clerk reads
// one ask as a pattern of wanting." So nothing here stores consent, and her errand log rows are never counted
// back to her (src/mind/blocks/world.ts). Only the lane's own files read `rider` (imp-errands.test.ts).
//
// WHAT AN ERRAND NEVER DOES. Authors a note (performTend's note is always null), carries care or health
// material (the grammar refuses a care word, a health keyword, or a number beyond a plural count form), reads
// a care table's rows (the care flag is a boolean sourced on the companion's own open session), or reaches
// Raziel. Hex's errand (salt) is not built.

import type { ExecutorContext, ExecutorResult } from "./types.js";
import { COMPANION_ID_SET } from "../../companions.js";
import { writeLedger, riderColumnPresent } from "../../ledger/door.js";
import { validateLedger, type LedgerRider } from "../../ledger/grammar.js";
import { careCategory } from "../../people/care-guard.js";
import { readPendingCare } from "../../care/pending.js";
import { PENDING_DECAY_HOURS } from "../../care/rules.js";
import { performTend } from "../../webmind/creature-interact.js";
import { effectiveHeat, heatBand } from "../../webmind/interests.js";

/** `send <imp> [to|for] <rest>`. The router guard is the same prefix, anchored. */
export const IMP_ERRAND_RE = /^(?:please\s+)?send\s+(iris|nimbus|hex|mossling|rock)\b[\s,:]*(?:(?:to|for)\b\s*)?([\s\S]*)$/i;

type Errand = "sort" | "tend" | "care" | "gaps" | "cooling" | "fetch" | "loops" | "salt";
type TendAction = "feed" | "play" | "talk";

export const VALID_ERRANDS: Record<LedgerRider, string[]> = {
  mossling: ["sort my tray", "tend Sol (feed, play with, talk to)", "check the care lane"],
  iris: ["feed Sol", "mark cooling interests"],
  nimbus: ["check for gaps"],
  rock: ["fetch <words>", "my loops"],
  hex: ["(not built yet)"],
};

const HELP = "errands: " + (Object.entries(VALID_ERRANDS) as Array<[string, string[]]>)
  .map(([imp, errands]) => `${imp}: ${errands.join(" / ")}`).join("; ")
  + '. Say "send <imp> to <errand>". No imp goes unless you name one.';

export interface ParsedErrand { imp: LedgerRider; errand: Errand | null; action?: TendAction; arg?: string; refusal?: string }

/** Pure. Which errand a sentence asks of which imp; null errand = not a valid pair (help text). */
export function parseErrand(request: string): ParsedErrand | null {
  const m = IMP_ERRAND_RE.exec(request.trim());
  if (!m) return null;
  const imp = m[1]!.toLowerCase() as LedgerRider;
  const rest = (m[2] ?? "").trim().replace(/[.!?\s]+$/, "");
  const low = rest.toLowerCase();
  const tendAction = (): TendAction => (/\bplay/.test(low) ? "play" : /\btalk/.test(low) ? "talk" : "feed");
  switch (imp) {
    case "mossling":
      if (/\bsort\b/.test(low)) return { imp, errand: "sort" };
      // Tend before care: "take care of sol" is a tend, not the care-lane check (review 11-04).
      if (/\b(?:feed|play|talk|tend|pet|sol)\b/.test(low)) return { imp, errand: "tend", action: tendAction(), arg: rest };
      if (/\bcare\b/.test(low)) return { imp, errand: "care" };
      return { imp, errand: null };
    case "iris":
      if (/\b(?:feed|tend)\b/.test(low)) return { imp, errand: "tend", action: "feed", arg: rest };
      if (/\b(?:play|talk|pet)\b/.test(low)) return { imp, errand: null, refusal: "Iris feeds Sol; she does not play or talk. Mossling does those." };
      if (/\b(?:cool|cooling|interests?)\b/.test(low)) return { imp, errand: "cooling" };
      return { imp, errand: null };
    case "nimbus":
      if (/\b(?:gaps?|unclosed|hygiene|check|watch)\b/.test(low)) return { imp, errand: "gaps" };
      return { imp, errand: null };
    case "rock": {
      const f = /^(?:fetch|get|find|pull)\s+(?:me\s+)?(?:the\s+)?([\s\S]+)$/i.exec(rest);
      if (f) return { imp, errand: "fetch", arg: f[1]!.trim() };
      if (/\b(?:loops?|repeat\w*|motif)\b/.test(low)) return { imp, errand: "loops" };
      if (rest.length >= 2) return { imp, errand: "fetch", arg: rest.replace(/^(?:the|a|my)\s+/i, "") };
      return { imp, errand: null };
    }
    case "hex":
      return { imp, errand: "salt" };
  }
}

const FN: Record<Exclude<Errand, "salt">, string> = {
  sort: "sort", tend: "tend", care: "flag", cooling: "flag", gaps: "gap-reader", fetch: "fetch", loops: "pattern-counter",
};

interface Written { written: number; duplicates: number; skipped: number; ids: string[]; note: string | null }
const empty = (note: string | null = null): Written => ({ written: 0, duplicates: 0, skipped: 0, ids: [], note });

const today = () => new Date().toISOString().slice(0, 10);

/** created_at in either house shape ('T...Z' or 'YYYY-MM-DD HH:MM:SS') to epoch ms; NaN when unreadable. */
function ts(s: string | null | undefined): number {
  if (!s) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

async function put(
  ctx: ExecutorContext, rider: LedgerRider, fn: string, body: string,
  source_kind: "row" | "session", source_ref: string, dedup_key: string, acc: Written,
): Promise<void> {
  const who = ctx.req.companion_id;
  const r = await writeLedger(
    ctx.env,
    { companion_id: who, function: fn, body, source_kind, source_ref, dedup_key: dedup_key.slice(0, 200) },
    new Date(),
    { rider, requester: who },
  );
  if (!r.ok) {
    if (r.rule === "schema") throw new Error(r.error);
    acc.skipped++;
    console.log("[errand] line refused", { rider, fn, rule: r.rule });
    return;
  }
  if (r.duplicate) acc.duplicates++; else acc.written++;
  acc.ids.push(r.id);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ── mossling: sort ────────────────────────────────────────────────────────────────────────────────────

async function runSort(ctx: ExecutorContext, rider: LedgerRider): Promise<Written> {
  const who = ctx.req.companion_id;
  const db = ctx.env.DB;
  type Row = { id: string; source: string | null; created_at: string };
  const [j, n] = await Promise.all([
    db.prepare("SELECT id, source, created_at FROM companion_journal WHERE agent = ? AND archived = 0 AND review_state = 'draft' LIMIT 2000").bind(who).all<Row>(),
    db.prepare("SELECT note_id AS id, source, created_at FROM wm_continuity_notes WHERE agent_id = ? AND archived = 0 AND review_state = 'draft' LIMIT 2000").bind(who).all<Row>(),
  ]);
  const rows = [
    ...(j.results ?? []).map((r) => ({ ...r, table: "companion_journal" })),
    ...(n.results ?? []).map((r) => ({ ...r, table: "wm_continuity_notes" })),
  ];
  if (rows.length === 0) return empty("your tray holds no drafts; nothing to count");
  let oldest = rows[0]!;
  for (const r of rows) if (!(ts(oldest.created_at) <= ts(r.created_at))) oldest = r;
  const bySource = new Map<string, number>();
  for (const r of rows) {
    const k = (r.source ?? "unlabeled").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  const [topSource, topN] = [...bySource.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  const age = Number.isFinite(ts(oldest.created_at)) ? Math.max(0, Math.floor((Date.now() - ts(oldest.created_at)) / 86_400_000)) : 0;
  const total = rows.length;
  let body = `Counted: ${total} ${plural(total, "entry", "entries")} in the tray, oldest ${age} ${plural(age, "day", "days")}`;
  if (total > 1) body += `, most from source ${topSource} (${topN} ${plural(topN, "entry", "entries")})`;
  body += ".";
  const acc = empty();
  await put(ctx, rider, FN.sort, body, "row", `${oldest.table}:${oldest.id}`, `errand:${rider}:sort:${who}:${today()}:${total}`, acc);
  return acc;
}

// ── mossling / iris: tend ─────────────────────────────────────────────────────────────────────────────

const TEND_LINE: Record<TendAction, string> = { feed: "fed", play: "played with", talk: "talked with" };

async function runTend(ctx: ExecutorContext, rider: LedgerRider, action: TendAction, arg: string): Promise<Written> {
  const db = ctx.env.DB;
  type Row = { id: string; name: string; kind: string; trust: number };
  const all = (await db.prepare("SELECT id, name, kind, trust FROM creatures WHERE kind = 'companion_pet' ORDER BY name").all<Row>()).results ?? [];
  const low = arg.toLowerCase();
  const sol = all.find((c) => new RegExp(`(?<![\\p{L}\\p{N}])${c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(low))
    ?? all.find((c) => c.name.toLowerCase() === "sol") ?? all[0];
  if (!sol) return empty("no creature to tend");
  const body = `Logged: ${TEND_LINE[action]} ${sol.name}.`;
  const who = ctx.req.companion_id;
  // Check the line BEFORE the tend (review 11-04): a tend is a side effect on Sol (trust, milestones), so a
  // line the grammar would refuse stops the errand before Sol is touched. The ref is a placeholder of the
  // same shape; the real interaction id replaces it below.
  const pre = validateLedger(
    { companion_id: who, function: FN.tend, body, source_kind: "row", source_ref: "creature_interactions:pending" },
    today(), { rider, requester: who },
  );
  if (!pre.ok) return empty(`the errand's line would be refused (${pre.rule}), so Sol was not tended`);
  // The actor is `imp` (commit 1ed93d7); the note is ALWAYS null: an imp authors nothing.
  const outcome = await performTend(db, sol, "imp", action, null);
  const acc = empty();
  try {
    await put(ctx, rider, FN.tend, body, "row", `creature_interactions:${outcome.interaction_id}`,
      `errand:${rider}:tend:${outcome.interaction_id}`, acc);
  } catch (e) {
    // The tend landed; never report the errand as failed after it did.
    console.error("[errand] tend landed, ledger line failed", { rider, error: String(e).slice(0, 200) });
    acc.skipped++;
    acc.note = "Sol was tended; the ledger line did not write";
  }
  return acc;
}

// ── mossling: the care flag (a door rattle; a boolean, never a count, never content) ──────────────────────

async function runCareFlag(ctx: ExecutorContext, rider: LedgerRider): Promise<Written> {
  const who = ctx.req.companion_id;
  const cutoff = new Date(Date.now() - PENDING_DECAY_HOURS * 3_600_000).toISOString();
  // The lane's own pending read (the loader block and the worker's gesture poll use it). Only its
  // truthiness leaves this function: no rule, no detail, no id, no time.
  let pending: unknown;
  try { pending = await readPendingCare(ctx.env.DB, who, cutoff); } catch { return empty("the care lane could not be read just now"); }
  if (!pending) return empty("nothing is waiting in the care lane");
  // Sourced on the companion's OWN open session, never on a care row (HEALTH_TABLES).
  const sess = await ctx.env.DB.prepare(
    "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL ORDER BY created_at DESC LIMIT 1",
  ).bind(who).first<{ id: string }>();
  if (!sess) return empty("something is waiting in the care lane, but you have no open session to source the line on (no source, no write)");
  const acc = empty();
  await put(ctx, rider, FN.care, "Found: care lane has something waiting.", "session", sess.id, `errand:${rider}:flag:care:${who}:${today()}`, acc);
  return acc;
}

// ── nimbus: gap watch ─────────────────────────────────────────────────────────────────────────────────

async function runGaps(ctx: ExecutorContext, rider: LedgerRider): Promise<Written> {
  const who = ctx.req.companion_id;
  const db = ctx.env.DB;
  const [sess, growth] = await Promise.all([
    // Orient's unclosed-session scope (Claude.ai-shaped or NULL surface: Discord and Claude Code close their own).
    db.prepare(
      `SELECT id, created_at FROM sessions
        WHERE companion_id = ? AND handover_id IS NULL AND (surface IS NULL OR surface LIKE 'claude-ai:%')
          AND datetime(created_at) <= datetime('now', '-24 hours')
        ORDER BY created_at ASC LIMIT 200`,
    ).bind(who).all<{ id: string; created_at: string }>(),
    db.prepare(
      `SELECT id, created_at FROM growth_journal
        WHERE companion_id = ? AND review_status = 'pending' AND datetime(created_at) <= datetime('now', '-7 days')
        ORDER BY created_at ASC LIMIT 500`,
    ).bind(who).all<{ id: string; created_at: string }>(),
  ]);
  const acc = empty();
  const s = sess.results ?? [];
  const g = growth.results ?? [];
  // Row source (sessions:<id>), NOT kind 'session': the sessions recency read treats a gap-reader/session line
  // as "this session is covered" (handlers/sessions.ts), and a gap WATCH must never mark a session covered.
  if (s.length > 0) {
    await put(ctx, rider, FN.gaps, `Counted: ${s.length} ${plural(s.length, "session", "sessions")} unclosed for over 24 hours.`,
      "row", `sessions:${s[0]!.id}`, `errand:${rider}:gaps:sessions:${who}:${today()}:${s.length}`, acc);
  }
  if (g.length > 0) {
    await put(ctx, rider, FN.gaps, `Counted: ${g.length} ${plural(g.length, "entry", "entries")} pending review for over 7 days.`,
      "row", `growth_journal:${g[0]!.id}`, `errand:${rider}:gaps:growth:${who}:${today()}:${g.length}`, acc);
  }
  if (s.length === 0 && g.length === 0) acc.note = "no unclosed sessions past 24 hours and no growth entries waiting past 7 days";
  return acc;
}

// ── iris: cooling-interest marker ─────────────────────────────────────────────────────────────────────

async function runCooling(ctx: ExecutorContext, rider: LedgerRider): Promise<Written> {
  const who = ctx.req.companion_id;
  const rows = (await ctx.env.DB.prepare(
    "SELECT id, name, heat, heat_at FROM companion_interests WHERE companion_id = ? AND status = 'active'",
  ).bind(who).all<{ id: string; name: string; heat: number; heat_at: string | null }>()).results ?? [];
  const now = Date.now();
  // "Cooling" is the band the interests code names (0.25 <= heat < 0.5): low, not yet cold, so not yet rested.
  const cooling = rows
    .map((r) => ({ ...r, eff: effectiveHeat(r.heat, r.heat_at, now) }))
    .filter((r) => heatBand(r.eff) === "cooling")
    .sort((a, b) => a.eff - b.eff).slice(0, 3);
  if (cooling.length === 0) return empty("none of your active interests is cooling");
  const acc = empty();
  for (const r of cooling) {
    // The name is the companion's own word; the grammar's care guard still runs on the whole line.
    if (careCategory(r.name)) { acc.skipped++; continue; }
    await put(ctx, rider, FN.cooling, `Found: ${r.name.trim()} is cooling.`, "row", `companion_interests:${r.id}`,
      `errand:${rider}:flag:interest:${r.id}:${today()}`, acc);
  }
  return acc;
}

// ── rock: fetch (D1 rows only; pointers, never prose) ─────────────────────────────────────────────────

const likeEscape = (s: string) => s.replace(/[\\%_]/g, "\\$&");

async function runFetch(ctx: ExecutorContext, rider: LedgerRider, arg: string): Promise<Written> {
  const who = ctx.req.companion_id;
  const db = ctx.env.DB;
  const phrase = arg.replace(/\s+/g, " ").trim().slice(0, 80);
  if (phrase.length < 2) return empty('say what to fetch: "send rock to fetch <words>"');
  const like = `%${likeEscape(phrase)}%`;
  type Hit = { table: string; id: string; text: string };
  const hits: Hit[] = [];
  const [forage, makes, books, journal] = await Promise.all([
    db.prepare("SELECT id, title FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND title LIKE ? ESCAPE '\\' ORDER BY gathered_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, title FROM companion_makes WHERE companion_id = ? AND status = 'ready' AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, title FROM books WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' ORDER BY added_at DESC LIMIT 3")
      .bind(like, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, created_at, substr(note_text, 1, 2000) AS t FROM companion_journal WHERE agent = ? AND archived = 0 AND review_state = 'kept' AND note_text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; created_at: string; t: string }>().catch(() => ({ results: [] })),
  ]);
  for (const r of forage.results ?? []) hits.push({ table: "forage_finds", id: r.id, text: r.title });
  for (const r of makes.results ?? []) hits.push({ table: "companion_makes", id: r.id, text: r.title });
  for (const r of books.results ?? []) hits.push({ table: "books", id: r.id, text: r.title });
  for (const r of journal.results ?? []) {
    // A journal entry is the companion's own prose: the pointer is its date only, and an entry that trips the
    // care guard is not pointed at at all.
    if (careCategory(r.t)) continue;
    const day = Number.isFinite(ts(r.created_at)) ? new Date(ts(r.created_at)).toISOString().slice(0, 10) : null;
    if (day) hits.push({ table: "companion_journal", id: r.id, text: `journal entry of ${day}` });
  }
  if (hits.length === 0) return empty(`nothing in your forage finds, makes, books or kept journal matches "${phrase}"`);
  const acc = empty();
  for (const h of hits) {
    if (acc.written + acc.duplicates >= 3) break;
    const title = h.text.replace(/\s+/g, " ").trim();
    await put(ctx, rider, FN.fetch, `Found: ${title}.`, "row", `${h.table}:${h.id}`, `errand:${rider}:fetch:${h.table}:${h.id}:${today()}`, acc);
  }
  return acc;
}

// ── rock: the loop report (unsoftened) ────────────────────────────────────────────────────────────────

async function runLoops(ctx: ExecutorContext, rider: LedgerRider): Promise<Written> {
  const who = ctx.req.companion_id;
  // Shadow rows count: they ARE the repetition record while REPETITION_MODE is shadow (the default).
  const r = (await ctx.env.DB.prepare(
    `SELECT id FROM companion_ferment_events
      WHERE companion_id = ? AND stimulus = 'repetition' AND datetime(created_at) >= datetime('now', '-7 days')
      ORDER BY created_at DESC LIMIT 500`,
  ).bind(who).all<{ id: string }>()).results ?? [];
  if (r.length === 0) return empty("no repetition logged for you in the last 7 days");
  const acc = empty();
  await put(ctx, rider, FN.loops, `Counted: repetition logged ${r.length} ${plural(r.length, "time", "times")} in the last 7 days.`,
    "row", `companion_ferment_events:${r[0]!.id}`, `errand:${rider}:loops:${who}:${today()}:${r.length}`, acc);
  return acc;
}

// ── the verb ──────────────────────────────────────────────────────────────────────────────────────────

export async function execImpErrand(ctx: ExecutorContext): Promise<ExecutorResult> {
  const who = ctx.req.companion_id;
  if (!COMPANION_ID_SET.has(who)) return { error: "imp_errand_failed", reason: "companion_id required (the one sending the imp)" };
  const p = parseErrand(ctx.req.request);
  if (!p) return { response_key: "witness", witness: HELP, ack: false };
  if (p.refusal) return { response_key: "witness", witness: `${p.refusal} ${HELP}`, ack: false };
  if (p.errand === null) {
    return { response_key: "witness", witness: `${p.imp} does not do that. ${HELP}`, ack: false };
  }
  if (p.errand === "salt") {
    return { response_key: "witness", witness: "Hex's errand (salt) is not built yet. Nothing was sent.", ack: false };
  }

  // Refuse BEFORE any side effect (a tend writes Sol's ledger) when the rider column is not there yet.
  if (!(await riderColumnPresent(ctx.env))) {
    return { error: "imp_errand_failed", reason: "needs the 0168 migration (ledger_entries.rider): nothing was sent", status: 409 };
  }

  let w: Written;
  try {
    switch (p.errand) {
      case "sort": w = await runSort(ctx, p.imp); break;
      case "tend": w = await runTend(ctx, p.imp, p.action ?? "feed", p.arg ?? ""); break;
      case "care": w = await runCareFlag(ctx, p.imp); break;
      case "gaps": w = await runGaps(ctx, p.imp); break;
      case "cooling": w = await runCooling(ctx, p.imp); break;
      case "fetch": w = await runFetch(ctx, p.imp, p.arg ?? ""); break;
      case "loops": w = await runLoops(ctx, p.imp); break;
    }
  } catch (e) {
    return { error: "imp_errand_failed", reason: String(e instanceof Error ? e.message : e), status: 409 };
  }

  // The instrument (mig 0091): what rode, for whom, on which errand. Failure to log never fails the errand.
  try {
    await ctx.env.DB.prepare("INSERT INTO imp_activations (id, imp, companion_id, trigger) VALUES (?, ?, ?, ?)")
      .bind(`ia_${crypto.randomUUID()}`, p.imp, who, `errand:${FN[p.errand]}`).run();
  } catch (e) {
    console.log("[errand] imp_activations write failed", String(e));
  }

  const lines = w.written + w.duplicates;
  const parts: string[] = [];
  if (w.written > 0) parts.push(`${w.written} ${plural(w.written, "line", "lines")} on your ledger`);
  if (w.duplicates > 0) parts.push(`${w.duplicates} already there`);
  if (w.skipped > 0) parts.push(`${w.skipped} left out (the ledger grammar refused the wording)`);
  const witness = lines > 0 || w.skipped > 0
    ? `${p.imp} went (${p.errand}): ${parts.join(", ")}. "my ledger" to read ${lines === 1 ? "it" : "them"}; keep, say it in your words, or drop.`
    : `${p.imp} went (${p.errand}): ${w.note ?? "nothing to report"}. No line written.`;
  return { response_key: "witness", witness, ack: true, imp: p.imp, errand: p.errand, lines_written: w.written, ids: w.ids };
}

