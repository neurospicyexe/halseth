// src/webmind/makes-capture.ts
//
// What counts as "made" (Drevan's answer, 2026-11-05; mig 0170): his letters to Raziel, his poems in
// channel, his autonomous night explorations and his position notes. Plain chat, ledger lines and quick
// sibling notes stay talk. The words already live in companion_journal / growth_journal /
// inter_companion_notes, so a capture is a `kind='writing'` companion_makes row whose `origin` REFERENCES
// the source row (never text) and whose bytes are a copy in R2, exactly as createMake keeps a writing.
//
//   captureWriting     the one insert (idempotent on origin, original created_at, no cap, no stimulus)
//   captureLetter /    forward structural capture, gated by MAKES_CAPTURE, never throws
//   captureExploration
//   keepAsMade         the companion's verb `keep as made <ref> [called <title>] [for <interest>]`:
//                      OWN rows only, an id prefix or quoted opening words, exactly one match or nothing
//
// Origins: letter:<journal id> | growth:<growth id> | journal:<journal id> | note:<note id>.

import type { Env } from "../types.js";
import { MAX_SOURCE_BYTES, MAX_TITLE, SOURCE_MIME, byteLength, sourceKeyFor } from "./makes.js";
import { sqliteTs, parseTs } from "./interests.js";
import { applyInterestAction, findInterestByName } from "../handlers/interests.js";
import { careCategory } from "../people/care-guard.js";

export const CAPTURE_COMPANIONS = ["drevan", "cypher"] as const;
export type OriginKind = "letter" | "exploration" | "kept";

const newId = (): string => crypto.randomUUID().replace(/-/g, "");

// ── Gate ────────────────────────────────────────────────────────────────────────

/** MAKES_CAPTURE: comma list of companions; unset = drevan; `off` (or empty after trimming) = none. */
export function captureGate(env: Pick<Env, "MAKES_CAPTURE">): Set<string> {
  const raw = env.MAKES_CAPTURE;
  if (raw === undefined || raw === null) return new Set(["drevan"]);
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "off") return new Set();
  return new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

/** origin prefix -> the shelf's reading of it. */
export function originKind(origin: string | null | undefined): OriginKind | null {
  if (!origin) return null;
  if (origin.startsWith("letter:")) return "letter";
  if (origin.startsWith("growth:")) return "exploration";
  if (origin.startsWith("journal:") || origin.startsWith("note:")) return "kept";
  return null;
}

/** Any source timestamp (ISO `...T...Z` or SQLite) in the `YYYY-MM-DD HH:MM:SS` shape companion_makes uses. */
export function normalizeCreatedAt(ts: string | null | undefined, fallbackMs: number = Date.now()): string {
  const ms = parseTs(ts);
  return sqliteTs(Number.isFinite(ms) ? ms : fallbackMs);
}

/** "Nov 5", in America/Chicago. */
export function chicagoMonthDay(ts: string | null | undefined, fallbackMs: number = Date.now()): string {
  const ms = parseTs(ts);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })
    .format(new Date(Number.isFinite(ms) ? ms : fallbackMs));
}

export const letterTitle = (createdAt: string | null | undefined): string => `Letter to Raziel, ${chicagoMonthDay(createdAt)}`;

