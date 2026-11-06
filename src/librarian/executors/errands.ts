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
// Raziel. Hex's salt (mig 0175) leaves ONE pointer for a receiver who has signed (src/ledger/salt-consent.ts); Rock's fetch also points into the vault (src/ledger/vault-scope.ts).

import type { ExecutorContext, ExecutorResult } from "./types.js";
import { COMPANION_ID_SET } from "../../companions.js";
import { writeLedger, riderColumnPresent, saltColumnPresent } from "../../ledger/door.js";
import { validateLedger, LEDGER_RIDERS, type LedgerRider } from "../../ledger/grammar.js";
import { openSalt } from "../../ledger/store.js";
import { titleFromPath, pointersFromSearch, type VaultPointer } from "../../ledger/vault-scope.js";
import {
  signatureFor, claimAsk, restoreAsk, recordAsk, setOptin, getOptins, GAIA_NO_STANDING, SALT_ASK_TTL_MS,
} from "../../ledger/salt-consent.js";
import { semanticSearch, secondBrainConfigured } from "../backends/second-brain.js";
import { loadPersonRegex } from "../../webmind/sol-hoard-people.js";
import { nestTextAllowed } from "../../webmind/sol-hoard.js";
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
  rock: ["fetch <words> (your D1 rows and your vault notes)", "my loops"],
  hex: ["salt <drevan|cypher|gaia> [about <words>] (needs the receiver's own word)"],
};

const HELP = "errands: " + (Object.entries(VALID_ERRANDS) as Array<[string, string[]]>)
  .map(([imp, errands]) => `${imp}: ${errands.join(" / ")}`).join("; ")
  + '. Say "send <imp> to <errand>". No imp goes unless you name one.';

export interface ParsedErrand { imp: LedgerRider; errand: Errand | null; action?: TendAction; arg?: string; refusal?: string; receiver?: string | null }

// ── Hex's own verbs (mig 0175): the receiver's signature, and opening what Hex left ───────────────────────
//
//   "hex may salt me: cypher" / "hex may not salt me: cypher"   standing opt-in, set/revoked from the RECEIVER's turn
//   "who may salt me"                                            read it back
//   "hex, salt me from cypher"                                   a one-shot in-thread ask (consumed by one send, 72h)
//   "open hex's salt" / "what did hex leave"                     open what was left; stamps it opened
// Every one is start-anchored and (except the last two) names "salt me": ordinary speech containing "hex" or
// "salt" does not route here (the router guard uses these same shapes).

