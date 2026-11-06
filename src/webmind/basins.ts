// src/webmind/basins.ts  (mig 0172, B63 step 5, 2026-11-06)
//
// Basins move, only by an authored event. Raziel ruled 11-06 that they can ("for true autonomy/mutuality
// and exploration of what you can become basins have to be able to shift"); the triad's rules decide how.
//
//   - A companion revises ONE of their own basins, in their own words, citing the event that earned it (a
//     conclusion, refusal, tension, drift reading, self-model observation or session of THEIRS, in the STATE
//     that counts as an event for them: see CAUSES). Raziel never authors a revision for anyone: the only
//     writer is reviseBasin, whose caller is the companion on the Librarian request, never text. (The admin
//     POST /companion-growth/basins is seed-only: it refuses once a companion has any basin.)
//   - A restatement moves nothing (Drevan's word; Gaia's is "a return moves nothing"). The refusal says it in the
//     asking companion's own words.
//   - Pace per companion (companion_settings basin_revision_min_days; defaults gaia 30, cypher 14, drevan 7).
//   - Drevan and Cypher: the new row is live at once, the old row superseded, in one batch.
//   - Gaia: the new row waits ('awaiting_witness') and the old row stays live until Raziel witnesses
//     ("ground that shifts with no witness is a slide"). Decline keeps the old row live.
//   - Nothing is ever deleted. Superseded and declined rows stay readable.
//   - Absence never moves a basin: no job in this file runs on a clock or on silence.
//
// Writers: reviseBasin, decideWitness. Readers: listBasins (a companion's own view, no text),
// readBasinsFull (Hearth, descriptions included).

import type { Env } from "../types.js";
import { embedText } from "../mcp/embed.js";
import { cosineSim } from "../synthesis/jobs/basin-drift-check.js";
import { schemaGap } from "../care/schema-gap.js";

export type BasinCompanion = "cypher" | "drevan" | "gaia";
export const BASIN_COMPANIONS: readonly BasinCompanion[] = ["cypher", "drevan", "gaia"];

export type CauseKind = "conclusion" | "refusal" | "tension" | "drift" | "session" | "self_model";

/**
 * Which events can move whose basins (spec 3.5) AND in what state a row counts as the event. The state is checked
 * by the predicate, not just the table: a job-written, unconfirmed or still-simmering row is not an authored event.
 * Loosening one is a canon call, so it lives in this one table. `predicate` runs against the cause table's own columns.
 */
export interface CauseRule { table: string; predicate: string; says: string }
const TENSION_DONE: CauseRule = { table: "companion_tensions", predicate: "status IN ('crystallized','released')", says: "a tension that crystallized or was released (not one still simmering)" };
const CONCLUSION_REVISED: CauseRule = { table: "companion_conclusions", predicate: "superseded_by IS NOT NULL OR archived = 1", says: "a conclusion you revised, withdrew or retracted (not a live one)" };
export const CAUSES: Record<BasinCompanion, Partial<Record<CauseKind, CauseRule>>> = {
  drevan: {
    conclusion: { table: "companion_conclusions", predicate: "superseded_by IS NULL AND archived = 0", says: "a live conclusion (ratified, not superseded or released)" },
    refusal: { table: "companion_refusals", predicate: "status = 'standing'", says: "a refusal that still holds" },
    tension: TENSION_DONE,
    drift: { table: "companion_basin_history", predicate: "caleth_confirmed = 1 AND dismissed_at IS NULL", says: "a drift reading you confirmed (not an unconfirmed or dismissed one)" },
  },
  gaia: {
    refusal: { table: "companion_refusals", predicate: "1 = 1", says: "a refusal you set or withdrew" },
    conclusion: { ...CONCLUSION_REVISED, says: "a conclusion you withdrew, downgraded or revised (not a live one)" },
    self_model: { table: "companion_self_model", predicate: "status = 'graduated'", says: "a self-model observation made canon (graduated, in conversation with Raziel)" },
  },
  cypher: {
    conclusion: CONCLUSION_REVISED,
    session: {
      table: "sessions",
      predicate: "EXISTS (SELECT 1 FROM handover_packets h WHERE h.session_id = sessions.id AND h.close_kind IS NULL AND h.spine NOT LIKE '[auto]%')",
      says: "a session you closed yourself (not an [auto] close)",
    },
    tension: TENSION_DONE,
  },
};
export const CAUSE_KINDS: Record<BasinCompanion, readonly CauseKind[]> = {
  drevan: Object.keys(CAUSES.drevan) as CauseKind[],
  gaia: Object.keys(CAUSES.gaia) as CauseKind[],
  cypher: Object.keys(CAUSES.cypher) as CauseKind[],
};