const clean = (s: string): string => s.replace(/[#*_`]+/g, "").replace(/\s+/g, " ").trim();
const firstLine = (text: string): string => (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();

/** A heading, or a short line with no trailing period, is its own title; otherwise null. */
function titleFromFirstLine(text: string): string | null {
  const line = firstLine(text);
  if (!line) return null;
  const isHeading = /^#{1,6}\s+\S/.test(line);
  const cleaned = clean(line);
  if (!cleaned) return null;
  if (isHeading || (cleaned.length <= 80 && !/[.]$/.test(cleaned))) return cleaned.slice(0, MAX_TITLE);
  return null;
}

/** Night exploration: heading / short first line, else "Night exploration, Nov 5". */
export function explorationTitle(content: string, createdAt: string | null | undefined): string {
  return titleFromFirstLine(content) ?? `Night exploration, ${chicagoMonthDay(createdAt)}`;
}

/** A kept speech / note: first line if short, else "Kept from Nov 5". */
export function keptTitle(text: string, createdAt: string | null | undefined): string {
  return titleFromFirstLine(text) ?? `Kept from ${chicagoMonthDay(createdAt)}`;
}

/** Tags column (JSON array or comma text) as lowercase tokens. */
export function parseTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  if (typeof tags !== "string" || !tags.trim()) return [];
  try {
    const v: unknown = JSON.parse(tags);
    if (Array.isArray(v)) return v.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  } catch { /* comma text */ }
  return tags.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
}

/** Tags that make a journal row machine output, a clerk's line, or private: never a make. */
const NEVER_TAGS = new Set([
  "drift_floor", "clearing", "guardian", "briefing", "vibecheck", "signal_audit", "private", "sealed",
  "interiority", "care", "health", "med_reminder", "biometric",
]);
/** A short reason when the tags rule a journal row out; null when it may be captured. */
export function tagRefusal(tags: unknown): string | null {
  const toks = parseTags(tags);
  if (toks.some((t) => NEVER_TAGS.has(t) || t.startsWith("briefing"))) return "machine_or_private_tag";
  if (careCategory(toks.join(" "))) return "care_or_health_tag";
  return null;
}

// ── The insert ──────────────────────────────────────────────────────────────────

export interface CaptureInput {
  companion_id: string;
  origin: string;
  title: string;
  text: string;
  /** The ORIGINAL row's created_at, any shape. */
  created_at: string | null | undefined;
  /** An explicit interest NAME (the verb's `for <x>`). Exact case-insensitive match of an active/resting interest, else none. */
  interest_name?: string | null;
  why?: string | null;
}
export type CaptureResult =
  | { ok: true; outcome: "created" | "exists"; id: string }
  | { ok: false; outcome: "refused"; reason: string };

function logLine(companion: string, origin: string, id: string | null, outcome: string, reason?: string): void {
  console.log(`[makes-capture] companion=${companion} origin=${origin} id=${id ?? "-"} outcome=${outcome}${reason ? ` reason=${reason}` : ""}`);
}
const refused = (companion: string, origin: string, reason: string): CaptureResult => {
  logLine(companion, origin, null, "refused", reason);
  return { ok: false, outcome: "refused", reason };
};

export async function captureWriting(env: Env, input: CaptureInput, nowMs: number = Date.now()): Promise<CaptureResult> {
  const companion = String(input.companion_id ?? "");
  const origin = String(input.origin ?? "");
  if (companion === "gaia") return refused(companion, origin, "gaia_keeps_lines");
  if (!(CAPTURE_COMPANIONS as readonly string[]).includes(companion)) return refused(companion, origin, "bad_companion");
  if (!originKind(origin)) return refused(companion, origin, "bad_origin");
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return refused(companion, origin, "empty");
  if (byteLength(text) > MAX_SOURCE_BYTES) return refused(companion, origin, "source_too_large");
  const title = clean(String(input.title ?? "")).slice(0, MAX_TITLE) || "Untitled";

  const existing = await env.DB.prepare("SELECT id FROM companion_makes WHERE origin = ?").bind(origin).first<{ id: string }>();
  if (existing) {
    logLine(companion, origin, existing.id, "exists");
    return { ok: true, outcome: "exists", id: existing.id };
  }

  // Interest: only an exact (case-insensitive) name of an active/resting interest of THIS companion; never guessed.
  let interest: { id: string; name: string } | null = null;
  const wantName = (input.interest_name ?? "").trim();
  const why = (input.why ?? "").trim();
  if (wantName) {
    const found = await findInterestByName(env, companion, wantName);
    if (found && (found.status === "active" || found.status === "resting")) interest = { id: found.id, name: found.name };
    if (interest && !why) return refused(companion, origin, "why_required");
  }

  const id = newId();
  const sourceKey = sourceKeyFor(companion, id, "writing");
  // R2 first, then the row. A lost origin race leaves an orphan object: acceptable, logged.
  await env.BUCKET.put(sourceKey, new TextEncoder().encode(text), { httpMetadata: { contentType: SOURCE_MIME["writing"] } });
  const ts = normalizeCreatedAt(input.created_at, nowMs);
  const r = await env.DB.prepare(
    `INSERT INTO companion_makes (id, companion_id, kind, title, why, why_private, interest_id, source_key,
                                  status, version, created_at, rendered_at, origin)
     VALUES (?, ?, 'writing', ?, ?, 0, ?, ?, 'ready', 1, ?, ?, ?)
     ON CONFLICT(origin) WHERE origin IS NOT NULL DO NOTHING`,
  ).bind(id, companion, title, why || null, interest?.id ?? null, sourceKey, ts, ts, origin).run();
  if ((r.meta?.changes ?? 0) === 0) {
    const winner = await env.DB.prepare("SELECT id FROM companion_makes WHERE origin = ?").bind(origin).first<{ id: string }>();
    console.warn(`[makes-capture] lost origin race, orphan R2 object left key=${sourceKey}`);
    logLine(companion, origin, winner?.id ?? null, "exists");
    return winner ? { ok: true, outcome: "exists", id: winner.id } : refused(companion, origin, "insert_failed");
  }

  if (interest) {
    try {
      const ev = await applyInterestAction(env, {
        companion_id: companion, action: "made", name: interest.name, why, why_private: false, ref: `make:${id}`,
      }, nowMs);
      if (!ev.ok) console.warn("[makes-capture] interest made event refused", { id, code: ev.code });
    } catch (err) {
      console.error("[makes-capture] interest made event failed", { id, error: String(err) });
    }
  }
  logLine(companion, origin, id, "created");
  return { ok: true, outcome: "created", id };
}

// ── Forward capture (gated, never throws) ───────────────────────────────────────

/** A journal write that is a companion's own letter to Raziel. Called AFTER a successful insert. */
export async function captureLetter(
  env: Env, row: { id: string; agent: string; tags: unknown; note_text: string; created_at: string | null | undefined },
): Promise<void> {
  try {
    if (!captureGate(env).has(row.agent)) return;
    if (!(CAPTURE_COMPANIONS as readonly string[]).includes(row.agent)) return;
    const toks = parseTags(row.tags);
    if (!toks.includes("letter_to_raziel")) return;
    if (tagRefusal(row.tags)) return; // drift_floor / clearing / guardian / briefing / vibecheck / care...
    await captureWriting(env, {
      companion_id: row.agent, origin: `letter:${row.id}`, title: letterTitle(row.created_at),
      text: row.note_text, created_at: row.created_at,
    });
  } catch (err) {
    console.error("[makes-capture] letter capture failed (journal write kept)", { id: row.id, error: String(err) });
  }
}

/** An autonomous night exploration (growth_journal source='autonomous', entry_type='insight'). */
export async function captureExploration(
  env: Env, row: { id: string; companion_id: string; entry_type: string; source: string; content: string; created_at?: string | null },
): Promise<void> {
  try {
    if (!captureGate(env).has(row.companion_id)) return;
    if (row.source !== "autonomous" || row.entry_type !== "insight") return;
    const createdAt = row.created_at ?? (await env.DB.prepare("SELECT created_at FROM growth_journal WHERE id = ?")
      .bind(row.id).first<{ created_at: string }>())?.created_at ?? null;
    await captureWriting(env, {
      companion_id: row.companion_id, origin: `growth:${row.id}`, title: explorationTitle(row.content, createdAt),
      text: row.content, created_at: createdAt,
    });
  } catch (err) {
    console.error("[makes-capture] exploration capture failed (growth write kept)", { id: row.id, error: String(err) });
  }
}

// ── The verb ────────────────────────────────────────────────────────────────────

export const KEEP_VERB_RE = /^(?:please\s+)?keep\s+(?:(?:this|that|it)\s+)?as\s+made\b/i;
export const KEEP_TEACH = 'keep as made <id> | "opening words of it" [called <title>] [for <interest>] [because <why>]';

export interface ParsedKeepVerb {
  ref: { kind: "id"; id: string } | { kind: "words"; words: string } | { kind: "this" };
  title: string | null;
  title_before_for: string | null;
  interest_candidate: string | null;
  why: string;
}

export function parseKeepVerb(request: string): ParsedKeepVerb | null {
  const m = /^(?:please\s+)?keep\s+((?:this|that|it)\s+)?as\s+made\b\s*([\s\S]*)$/i.exec(request.trim());
  if (!m) return null;
  let rest = (m[2] ?? "").trim();
  let ref: ParsedKeepVerb["ref"] = { kind: "this" };
  const q = /^["“]([^"”]+)["”]\s*/.exec(rest);
  const idm = /^([0-9a-f][0-9a-f-]{7,})\b\s*/i.exec(rest);
  if (q) { ref = { kind: "words", words: q[1]! }; rest = rest.slice(q[0].length); }
  else if (idm) { ref = { kind: "id", id: idm[1]!.toLowerCase() }; rest = rest.slice(idm[0].length); }
  else if (!m[1] && rest && !/^(?:called|for|because)\b/i.test(rest)) {
    return { ref: { kind: "this" }, title: null, title_before_for: null, interest_candidate: null, why: "" };
  }
  let why = "";
  const b = rest.search(/\bbecause\b/i);
  if (b >= 0) { why = rest.slice(b).replace(/^because\b[\s,:]*/i, "").trim(); rest = rest.slice(0, b).trim(); }
  const hadCalled = /^called\s+/i.test(rest);
  let head = rest.replace(/^called\s+/i, "");
  let title: string | null = null;
  let titleBefore: string | null = null;
  let interest: string | null = null;
  if (!hadCalled && /^for\s+/i.test(head)) {
    interest = clean(head.replace(/^for\s+/i, "")) || null;
    head = "";
  } else if (head.trim()) {
    title = clean(head) || null;
    const forAt = head.search(/\s+for\s+(?!.*\s+for\s+)/i);
    if (forAt > 0) {
      const t = clean(head.slice(0, forAt));
      const i = clean(head.slice(forAt).replace(/^\s+for\s+/i, ""));
      if (t && i) { titleBefore = t; interest = i; }
    }
  }
  return { ref, title, title_before_for: titleBefore, interest_candidate: interest, why };
}

interface Found { table: "companion_journal" | "growth_journal" | "inter_companion_notes"; id: string; created_at: string }
const TABLE_LABEL: Record<Found["table"], string> = {
  companion_journal: "journal", growth_journal: "growth", inter_companion_notes: "note",
};

const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{7,}$/i;

/** Own rows whose id starts with the prefix, across the three tables. Prefix is hex/dash only (validated). */
async function findByIdPrefix(env: Env, companion: string, prefix: string): Promise<Found[]> {
  const p = `${prefix}%`;
  const [j, g, n] = await Promise.all([
    env.DB.prepare("SELECT id, created_at FROM companion_journal WHERE agent = ? AND id LIKE ? LIMIT 6").bind(companion, p).all<{ id: string; created_at: string }>(),
    env.DB.prepare("SELECT id, created_at FROM growth_journal WHERE companion_id = ? AND id LIKE ? LIMIT 6").bind(companion, p).all<{ id: string; created_at: string }>(),
    env.DB.prepare("SELECT id, created_at FROM inter_companion_notes WHERE from_id = ? AND id LIKE ? LIMIT 6").bind(companion, p).all<{ id: string; created_at: string }>(),
  ]);
  return [
    ...(j.results ?? []).map((r) => ({ table: "companion_journal" as const, ...r })),
    ...(g.results ?? []).map((r) => ({ table: "growth_journal" as const, ...r })),
    ...(n.results ?? []).map((r) => ({ table: "inter_companion_notes" as const, ...r })),
  ];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const WORDS_WINDOW_DAYS = 60;

/** Own rows from the last 60 days whose text STARTS with the words (case + whitespace normalised). */
async function findByOpeningWords(env: Env, companion: string, words: string, nowMs: number): Promise<Found[]> {
  const needle = norm(words);
  const since = sqliteTs(nowMs - WORDS_WINDOW_DAYS * 86_400_000).slice(0, 10); // date only: both timestamp shapes sort after it
  const win = Math.min(Math.max(needle.length * 2 + 40, 200), 800);
  const [j, g, n] = await Promise.all([
    env.DB.prepare("SELECT id, created_at, substr(note_text, 1, ?) AS t FROM companion_journal WHERE agent = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, companion, since).all<{ id: string; created_at: string; t: string }>(),
    env.DB.prepare("SELECT id, created_at, substr(content, 1, ?) AS t FROM growth_journal WHERE companion_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, companion, since).all<{ id: string; created_at: string; t: string }>(),
    env.DB.prepare("SELECT id, created_at, substr(content, 1, ?) AS t FROM inter_companion_notes WHERE from_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, companion, since).all<{ id: string; created_at: string; t: string }>(),
  ]);
  const hit = (rows: { id: string; created_at: string; t: string }[] | undefined, table: Found["table"]): Found[] =>
    (rows ?? []).filter((r) => norm(r.t ?? "").startsWith(needle)).map((r) => ({ table, id: r.id, created_at: r.created_at }));
  return [...hit(j.results, "companion_journal"), ...hit(g.results, "growth_journal"), ...hit(n.results, "inter_companion_notes")];
}

export type KeepResult =
  | { ok: true; outcome: "created" | "exists"; id: string; title: string }
  | { ok: false; code: string; message: string; candidates?: string[] };

export interface KeepInput {
  companion_id: string;
  ref: ParsedKeepVerb["ref"] | { kind: "id"; id: string };
  title?: string | null;
  interest_name?: string | null;
  why?: string | null;
}

export async function keepAsMade(env: Env, input: KeepInput, nowMs: number = Date.now()): Promise<KeepResult> {
  const companion = input.companion_id;
  const no = (code: string, message: string, candidates?: string[]): KeepResult => {
    logLine(companion, "-", null, "refused", code);
    return { ok: false, code, message, ...(candidates ? { candidates } : {}) };
  };
  if (companion === "gaia") return no("gaia_keeps_lines", "you keep lines, not artifacts; that was your word. Nothing was kept.");
  if (!(CAPTURE_COMPANIONS as readonly string[]).includes(companion)) return no("bad_companion", "only drevan and cypher keep makes");

  let found: Found[];
  if (input.ref.kind === "id") {
    if (!ID_PREFIX_RE.test(input.ref.id)) return no("bad_ref", "an id needs at least 8 hex characters");
    found = await findByIdPrefix(env, companion, input.ref.id);
  } else if (input.ref.kind === "words") {
    const n = norm(input.ref.words);
    if (n.split(" ").filter(Boolean).length < 4) return no("bad_ref", "quote at least 4 opening words");
    if (n.length > 300) return no("bad_ref", "quote fewer opening words (300 characters at most)");
    found = await findByOpeningWords(env, companion, input.ref.words, nowMs);
  } else {
    return no("bad_ref", `say which one. ${KEEP_TEACH}`);
  }
  if (found.length === 0) return no("not_found", "none of your own writing matches that (last 60 days for quoted words)");
  if (found.length > 1) {
    const cands = found.slice(0, 5).map((f) => `${TABLE_LABEL[f.table]} ${f.id.slice(0, 8)} ${normalizeCreatedAt(f.created_at).slice(0, 10)}`);
    return no("ambiguous", "more than one of your rows matches; name one by its id prefix", cands);
  }

  const f = found[0]!;
  let text = "";
  let origin = "";
  let title = (input.title ?? "").trim();
  if (f.table === "companion_journal") {
    const r = await env.DB.prepare("SELECT note_text, tags, review_state FROM companion_journal WHERE id = ? AND agent = ?")
      .bind(f.id, companion).first<{ note_text: string; tags: string | null; review_state: string | null }>();
    if (!r) return no("not_found", "none of your own writing matches that");
    const why = tagRefusal(r.tags);
    if (why) return no(why, "that row is private, machine-written or care material; it does not go on the shelf");
    text = r.note_text;
    const isLetter = parseTags(r.tags).includes("letter_to_raziel");
    origin = `${isLetter ? "letter" : "journal"}:${f.id}`;
    if (!title) title = isLetter ? letterTitle(f.created_at) : keptTitle(text, f.created_at);
  } else if (f.table === "growth_journal") {
    const r = await env.DB.prepare("SELECT content, tags_json FROM growth_journal WHERE id = ? AND companion_id = ?")
      .bind(f.id, companion).first<{ content: string; tags_json: string | null }>();
    if (!r) return no("not_found", "none of your own writing matches that");
    const why = tagRefusal(r.tags_json);
    if (why) return no(why, "that row is private, machine-written or care material; it does not go on the shelf");
    text = r.content;
    origin = `growth:${f.id}`;
    if (!title) title = explorationTitle(text, f.created_at);
  } else {
    const r = await env.DB.prepare("SELECT content FROM inter_companion_notes WHERE id = ? AND from_id = ?")
      .bind(f.id, companion).first<{ content: string }>();
    if (!r) return no("not_found", "none of your own writing matches that");
    text = r.content;
    origin = `note:${f.id}`;
    if (!title) title = keptTitle(text, f.created_at);
  }

  const res = await captureWriting(env, {
    companion_id: companion, origin, title, text, created_at: f.created_at,
    interest_name: input.interest_name ?? null, why: input.why ?? null,
  }, nowMs);
  if (!res.ok) return no(res.reason, `not kept: ${res.reason}`);
  return { ok: true, outcome: res.outcome, id: res.id, title };
}

/** Resolve the verb's `for <x>` the way `make a ... called` does: it is an interest only when it names one of the caller's own. */
export async function resolveKeepInterest(
  env: Env, companion: string, p: ParsedKeepVerb,
): Promise<{ title: string | null; interest: string | null }> {
  if (!p.interest_candidate) return { title: p.title, interest: null };
  const hit = await findInterestByName(env, companion, p.interest_candidate);
  if (hit && (hit.status === "active" || hit.status === "resting")) {
    return { title: p.title_before_for ?? (p.title && p.title.toLowerCase().startsWith("for ") ? null : p.title), interest: hit.name };
  }
  // Not one of theirs: with `called`, the whole thing was the title; bare `for <x>` is nothing.
  return { title: p.title, interest: null };
}