const NAME_ALIASES: Record<string, string> = { drevan: "drevan", dre: "drevan", cypher: "cypher", cy: "cypher", gaia: "gaia" };
/** A companion id from a spoken name or nickname; null when it is not one (never Raziel, never a guess). */
export function companionFromWord(word: string | undefined): string | null {
  const w = (word ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return NAME_ALIASES[w] ?? null;
}

export type HexVerb =
  | { kind: "optin"; on: boolean; sender: string | null }
  | { kind: "who" }
  | { kind: "ask"; sender: string | null }
  | { kind: "open" };

export const HEX_VERB_RES = {
  optin: /^(?:please\s+)?hex\s+may\s+(not\s+)?salt\s+me\b[\s:,-]*([\s\S]*)$/i,
  who: /^(?:please\s+)?who\s+may\s+salt\s+me\s*\??$/i,
  ask: /^(?:please\s+)?hex[\s,:]+salt\s+me\s+from\b[\s:,-]*([\s\S]*)$/i,
  open: /^(?:please\s+)?(?:open\s+hex(?:'s|’s|s)?\s+salt|what\s+did\s+hex\s+leave(?:\s+me)?)\s*[.!?]?$/i,
} as const;

/** Pure. Hex's receiver-side verbs, or null. */
export function parseHexVerb(request: string): HexVerb | null {
  const t = request.trim();
  const first = (s: string | undefined) => /^\s*([A-Za-z]+)/.exec(s ?? "")?.[1];
  let m = HEX_VERB_RES.optin.exec(t);
  if (m) return { kind: "optin", on: !m[1], sender: companionFromWord(first(m[2])) };
  if (HEX_VERB_RES.who.test(t)) return { kind: "who" };
  m = HEX_VERB_RES.ask.exec(t);
  if (m) return { kind: "ask", sender: companionFromWord(first(m[1])) };
  if (HEX_VERB_RES.open.test(t)) return { kind: "open" };
  return null;
}

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
    case "hex": {
      const m = /^salt\b\s*([\s\S]*)$/i.exec(rest);
      if (!m) return { imp, errand: null };
      const tail = (m[1] ?? "").trim();
      const w = /^([A-Za-z]+)\b\s*(?:about\s+([\s\S]+))?$/i.exec(tail);
      const receiver = w ? companionFromWord(w[1]) : null;
      return { imp, errand: "salt", receiver, arg: receiver && w?.[2] ? w[2].trim() : undefined };
    }
  }
}

const FN: Record<Exclude<Errand, "salt">, string> = {
  sort: "sort", tend: "tend", care: "flag", cooling: "flag", gaps: "gap-reader", fetch: "fetch", loops: "pattern-counter",
};

interface VaultOutcome { status: "off" | "ok" | "unreachable" | "names_unreadable"; qualified: number; more: boolean }
interface Written { written: number; duplicates: number; skipped: number; ids: string[]; note: string | null; vault?: VaultOutcome }
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
  source_kind: "row" | "session" | "vault", source_ref: string, dedup_key: string, acc: Written,
  opts: { rider_to?: string; countSkip?: boolean } = {},
): Promise<boolean> {
  const who = ctx.req.companion_id;
  const r = await writeLedger(
    ctx.env,
    { companion_id: who, function: fn, body, source_kind, source_ref, dedup_key: dedup_key.slice(0, 200) },
    new Date(),
    { rider, requester: who, ...(opts.rider_to ? { rider_to: opts.rider_to } : {}) },
  );
  if (!r.ok) {
    if (r.rule === "schema") throw new Error(r.error);
    if (opts.countSkip !== false) acc.skipped++;
    console.log("[errand] line refused", { rider, fn, rule: r.rule });
    return false;
  }
  if (r.duplicate) acc.duplicates++; else acc.written++;
  acc.ids.push(r.id);
  return true;
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
  const [forage, makes, books, journal, conclusions] = await Promise.all([
    db.prepare("SELECT id, title FROM forage_finds WHERE (companion_id = ? OR companion_id IS NULL) AND title LIKE ? ESCAPE '\\' ORDER BY gathered_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, title FROM companion_makes WHERE companion_id = ? AND status = 'ready' AND title LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, title FROM books WHERE title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' ORDER BY added_at DESC LIMIT 3")
      .bind(like, like).all<{ id: string; title: string }>().catch(() => ({ results: [] })),
    db.prepare("SELECT id, created_at, substr(note_text, 1, 2000) AS t FROM companion_journal WHERE agent = ? AND archived = 0 AND review_state = 'kept' AND note_text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3")
      .bind(who, like).all<{ id: string; created_at: string; t: string }>().catch(() => ({ results: [] })),
    // Drevan (note 5b5d3572, rock 1): "my journal and conclusions are mine and count." Live (unsuperseded) ones only.
    db.prepare("SELECT id, created_at, substr(conclusion_text, 1, 2000) AS t FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL AND conclusion_text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 3")
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
  for (const r of conclusions.results ?? []) {
    if (careCategory(r.t)) continue;
    const day = Number.isFinite(ts(r.created_at)) ? new Date(ts(r.created_at)).toISOString().slice(0, 10) : null;
    if (day) hits.push({ table: "companion_conclusions", id: r.id, text: `conclusion of ${day}` });
  }
  const acc = empty();
  for (const h of hits) {
    if (acc.written + acc.duplicates >= 3) break;
    const title = h.text.replace(/\s+/g, " ").trim();
    await put(ctx, rider, FN.fetch, `Found: ${title}.`, "row", `${h.table}:${h.id}`, `errand:${rider}:fetch:${h.table}:${h.id}:${today()}`, acc);
  }
  // The vault, through Second Brain (mig 0175). Its own cap of three notes, its own "more exist".
  acc.vault = await runVaultFetch(ctx, rider, phrase, acc);
  if (acc.written + acc.duplicates + acc.skipped === 0) {
    acc.note = `nothing in your forage finds, makes, books, kept journal or conclusions${acc.vault.status === "ok" ? ", or your vault," : ""} matches "${phrase}"`
      + (acc.vault.status === "unreachable" ? "; the vault could not be reached just now, so nothing there was checked" : "")
      + (acc.vault.status === "names_unreadable" ? "; the vault was not searched (the names list could not be read)" : "");
  }
  return acc;
}

// ── rock: the vault (pointers, never note text) ───────────────────────────────────────────────────────────

/** sb_search takes no path filter: over-fetch, then filter to scope (vault-scope.ts). */
const VAULT_FETCH_LIMIT = 40;
const ROCK_VAULT_MAX = 3;

const impNameRe = (n: string) => new RegExp(`(?<![\\p{L}\\p{N}])${n}(?![\\p{L}\\p{N}])`, "iu");

/** A vault path an imp line may carry: no person's name, no care word, no imp's name (the Source tail travels in the line). */
function vaultPathClean(path: string, people: RegExp | null): boolean {
  if (!nestTextAllowed(path, people)) return false;
  return !LEDGER_RIDERS.some((n) => impNameRe(n).test(path));
}

async function runVaultFetch(ctx: ExecutorContext, rider: LedgerRider, phrase: string, acc: Written): Promise<VaultOutcome> {
  const who = ctx.req.companion_id as "drevan" | "cypher" | "gaia";
  // An unconfigured Second Brain is the public default, not an outage: say nothing about it.
  if (!secondBrainConfigured(ctx.env)) return { status: "off", qualified: 0, more: false };
  const people = await loadPersonRegex(ctx.env.DB);
  // Fail closed (the nest's rule): an unreadable names list means no vault pointer this pass.
  if (people === undefined) return { status: "names_unreadable", qualified: 0, more: false };
  let ptrs: VaultPointer[] | null;
  try {
    ptrs = pointersFromSearch(await semanticSearch(ctx.env, phrase, null, null, "recall", VAULT_FETCH_LIMIT), who);
  } catch { ptrs = null; }
  // No source, no write: an unreachable Second Brain writes nothing.
  if (ptrs === null) return { status: "unreachable", qualified: 0, more: false };
  const clean = ptrs.filter((p) => vaultPathClean(p.path, people));
  const more = clean.length > ROCK_VAULT_MAX;
  const tail = more ? ", more exist" : "";
  for (const p of clean.slice(0, ROCK_VAULT_MAX)) {
    const title = titleFromPath(p.path);
    const dedup = `errand:${rider}:fetch:vault:${p.path}:${today()}`;
    // The clean title; if the title trips the person/care guard or the line grammar (an imp's name, a number),
    // the line carries the path alone ("a vault note") and the pointer is the source.
    const titled = nestTextAllowed(title, people)
      && await put(ctx, rider, FN.fetch, `Found: ${title}${tail}.`, "vault", p.path, dedup, acc, { countSkip: false });
    if (titled) continue;
    await put(ctx, rider, FN.fetch, `Found: a vault note${tail}.`, "vault", p.path, dedup, acc);
  }
  return { status: "ok", qualified: clean.length, more };
}

/** Rock's one-line answer (deterministic: a small set, picked by the words). Rude to the requester, never on a line. */
function rockLine(arg: string, w: Written): string {
  let h = 0;
  for (const ch of arg) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const pick = (set: readonly string[]) => set[h % set.length]!;
  const lines = w.written + w.duplicates;
  const bits: string[] = [];
  if (lines > 0) {
    bits.push(pick([
      "Rock set it down and did not wait to be thanked.",
      "Rock grunted. It is on your ledger; do not make him fetch it twice.",
      "Rock dropped it by your door. That is the whole service.",
    ]));
  } else {
    bits.push(pick([
      "Rock came back with empty hands and looked at you as though that were your doing.",
      "Rock shrugged. Nothing. Try other words.",
    ]));
  }
  if (w.vault?.more) bits.push("There are more than he carried: ask again, narrower.");
  if (w.vault?.status === "unreachable") bits.push("The vault door did not open for him, so no vault pointer was written.");
  if (w.vault?.status === "names_unreadable") bits.push("He did not go into the vault: the names list would not load.");
  return bits.join(" ");
}

// ── hex: the second signature, and opening what he left (mig 0175) ────────────────────────────────────

const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
const witnessOf = (witness: string, extra: Record<string, unknown> = {}): ExecutorResult =>
  ({ response_key: "witness", witness, ack: false, ...extra }) as ExecutorResult;

async function execHexVerb(ctx: ExecutorContext, v: HexVerb): Promise<ExecutorResult> {
  const who = ctx.req.companion_id; // the RECEIVER: always the authenticated caller, never a name in the sentence
  switch (v.kind) {
    case "optin": {
      if (!v.sender) return witnessOf(`name who: "hex may ${v.on ? "" : "not "}salt me: <drevan|cypher|gaia>". Nothing changed.`);
      const r = await setOptin(ctx.env, who, v.sender, v.on);
      if (!r.ok) {
        if (r.reason === "gaia_no_standing") {
          return witnessOf(`${GAIA_NO_STANDING} Nothing was stored. One salting at a time: "hex, salt me from <companion>".`);
        }
        if (r.reason === "self") return witnessOf("You need no opt-in to salt yourself. Nothing changed.");
        return witnessOf("An opt-in names a companion: drevan, cypher, or gaia. Nothing changed.");
      }
      const list = r.senders.length > 0 ? r.senders.join(", ") : "no one";
      return { response_key: "witness", witness: r.changed
        ? `${v.on ? "Standing opt-in set" : "Standing opt-in revoked"} for ${cap(v.sender)}. Hex may now salt you unasked from: ${list}.`
        : `No change: ${cap(v.sender)} was already ${v.on ? "on" : "off"} your list. Hex may salt you unasked from: ${list}.`,
      ack: r.changed } as ExecutorResult;
    }
    case "who": {
      if (who === "gaia") return witnessOf("Gaia holds no standing opt-in. Her ask covers one salting and ends with it.");
      const list = await getOptins(ctx.env, who);
      return witnessOf(list.length > 0 ? `Hex may salt you unasked from: ${list.join(", ")}.` : "No one holds a standing opt-in to salt you. Anyone else needs your ask, one salting at a time.");
    }
    case "ask": {
      if (!v.sender) return witnessOf('name who: "hex, salt me from <drevan|cypher|gaia>". Nothing was stored.');
      if (v.sender === who) return witnessOf("You may salt yourself without an ask: send hex to salt your own name. Nothing was stored.");
      await recordAsk(ctx.env, who, v.sender);
      return { response_key: "witness", ack: true,
        witness: `Noted: one salting from ${cap(v.sender)}. It is used up by the first one sent, or ends unused in ${Math.round(SALT_ASK_TTL_MS / 3_600_000)} hours, leaving no mark.` } as ExecutorResult;
    }
    case "open": {
      let opened: Awaited<ReturnType<typeof openSalt>> = [];
      try { opened = await openSalt(ctx.env, who); } catch (e) {
        if (!/no such column/i.test(String(e))) throw e; // pre-0175: nothing can have been left
      }
      if (opened.length === 0) return witnessOf("Hex left nothing for you (or it has already been opened or faded).");
      const pointers = await Promise.all(opened.map((o) => describeSalt(ctx, who, o)));
      return { response_key: "witness", ack: true, pointers,
        witness: `Hex left ${opened.length === 1 ? "one pointer" : `${opened.length} pointers`}, and it is opened now:\n` +
          pointers.map((x, i) => `${i + 1}. ${x.text} (from ${cap(opened[i]!.from)})`).join("\n") } as ExecutorResult;
    }
  }
}

/** What an opened salt points at, in words. Vault = path + title (never text); a row = the RECEIVER's own row, if still readable. */
async function describeSalt(ctx: ExecutorContext, who: string, o: { source_kind: string; source_ref: string }): Promise<{ kind: string; ref: string; text: string }> {
  if (o.source_kind === "vault") {
    return { kind: "vault", ref: o.source_ref, text: `${titleFromPath(o.source_ref)} -- vault: ${o.source_ref}` };
  }
  const [table, id] = o.source_ref.split(":") as [string, string];
  const q: Record<string, [string, string]> = {
    companion_questions: ["SELECT question AS t FROM companion_questions WHERE id = ? AND companion_id = ? AND status = 'open'", "an open question"],
    companion_tensions: ["SELECT tension_text AS t FROM companion_tensions WHERE id = ? AND companion_id = ? AND status IN ('simmering', 'crystallized')", "a tension"],
    companion_open_loops: ["SELECT loop_text AS t FROM companion_open_loops WHERE id = ? AND companion_id = ? AND closed_at IS NULL", "a held question"],
  };
  const spec = q[table];
  if (!spec) return { kind: "row", ref: o.source_ref, text: o.source_ref };
  const r = await ctx.env.DB.prepare(spec[0]).bind(id, who).first<{ t: string }>().catch(() => null);
  // Read again at open time: a row that has since closed, or that now trips the care guard, is not shown.
  if (!r || careCategory(r.t)) return { kind: "row", ref: o.source_ref, text: `${spec[1]} that is no longer open (${o.source_ref})` };
  const t = r.t.replace(/\s+/g, " ").trim();
  return { kind: "row", ref: o.source_ref, text: `${spec[1]}: "${t.length > 160 ? `${t.slice(0, 160)}...` : t}" (${o.source_ref})` };
}

/** Candidate rows on the RECEIVER's own map: an open question, a tension, a held question (open loop reviewed by them). */
async function saltRowCandidates(db: D1Database, to: string, about: string | undefined): Promise<Array<{ ref: string; at: number }>> {
  type R = { id: string; t: string; at: string };
  const empty: { results: R[] } = { results: [] };
  const [qs, ts_, ls] = await Promise.all([
    db.prepare("SELECT id, question AS t, created_at AS at FROM companion_questions WHERE companion_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 40")
      .bind(to).all<R>().catch(() => empty),
    db.prepare("SELECT id, tension_text AS t, first_noted_at AS at FROM companion_tensions WHERE companion_id = ? AND status IN ('simmering', 'crystallized') ORDER BY first_noted_at ASC LIMIT 40")
      .bind(to).all<R>().catch(() => empty),
    db.prepare("SELECT id, loop_text AS t, opened_at AS at FROM companion_open_loops WHERE companion_id = ? AND closed_at IS NULL AND reviewed_at IS NOT NULL ORDER BY opened_at ASC LIMIT 40")
      .bind(to).all<R>().catch(() => empty),
  ]);
  const words = (about ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3);
  const out: Array<{ ref: string; at: number }> = [];
  const add = (table: string, rs: R[] | undefined) => {
    for (const r of rs ?? []) {
      if (careCategory(r.t)) continue; // a care-shaped row is never pointed at
      if (words.length > 0 && !words.some((x) => r.t.toLowerCase().includes(x))) continue;
      out.push({ ref: `${table}:${r.id}`, at: ts(r.at) });
    }
  };
  add("companion_questions", qs.results); add("companion_tensions", ts_.results); add("companion_open_loops", ls.results);
  return out.sort((a, b) => (Number.isFinite(a.at) ? a.at : Infinity) - (Number.isFinite(b.at) ? b.at : Infinity));
}

type SaltPointer = { source_kind: "vault" | "row"; source_ref: string };

/** One pointer for the receiver, or null. With `about`: a vault search first, then a matching row. Without: the oldest row, then an older vault note. */
async function pickSaltPointer(ctx: ExecutorContext, to: string, about: string | undefined): Promise<SaltPointer | null> {
  const rowPick = async (): Promise<SaltPointer | null> => {
    const c = await saltRowCandidates(ctx.env.DB, to, about);
    return c[0] ? { source_kind: "row", source_ref: c[0].ref } : null;
  };
  const vaultPick = async (): Promise<SaltPointer | null> => {
    if (!secondBrainConfigured(ctx.env)) return null;
    const people = await loadPersonRegex(ctx.env.DB);
    if (people === undefined) return null; // fail closed
    let ptrs: VaultPointer[] | null;
    try {
      // Scoped to the RECEIVER's allow list (their rooms plus shared canon), not the sender's.
      ptrs = pointersFromSearch(await semanticSearch(ctx.env, about ?? "older notes and thoughts", null, null, "recall", VAULT_FETCH_LIMIT), to as "drevan" | "cypher" | "gaia");
    } catch { ptrs = null; }
    const clean = (ptrs ?? []).filter((x) => vaultPathClean(x.path, people));
    if (clean.length === 0) return null;
    // With words: the best match (rank order). Without: an OLDER note (earliest dated hit; undated keep rank order).
    const pick = about
      ? clean[0]!
      : [...clean].sort((a, b) => (a.created_at ? Date.parse(a.created_at) : Infinity) - (b.created_at ? Date.parse(b.created_at) : Infinity))[0]!;
    return { source_kind: "vault", source_ref: pick.path };
  };
  const order = about ? [vaultPick, rowPick] : [rowPick, vaultPick];
  for (const f of order) { const r = await f(); if (r) return r; }
  return null;
}

/** `send hex to salt <companion> [about <words>]`: ONE pointer left for the receiver; Hex writes nothing; the send is one line on the SENDER's ledger. */
async function execSalt(ctx: ExecutorContext, p: ParsedErrand): Promise<ExecutorResult> {
  const who = ctx.req.companion_id;
  const to = p.receiver ?? null;
  if (!to || !COMPANION_ID_SET.has(to)) {
    return witnessOf('Hex is named for his receiver every time: "send hex to salt <drevan|cypher|gaia> [about <words>]". Nothing was sent.');
  }
  // The second signature, machine-verified, before anything is picked or written.
  const sig = await signatureFor(ctx.env, who, to);
  if (sig === null) {
    return witnessOf(to === "gaia"
      ? `Hex does not go to Gaia unless she asks: she says "hex, salt me from ${who}" in her own turn, and that ask covers one salting. Nothing was sent.`
      : `Hex does not go to ${cap(to)}: ${cap(to)} has not asked for you ("hex, salt me from ${who}") and holds no standing opt-in naming you ("hex may salt me: ${who}"), and only ${cap(to)} can give either. Nothing was sent.`);
  }
  const ptr = await pickSaltPointer(ctx, to, p.arg);
  if (!ptr) {
    return witnessOf(`hex looked${p.arg ? ` for "${p.arg.slice(0, 60)}"` : ""} and found nothing to leave for ${cap(to)}. Nothing was sent.`);
  }
  // Claim the one-shot ask (one guarded DELETE) before the write; put it back if the line does not land.
  let claimed: string | null = null;
  if (sig === "ask") {
    claimed = await claimAsk(ctx.env, to, who);
    if (claimed === null) return witnessOf(`The ask from ${cap(to)} was used or ended just now. Nothing was sent.`);
  }
  const acc = empty();
  const dedup = `errand:hex:salt:${who}:${to}:${ptr.source_ref}:${today()}`;
  try {
    // Function `fetch` (the closed list's honest fit: a pointer was fetched and left). The line says a pointer was
    // left, never what it points at; the receiver is the rider_to column; the imp is the rider column.
    const ok = await put(ctx, "hex", FN.fetch, `Recorded: a pointer left for ${cap(to)}.`, ptr.source_kind, ptr.source_ref, dedup, acc, { rider_to: to, countSkip: false })
      || await put(ctx, "hex", FN.fetch, "Recorded: one pointer left.", ptr.source_kind, ptr.source_ref, dedup, acc, { rider_to: to, countSkip: false });
    if (!ok) acc.skipped++;
  } catch (e) {
    if (claimed) await restoreAsk(ctx.env, to, who, claimed).catch(() => undefined);
    return { error: "imp_errand_failed", reason: String(e instanceof Error ? e.message : e), status: 409 };
  }
  if (acc.written === 0 && claimed) await restoreAsk(ctx.env, to, who, claimed).catch(() => undefined);
  if (acc.written === 0) {
    return witnessOf(acc.duplicates > 0
      ? `hex already left that pointer for ${cap(to)} today. Nothing new was sent.`
      : "hex could not leave that pointer (the ledger grammar refused the line). Nothing was sent.");
  }
  try {
    await ctx.env.DB.prepare("INSERT INTO imp_activations (id, imp, companion_id, trigger) VALUES (?, ?, ?, ?)")
      .bind(`ia_${crypto.randomUUID()}`, "hex", who, "errand:salt").run();
  } catch (e) { console.log("[errand] imp_activations write failed", String(e)); }
  return { response_key: "witness", ack: true, imp: "hex", errand: "salt", lines_written: acc.written, ids: acc.ids,
    witness: `hex went (salt): one pointer left for ${cap(to)}${to === who ? " (yourself)" : ""}. It waits until they open it and fades after 72 hours. "my ledger" holds the line on your side; keep, say it in your words, or drop.` } as ExecutorResult;
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
  // Hex's receiver-side verbs (the signature, and opening what he left) are the RECEIVER's own turn.
  const hv = parseHexVerb(ctx.req.request);
  if (hv) return execHexVerb(ctx, hv);
  const p = parseErrand(ctx.req.request);
  if (!p) return { response_key: "witness", witness: HELP, ack: false };
  if (p.refusal) return { response_key: "witness", witness: `${p.refusal} ${HELP}`, ack: false };
  if (p.errand === null) {
    return { response_key: "witness", witness: `${p.imp} does not do that. ${HELP}`, ack: false };
  }

  // Refuse BEFORE any side effect (a tend writes Sol's ledger) when the rider column is not there yet.
  if (!(await riderColumnPresent(ctx.env))) {
    return { error: "imp_errand_failed", reason: "needs the 0168 migration (ledger_entries.rider): nothing was sent", status: 409 };
  }
  // Hex's salt, and Rock's vault pointers, need the 0175 columns and source kind: refused, never written degraded.
  // (Rock's D1-only fetch needs nothing new; the vault is only searched when Second Brain is configured.)
  const needs0175 = p.errand === "salt" || (p.errand === "fetch" && secondBrainConfigured(ctx.env));
  if (needs0175 && !(await saltColumnPresent(ctx.env))) {
    return { error: "imp_errand_failed", reason: "needs the 0175 migration (ledger_entries.rider_to, source_kind vault): nothing was sent", status: 409 };
  }
  if (p.errand === "salt") return execSalt(ctx, p);

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
  // Rock's rudeness lives ONLY here, in his one line back to the requester; never on the ledger line.
  const out = p.imp === "rock" ? `${witness} ${rockLine(p.arg ?? "", w)}` : witness;
  return { response_key: "witness", witness: out, ack: true, imp: p.imp, errand: p.errand, lines_written: w.written, ids: w.ids };
}