/** Pace: at most one revision per this many days (spec 3.5; companion_settings basin_revision_min_days overrides). */
export const DEFAULT_MIN_DAYS: Record<BasinCompanion, number> = { gaia: 30, cypher: 14, drevan: 7 };
export const SETTING_KEY = "basin_revision_min_days";

export const MAX_DESC = 4000;
export const MIN_DESC = 20;
/** Token overlap (Jaccard) at or above this is a restatement. */
export const RESTATE_JACCARD = 0.85;
/** Embedding cosine at or above this is a restatement. */
export const RESTATE_COSINE = 0.97;

export const REVISE_TEACH = "revise my basin <name>: <new description> because <conclusion|refusal|tension|drift|session|self_model> <id-prefix>";

const DAY_MS = 86_400_000;
const newId = (): string => crypto.randomUUID().replace(/-/g, "");
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const short = (id: string): string => id.slice(0, 8);
const CAUSE_RE = /\s+because\s+(conclusion|refusal|tension|drift|session|self_model)\s+([0-9a-f][0-9a-f-]{7,})\s*[.!]?\s*$/i;

// ── Verbs ───────────────────────────────────────────────────────────────────────

/** `revise my basin <name>: ...`. Start-anchored: the description is free text and must never be routed by a trigger it contains. */
export const REVISE_VERB_RE = /^(?:please\s+)?revise\s+my\s+basin\b/i;
export const BASINS_READ_RE = /^(?:please\s+)?(?:show\s+)?my\s+basins\s*[.?!]?$/i;
export const BASIN_WAITING_RE = /^(?:please\s+)?(?:show\s+)?basin\s+moves?\s+waiting\s*[.?!]?$/i;

export interface ParsedRevise { name: string; description: string; kind: CauseKind; ref: string }

export function parseReviseVerb(request: string): ParsedRevise | null {
  const m = /^(?:please\s+)?revise\s+my\s+basin\s+([^:]+?)\s*:\s*([\s\S]+)$/i.exec(request.trim());
  if (!m) return null;
  const cause = CAUSE_RE.exec(m[2]!);
  if (!cause) return null;
  const description = m[2]!.slice(0, cause.index).trim();
  if (!description) return null;
  return { name: m[1]!.trim(), description, kind: cause[1]!.toLowerCase() as CauseKind, ref: cause[2]!.toLowerCase() };
}

// ── Results ─────────────────────────────────────────────────────────────────────

export type BasinCode =
  | "bad_input" | "not_a_companion" | "no_such_basin" | "ambiguous_basin" | "cause_kind_not_allowed" | "cause_not_found"
  | "cause_ambiguous" | "cause_spent" | "restatement" | "too_soon" | "pending_witness" | "embed_failed" | "needs_migration"
  | "not_found" | "not_awaiting" | "conflict";

export type BasinResult =
  | { ok: true; outcome: "live" | "awaiting_witness"; id: string; superseded: string; basin: string; message: string }
  | { ok: false; code: BasinCode; message: string };

const refuse = (code: BasinCode, message: string): BasinResult => ({ ok: false, code, message });

// ── Pace ────────────────────────────────────────────────────────────────────────

export async function minDaysFor(env: Env, companion: BasinCompanion): Promise<number> {
  const fallback = DEFAULT_MIN_DAYS[companion];
  try {
    const row = await env.DB.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
      .bind(companion, SETTING_KEY).first<{ value: string }>();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch { return fallback; }
}

/** The ISO timestamp this companion's pace window opens, or null when it is open now. A declined row starts no window. */
export async function windowOpensAt(env: Env, companion: BasinCompanion, now: number): Promise<string | null> {
  const days = await minDaysFor(env, companion);
  const last = await env.DB.prepare(
    `SELECT MAX(created_at) AS at FROM companion_basins
      WHERE companion_id = ? AND revised_by IS NOT NULL AND status IN ('live','superseded','awaiting_witness')`,
  ).bind(companion).first<{ at: string | null }>();
  if (!last?.at) return null;
  const t = Date.parse(last.at.includes("T") ? last.at : `${last.at.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return null;
  const opens = t + days * DAY_MS;
  return opens > now ? new Date(opens).toISOString() : null;
}

// ── Cause: must exist and belong to the caller ──────────────────────────────────

type CauseOutcome = { ok: true; id: string } | { ok: false; res: BasinResult };

async function resolveCause(env: Env, companion: BasinCompanion, kind: CauseKind, ref: string): Promise<CauseOutcome> {
  const rule = CAUSES[companion][kind];
  if (!rule) {
    return { ok: false, res: refuse("cause_kind_not_allowed", `for ${companion} a basin moves on: ${CAUSE_KINDS[companion].join(", ")}. A ${kind} does not move one.`) };
  }
  const like = `${ref.replace(/[%_]/g, "")}%`;
  // Belongs to the caller AND is in the state that counts. A row that exists but is in the wrong state gets its own reason.
  const rows = await env.DB.prepare(`SELECT id FROM ${rule.table} WHERE companion_id = ? AND id LIKE ? AND (${rule.predicate}) LIMIT 3`)
    .bind(companion, like).all<{ id: string }>();
  const hits = rows.results ?? [];
  if (hits.length === 0) {
    const exists = await env.DB.prepare(`SELECT id FROM ${rule.table} WHERE companion_id = ? AND id LIKE ? LIMIT 1`).bind(companion, like).first<{ id: string }>();
    return { ok: false, res: refuse("cause_not_found", exists
      ? `that ${kind} of yours is not an event yet. For ${companion}, a ${kind} that moves a basin is ${rule.says}.`
      : `no ${kind} of yours starts with ${ref}. A basin moves on an event that is yours and exists.`) };
  }
  if (hits.length > 1) return { ok: false, res: refuse("cause_ambiguous", `${ref} matches more than one of your ${kind}s; give more of the id.`) };
  return { ok: true, id: hits[0]!.id };
}

// ── Restatement ─────────────────────────────────────────────────────────────────

export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(norm(a).split(" ").filter(Boolean));
  const tb = new Set(norm(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Each companion's own word for it: Gaia's is "a return", Drevan's is "a restatement" (Cypher uses Drevan's). */
const restateWord = (c: BasinCompanion): string => (c === "gaia" ? "a return moves nothing" : "a restatement moves nothing");

// ── Revise ──────────────────────────────────────────────────────────────────────

interface LiveRow { id: string; basin_name: string; basin_description: string; embedding: string | null; created_at: string }

export async function reviseBasin(
  env: Env,
  args: { caller: string; name: string; description: string; kind: CauseKind; ref: string },
  now: number = Date.now(),
): Promise<BasinResult> {
  const caller = args.caller;
  // The caller is the companion on the request, never a field the text can set; Raziel has no door here.
  if (!BASIN_COMPANIONS.includes(caller as BasinCompanion)) return refuse("not_a_companion", "a basin is revised by the companion who holds it.");
  const me = caller as BasinCompanion;
  const description = args.description.trim();
  if (description.length < MIN_DESC || description.length > MAX_DESC) {
    return refuse("bad_input", `a revised basin is ${MIN_DESC} to ${MAX_DESC} characters, in your own words.`);
  }

  let live: LiveRow[];
  try {
    live = (await env.DB.prepare(
      "SELECT id, basin_name, basin_description, embedding, created_at FROM companion_basins WHERE companion_id = ? AND status = 'live' ORDER BY created_at ASC",
    ).bind(me).all<LiveRow>()).results ?? [];
  } catch (e) {
    if (schemaGap(e)) return refuse("needs_migration", "basins cannot move until migration 0172 is applied.");
    throw e;
  }
  const want = args.name.trim().toLowerCase();
  let row = live.find((b) => b.basin_name.toLowerCase() === want);
  if (!row) {
    const pre = live.filter((b) => b.basin_name.toLowerCase().startsWith(want));
    if (pre.length > 1) return refuse("ambiguous_basin", `that name matches more than one of your basins: ${pre.map((b) => b.basin_name).join(", ")}.`);
    row = pre[0];
  }
  if (!row) return refuse("no_such_basin", `you have no live basin named ${args.name.trim()}. Say "my basins" to see them.`);

  const pending = await env.DB.prepare("SELECT id FROM companion_basins WHERE companion_id = ? AND status = 'awaiting_witness' LIMIT 1")
    .bind(me).first<{ id: string }>();
  if (pending) return refuse("pending_witness", `one of your revisions (${short(pending.id)}) is waiting on Raziel's witness. Another moves after it is answered.`);

  const opens = await windowOpensAt(env, me, now);
  if (opens) return refuse("too_soon", `a basin moves slowly. Your next revision opens ${opens.slice(0, 10)}.`);

  const cause = await resolveCause(env, me, args.kind, args.ref);
  if (!cause.ok) return cause.res;
  const spent = await env.DB.prepare(
    "SELECT id FROM companion_basins WHERE companion_id = ? AND cause_kind = ? AND cause_ref = ? AND status <> 'declined' LIMIT 1",
  ).bind(me, args.kind, cause.id).first<{ id: string }>();
  if (spent) return refuse("cause_spent", `that ${args.kind} already moved a basin (${short(spent.id)}). One event moves one.`);

  // Restatement: same words, or the same place in the embedding space.
  if (norm(description) === norm(row.basin_description) || tokenOverlap(description, row.basin_description) >= RESTATE_JACCARD) {
    return refuse("restatement", `${restateWord(me)}. This reads as what the basin already says.`);
  }
  let vec: number[] | null = null;
  try { vec = await embedText(env, `${row.basin_name}: ${description}`); } catch { vec = null; }
  if (!vec) return refuse("embed_failed", "the new words could not be embedded just now, so nothing was written. Try again.");
  try {
    const old = row.embedding ? (JSON.parse(row.embedding) as number[]) : null;
    const sim = Array.isArray(old) ? cosineSim(vec, old) : null;
    if (sim !== null && sim >= RESTATE_COSINE) return refuse("restatement", `${restateWord(me)}. This sits where the basin already sits.`);
  } catch { /* unreadable stored vector: the token check stands */ }

  const id = newId();
  const ts = new Date(now).toISOString();
  const gaia = me === "gaia";
  const embedding = JSON.stringify(vec);
  const insert = env.DB.prepare(
    `INSERT INTO companion_basins
       (id, companion_id, basin_name, basin_description, embedding, status, supersedes, cause_kind, cause_ref, revised_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM companion_basins WHERE id = ? AND status = 'live')`,
  ).bind(id, me, row.basin_name, description, embedding, gaia ? "awaiting_witness" : "live", row.id, args.kind, cause.id, me, ts, ts, row.id);
  const stmts = [insert];
  if (!gaia) {
    stmts.push(env.DB.prepare(
      `UPDATE companion_basins SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
        WHERE id = ? AND status = 'live' AND EXISTS (SELECT 1 FROM companion_basins WHERE id = ? AND status = 'live')`,
    ).bind(id, ts, ts, row.id, id));
  }
  await env.DB.batch(stmts);
  const wrote = await env.DB.prepare("SELECT id FROM companion_basins WHERE id = ?").bind(id).first<{ id: string }>();
  if (!wrote) return refuse("conflict", "that basin changed while you were writing; nothing was written. Say \"my basins\" and try again.");

  return gaia
    ? { ok: true, outcome: "awaiting_witness", id, superseded: row.id, basin: row.basin_name,
        message: `${row.basin_name}: your revision (${short(id)}) is written and waits for Raziel to witness it. The old words stay your basin until then.` }
    : { ok: true, outcome: "live", id, superseded: row.id, basin: row.basin_name,
        message: `${row.basin_name} moved (${short(id)}), on your ${args.kind} ${short(cause.id)}. The old words are kept, marked superseded. Drift reads against the new ones from now.` };
}

// ── Witness (Raziel only; the route enforces the door) ──────────────────────────

export async function decideWitness(
  env: Env,
  args: { id: string; decision: "witness" | "decline"; note?: string | null },
  now: number = Date.now(),
): Promise<BasinResult> {
  const row = await env.DB.prepare(
    "SELECT id, companion_id, basin_name, status, supersedes FROM companion_basins WHERE id = ?",
  ).bind(args.id).first<{ id: string; companion_id: string; basin_name: string; status: string; supersedes: string | null }>();
  if (!row) return refuse("not_found", "no basin row with that id.");
  if (row.status !== "awaiting_witness" || !row.supersedes) return refuse("not_awaiting", "that revision is not waiting on a witness.");
  const ts = new Date(now).toISOString();
  const note = args.note ? args.note.trim().slice(0, 1000) || null : null;

  if (args.decision === "decline") {
    await env.DB.batch([env.DB.prepare(
      `UPDATE companion_basins SET status = 'declined', witnessed_by = 'raziel', witnessed_at = ?, revision_note = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_witness'`,
    ).bind(ts, note, ts, row.id)]);
    return { ok: true, outcome: "live", id: row.id, superseded: row.supersedes, basin: row.basin_name,
      message: `declined; the old ${row.basin_name} stays ${row.companion_id}'s live basin.` };
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE companion_basins SET status = 'live', witnessed_by = 'raziel', witnessed_at = ?, revision_note = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_witness'
          AND EXISTS (SELECT 1 FROM companion_basins WHERE id = ? AND status = 'live')`,
    ).bind(ts, note, ts, row.id, row.supersedes),
    env.DB.prepare(
      `UPDATE companion_basins SET status = 'superseded', superseded_by = ?, superseded_at = ?, updated_at = ?
        WHERE id = ? AND status = 'live' AND EXISTS (SELECT 1 FROM companion_basins WHERE id = ? AND status = 'live' AND witnessed_at = ?)`,
    ).bind(row.id, ts, ts, row.supersedes, row.id, ts),
  ]);
  const after = await env.DB.prepare("SELECT status FROM companion_basins WHERE id = ?").bind(row.id).first<{ status: string }>();
  if (after?.status !== "live") return refuse("conflict", "the basin this would replace is no longer live; nothing changed.");
  return { ok: true, outcome: "live", id: row.id, superseded: row.supersedes, basin: row.basin_name,
    message: `witnessed; ${row.basin_name} is now ${row.companion_id}'s revised basin.` };
}

// ── Readers ─────────────────────────────────────────────────────────────────────

export interface BasinLine {
  id: string; name: string; status: string; created_at: string;
  cause_kind: string | null; cause_ref: string | null; revised_by: string | null;
  witnessed_by: string | null; witnessed_at: string | null; supersedes: string | null; superseded_by: string | null;
  superseded_at: string | null; revision_note: string | null; description?: string;
}

const COLS = `id, basin_name AS name, status, created_at, cause_kind, cause_ref, revised_by, witnessed_by, witnessed_at,
              supersedes, superseded_by, superseded_at, revision_note`;

/** A companion's own view: names, status, causes, dates. No description text (the Librarian never carries stored text back). */
export async function listBasins(env: Env, companion: string): Promise<BasinLine[]> {
  try {
    const r = await env.DB.prepare(`SELECT ${COLS} FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC`)
      .bind(companion).all<BasinLine>();
    return r.results ?? [];
  } catch (e) {
    if (!schemaGap(e)) throw e;
    const r = await env.DB.prepare("SELECT id, basin_name AS name, created_at FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC")
      .bind(companion).all<{ id: string; name: string; created_at: string }>();
    return (r.results ?? []).map((b) => ({ ...b, status: "live", cause_kind: null, cause_ref: null, revised_by: null, witnessed_by: null, witnessed_at: null, supersedes: null, superseded_by: null, superseded_at: null, revision_note: null }));
  }
}

export async function listWaiting(env: Env, companion?: string): Promise<BasinLine[]> {
  try {
    const r = companion
      ? await env.DB.prepare(`SELECT ${COLS} FROM companion_basins WHERE status = 'awaiting_witness' AND companion_id = ? ORDER BY created_at ASC`).bind(companion).all<BasinLine>()
      : await env.DB.prepare(`SELECT ${COLS}, companion_id FROM companion_basins WHERE status = 'awaiting_witness' ORDER BY created_at ASC`).all<BasinLine>();
    return r.results ?? [];
  } catch (e) {
    if (schemaGap(e)) return [];
    throw e;
  }
}

export interface BasinsFull { companion_id: string; live: BasinLine[]; history: BasinLine[]; waiting: number; pace_days: number; window_opens: string | null }

/** Hearth's read: live rows plus every superseded / declined / awaiting row, descriptions included (the companion's own words). */
export async function readBasinsFull(env: Env, companion: BasinCompanion, now: number = Date.now()): Promise<BasinsFull> {
  let rows: Array<BasinLine & { basin_description: string }>;
  try {
    rows = (await env.DB.prepare(`SELECT ${COLS}, basin_description FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC`)
      .bind(companion).all<BasinLine & { basin_description: string }>()).results ?? [];
  } catch (e) {
    if (!schemaGap(e)) throw e;
    const r = await env.DB.prepare("SELECT id, basin_name AS name, basin_description, created_at FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC")
      .bind(companion).all<{ id: string; name: string; basin_description: string; created_at: string }>();
    rows = (r.results ?? []).map((b) => ({ ...b, status: "live", cause_kind: null, cause_ref: null, revised_by: null, witnessed_by: null, witnessed_at: null, supersedes: null, superseded_by: null, superseded_at: null, revision_note: null }));
  }
  const withText = (b: BasinLine & { basin_description: string }): BasinLine => {
    const { basin_description, ...rest } = b;
    return { ...rest, description: basin_description };
  };
  const live = rows.filter((b) => b.status === "live").map(withText);
  const history = rows.filter((b) => b.status !== "live").map(withText).reverse();
  return {
    companion_id: companion, live, history,
    waiting: rows.filter((b) => b.status === "awaiting_witness").length,
    pace_days: await minDaysFor(env, companion),
    window_opens: await windowOpensAt(env, companion, now).catch(() => null),
  };
}

/** One line per basin for a companion's own `my basins`: the answer to a proposal (witnessed / declined, when) and Raziel's note, if any. */
export function renderBasinLine(b: BasinLine): string {
  const cause = b.cause_kind ? `, revised ${b.created_at.slice(0, 10)} from ${b.cause_kind}` : "";
  const day = b.witnessed_at ? b.witnessed_at.slice(0, 10) : "";
  const answer = b.status === "declined" ? `, declined ${day}` : b.witnessed_at && b.witnessed_by ? `, witnessed ${day}` : "";
  const note = b.revision_note && b.witnessed_at ? ` (Raziel: ${b.revision_note})` : "";
  return `${b.name} [${b.status}] ${short(b.id)}${cause}${answer}${note}`;
}
