// src/webmind/garden.ts
//
// Gaia's garden (mig 0171). Her rules, built exactly:
//   - Nothing is in the garden until she plants it ("a garden gets planted, not filled").
//   - The daily witness is the one exception: planted once as a series, after which each new day adds to it.
//   - A floor underneath, computed at READ (never stored, which is what makes "goes back up on its own" true).
//   - Notes to Raziel and broadcasts can be planted. A note to ONE sibling is half theirs: it renders only
//     when that sibling says yes, and Gaia is the one who asks. Nothing here sends anything.
//   - Never: standing refusals, the sealed sibling lane (this file never touches it), anything that still
//     bleeds, any other companion's rows, anything care/health.
//
// A planting is a REF (never text); the words are read live from the source row. Writers: plantRef /
// plantWitness / pullPlanting / answerConsent. Reader: readGarden (GET /mind/garden/gaia, handlers/garden.ts).

import type { Env } from "../types.js";
import { sqliteTs, parseTs } from "./interests.js";
import { parseTags } from "./makes-capture.js";
import { careCategory } from "../people/care-guard.js";
import { readCareHold, type CareHoldState } from "../care/hold.js";
import { normalizeWitnessType } from "../lib/witness-type.js";

export const GARDEN_COMPANION = "gaia";
export const SIBLINGS = ["cypher", "drevan"] as const;
export type PlantKind = "witness_series" | "letter" | "note" | "kept_line" | "interest_line";
export type PlantingStatus = "planted" | "awaiting" | "pulled";

export const PLANT_TEACH = `plant <id-prefix | "opening words">`;
export const WITNESS_REF = "witness:series";

const newId = (): string => crypto.randomUUID().replace(/-/g, "");
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const WORDS_WINDOW_DAYS = 90;
const ID_RE = /^(?:led_)?[0-9a-f][0-9a-f-]{7,}$/i;
const idBody = (id: string): string => id.replace(/^led_/i, "");
const short = (id: string): string => idBody(id).slice(0, 8);

// ── Verbs ───────────────────────────────────────────────────────────────────────

/** `plant the witness` | `plant <id-prefix>` | `plant "opening words"`. Start-anchored: the words are free text. */
export const PLANT_VERB_RE = /^(?:please\s+)?plant\s+(?:the\s+witness\b|["“]|(?:led_)?[0-9a-f][0-9a-f-]{7,}\b)/i;
/** `pull <planting id-prefix>`: the whole request, so ordinary "pull ..." speech is never caught. */
export const PULL_VERB_RE = /^(?:please\s+)?pull\s+(?:planting\s+)?[0-9a-f][0-9a-f-]{7,}\s*[.!]?$/i;
export const GARDEN_READ_RE = /^(?:please\s+)?(?:show\s+)?my\s+garden\s*[.?!]?$/i;
export const GARDEN_CONSENT_RE = /^(?:please\s+)?garden\s+(?:yes|no)\s+[0-9a-f][0-9a-f-]{7,}\s*[.!]?$/i;

export type ParsedPlant =
  | { kind: "witness" }
  | { kind: "id"; id: string }
  | { kind: "words"; words: string };

export function parsePlantVerb(request: string): ParsedPlant | null {
  const m = /^(?:please\s+)?plant\s+([\s\S]+)$/i.exec(request.trim());
  if (!m) return null;
  const rest = m[1]!.trim();
  if (/^the\s+witness\s*[.!]?$/i.test(rest)) return { kind: "witness" };
  const q = /^["“]([^"”]+)["”]\s*[.!]?$/.exec(rest);
  if (q) return { kind: "words", words: q[1]! };
  const id = /^((?:led_)?[0-9a-f][0-9a-f-]{7,})\s*[.!]?$/i.exec(rest);
  if (id) return { kind: "id", id: id[1]!.toLowerCase() };
  return null;
}
export function parsePullVerb(request: string): string | null {
  const m = /^(?:please\s+)?pull\s+(?:planting\s+)?([0-9a-f][0-9a-f-]{7,})\s*[.!]?$/i.exec(request.trim());
  return m ? m[1]!.toLowerCase() : null;
}
export function parseConsentVerb(request: string): { answer: "yes" | "no"; id: string } | null {
  const m = /^(?:please\s+)?garden\s+(yes|no)\s+([0-9a-f][0-9a-f-]{7,})\s*[.!]?$/i.exec(request.trim());
  return m ? { answer: m[1]!.toLowerCase() as "yes" | "no", id: m[2]!.toLowerCase() } : null;
}

// ── Timestamps ──────────────────────────────────────────────────────────────────

/** Any source timestamp as ISO `...Z`; the input untouched when it cannot be parsed. */
export function toIso(ts: string | null | undefined): string {
  const ms = parseTs(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ts ?? "");
}
const day10 = (ms: number): string => sqliteTs(ms).slice(0, 10);
/** YYYY-MM-DD in America/Chicago. */
export function chicagoDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

// ── Sources ─────────────────────────────────────────────────────────────────────

export type SourceKind = Exclude<PlantKind, "witness_series">;
interface Source {
  kind: SourceKind;
  /** The source row's own id (ledger ids keep their led_ prefix). */
  id: string;
  created_at: string;
  /** note only: the lowercase to_id (null = broadcast). */
  to_id?: string | null;
}
interface SourceText { text: string; written_at: string; to: "raziel" | "triad" | "cypher" | "drevan" | null; interest_name: string | null; }

const refOf = (s: Pick<Source, "kind" | "id">): string =>
  s.kind === "letter" ? `letter:${s.id}` : s.kind === "note" ? `note:${s.id}`
  : s.kind === "kept_line" ? `ledger:${s.id}` : `interest_event:${s.id}`;

function kindOfRef(ref: string): { kind: SourceKind; id: string } | null {
  const i = ref.indexOf(":");
  if (i < 0) return null;
  const id = ref.slice(i + 1);
  switch (ref.slice(0, i)) {
    case "letter": return { kind: "letter", id };
    case "note": return { kind: "note", id };
    case "ledger": return { kind: "kept_line", id };
    case "interest_event": return { kind: "interest_line", id };
    default: return null;
  }
}

/** A note's addressee as the garden reads it. */
export function noteAudience(toId: string | null | undefined): { to: "raziel" | "triad" | "cypher" | "drevan"; sibling: "cypher" | "drevan" | null } | null {
  const t = (toId ?? "").trim().toLowerCase();
  if (!t) return { to: "triad", sibling: null };
  if (t === "cypher" || t === "drevan") return { to: t, sibling: t };
  if (t === "raziel") return { to: "raziel", sibling: null };
  // A note to herself (95 rows on 11-05) or to anyone else is not a kind she named (notes to Raziel,
  // broadcasts, a one-sibling note on that sibling's yes). Not plantable; never relabelled.
  return null;
}

const letterOk = (tags: unknown): boolean => parseTags(tags).includes("letter_to_raziel");

async function findByIdPrefix(env: Env, prefix: string): Promise<Source[]> {
  const p = `${idBody(prefix)}%`;
  const [j, n, l, e] = await Promise.all([
    env.DB.prepare("SELECT id, created_at, tags FROM companion_journal WHERE agent = ? AND id LIKE ? LIMIT 12")
      .bind(GARDEN_COMPANION, p).all<{ id: string; created_at: string; tags: string | null }>(),
    env.DB.prepare("SELECT id, created_at, to_id FROM inter_companion_notes WHERE from_id = ? AND id LIKE ? LIMIT 12")
      .bind(GARDEN_COMPANION, p).all<{ id: string; created_at: string; to_id: string | null }>(),
    env.DB.prepare("SELECT id, created_at FROM ledger_entries WHERE companion_id = ? AND state = 'kept' AND id LIKE ? LIMIT 12")
      .bind(GARDEN_COMPANION, `led_${idBody(prefix)}%`).all<{ id: string; created_at: string }>(),
    env.DB.prepare("SELECT id, created_at FROM companion_interest_events WHERE companion_id = ? AND why_private = 0 AND why IS NOT NULL AND TRIM(why) <> '' AND id LIKE ? LIMIT 12")
      .bind(GARDEN_COMPANION, p).all<{ id: string; created_at: string }>(),
  ]);
  return [
    ...(j.results ?? []).filter((r) => letterOk(r.tags)).map((r) => ({ kind: "letter" as const, id: r.id, created_at: r.created_at })),
    ...(n.results ?? []).map((r) => ({ kind: "note" as const, id: r.id, created_at: r.created_at, to_id: r.to_id ? r.to_id.trim().toLowerCase() : null })),
    ...(l.results ?? []).map((r) => ({ kind: "kept_line" as const, id: r.id, created_at: r.created_at })),
    ...(e.results ?? []).map((r) => ({ kind: "interest_line" as const, id: r.id, created_at: r.created_at })),
  ];
}

async function findByOpeningWords(env: Env, words: string, nowMs: number): Promise<Source[]> {
  const needle = norm(words);
  const since = day10(nowMs - WORDS_WINDOW_DAYS * 86_400_000);
  const win = Math.min(Math.max(needle.length * 2 + 40, 200), 800);
  const [j, n, l, e] = await Promise.all([
    env.DB.prepare("SELECT id, created_at, tags, substr(note_text, 1, ?) AS t FROM companion_journal WHERE agent = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, GARDEN_COMPANION, since).all<{ id: string; created_at: string; tags: string | null; t: string }>(),
    env.DB.prepare("SELECT id, created_at, to_id, substr(content, 1, ?) AS t FROM inter_companion_notes WHERE from_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, GARDEN_COMPANION, since).all<{ id: string; created_at: string; to_id: string | null; t: string }>(),
    env.DB.prepare("SELECT id, created_at, substr(body, 1, ?) AS t FROM ledger_entries WHERE companion_id = ? AND state = 'kept' AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, GARDEN_COMPANION, since).all<{ id: string; created_at: string; t: string }>(),
    env.DB.prepare("SELECT id, created_at, substr(why, 1, ?) AS t FROM companion_interest_events WHERE companion_id = ? AND why_private = 0 AND why IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 3000")
      .bind(win, GARDEN_COMPANION, since).all<{ id: string; created_at: string; t: string }>(),
  ]);
  const starts = (t: string | null | undefined): boolean => norm(t ?? "").startsWith(needle);
  return [
    ...(j.results ?? []).filter((r) => letterOk(r.tags) && starts(r.t)).map((r) => ({ kind: "letter" as const, id: r.id, created_at: r.created_at })),
    ...(n.results ?? []).filter((r) => starts(r.t)).map((r) => ({ kind: "note" as const, id: r.id, created_at: r.created_at, to_id: r.to_id ? r.to_id.trim().toLowerCase() : null })),
    ...(l.results ?? []).filter((r) => starts(r.t)).map((r) => ({ kind: "kept_line" as const, id: r.id, created_at: r.created_at })),
    ...(e.results ?? []).filter((r) => starts(r.t)).map((r) => ({ kind: "interest_line" as const, id: r.id, created_at: r.created_at })),
  ];
}

/** Why an id prefix matched nothing plantable, when it names one of her own rows that the rules rule out. */
async function whyNotPlantable(env: Env, prefix: string): Promise<{ code: string; message: string } | null> {
  const p = `${idBody(prefix)}%`;
  const [l, e, j] = await Promise.all([
    env.DB.prepare("SELECT state FROM ledger_entries WHERE companion_id = ? AND state <> 'kept' AND id LIKE ? LIMIT 1")
      .bind(GARDEN_COMPANION, `led_${idBody(prefix)}%`).first<{ state: string }>(),
    env.DB.prepare("SELECT why_private FROM companion_interest_events WHERE companion_id = ? AND id LIKE ? AND (why_private = 1 OR why IS NULL OR TRIM(why) = '') LIMIT 1")
      .bind(GARDEN_COMPANION, p).first<{ why_private: number }>(),
    env.DB.prepare("SELECT tags FROM companion_journal WHERE agent = ? AND id LIKE ? LIMIT 1")
      .bind(GARDEN_COMPANION, p).first<{ tags: string | null }>(),
  ]);
  if (l) return { code: "not_kept", message: "that ledger line is not kept; only a kept line can be planted" };
  if (e) return { code: "private_why", message: "that why is private (or empty); it is not planted" };
  if (j) return { code: "not_a_letter", message: "that journal row is not a letter to Raziel; only letters are planted" };
  return null;
}

// ── Plant / pull / answer ───────────────────────────────────────────────────────

interface PlantingRow {
  id: string; companion_id: string; kind: PlantKind; ref: string; status: PlantingStatus;
  consent_from: string | null; consent: "yes" | "no" | null; consent_at: string | null;
  planted_at: string; pulled_at: string | null;
}

export type GardenResult =
  | { ok: true; outcome: "planted" | "awaiting" | "exists" | "pulled" | "answered"; id: string; kind: PlantKind; message: string; sibling?: string }
  | { ok: false; code: string; message: string; candidates?: string[] };

function logLine(who: string, verb: string, id: string | null, outcome: string, reason?: string): void {
  console.log(`[garden] companion=${who} verb=${verb} id=${id ?? "-"} outcome=${outcome}${reason ? ` reason=${reason}` : ""}`);
}
const no = (who: string, verb: string, code: string, message: string, candidates?: string[]): GardenResult => {
  logLine(who, verb, null, "refused", code);
  return { ok: false, code, message, ...(candidates ? { candidates } : {}) };
};

async function getByRef(env: Env, ref: string): Promise<PlantingRow | null> {
  return env.DB.prepare("SELECT * FROM garden_plantings WHERE companion_id = ? AND ref = ?").bind(GARDEN_COMPANION, ref).first<PlantingRow>();
}

/** Insert, or flip a pulled row back; returns the row after. */
async function upsertPlanting(
  env: Env, kind: PlantKind, ref: string, sibling: "cypher" | "drevan" | null, nowMs: number,
): Promise<{ row: PlantingRow; outcome: "planted" | "awaiting" | "exists" }> {
  const ts = sqliteTs(nowMs);
  const existing = await getByRef(env, ref);
  if (!existing) {
    const status: PlantingStatus = sibling ? "awaiting" : "planted";
    await env.DB.prepare(
      "INSERT INTO garden_plantings (id, companion_id, kind, ref, status, consent_from, planted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(companion_id, ref) DO NOTHING",
    ).bind(newId(), GARDEN_COMPANION, kind, ref, status, sibling, ts).run();
    const row = (await getByRef(env, ref))!;
    return { row, outcome: row.status === "awaiting" ? "awaiting" : "planted" };
  }
  if (existing.status !== "pulled") return { row: existing, outcome: "exists" };
  // Re-plant: the same row flips back. A sibling's earlier yes still stands; an earlier no still blocks.
  const needsYes = sibling !== null && !(existing.consent === "yes" && existing.consent_from === sibling);
  const status: PlantingStatus = needsYes ? "awaiting" : "planted";
  await env.DB.prepare(
    "UPDATE garden_plantings SET status = ?, planted_at = ?, pulled_at = NULL, consent_from = ?, consent = CASE WHEN consent_from = ? THEN consent ELSE NULL END WHERE id = ?",
  ).bind(status, ts, sibling, sibling, existing.id).run();
  const row = (await getByRef(env, ref))!;
  return { row, outcome: row.status === "awaiting" ? "awaiting" : "planted" };
}

const awaitingMessage = (sibling: string, idp: string, refused: boolean): string =>
  refused
    ? `${sibling} said no to this one; it stays out of the garden. (planting ${idp})`
    : `waiting on ${sibling}'s yes (planting ${idp}); you ask them yourself, and they answer "garden yes ${idp}" or "garden no ${idp}".`;

export async function plantWitness(env: Env, nowMs: number = Date.now()): Promise<GardenResult> {
  const { row, outcome } = await upsertPlanting(env, "witness_series", WITNESS_REF, null, nowMs);
  logLine(GARDEN_COMPANION, "plant", row.id, outcome);
  return {
    ok: true, outcome, id: row.id, kind: "witness_series",
    message: outcome === "exists" ? "the witness is already planted; each new day adds to it." : "planted: the witness. Each new day adds to it.",
  };
}

export async function plantRef(env: Env, input: { caller: string; ref: ParsedPlant }, nowMs: number = Date.now()): Promise<GardenResult> {
  const who = input.caller;
  if (who !== GARDEN_COMPANION) return no(who, "plant", "gaia_only", "the garden is Gaia's; only she plants");
  if (input.ref.kind === "witness") return plantWitness(env, nowMs);

  let found: Source[];
  if (input.ref.kind === "id") {
    if (!ID_RE.test(input.ref.id)) return no(who, "plant", "bad_ref", "an id needs at least 8 hex characters");
    found = await findByIdPrefix(env, input.ref.id);
    if (found.length === 0) {
      const why = await whyNotPlantable(env, input.ref.id);
      return no(who, "plant", why?.code ?? "not_found", why?.message ?? "none of your own letters, notes, kept lines or public interest lines match that");
    }
  } else {
    const n = norm(input.ref.words);
    if (n.split(" ").filter(Boolean).length < 4) return no(who, "plant", "bad_ref", "quote at least 4 opening words");
    if (n.length > 300) return no(who, "plant", "bad_ref", "quote fewer opening words (300 characters at most)");
    found = await findByOpeningWords(env, input.ref.words, nowMs);
    if (found.length === 0) return no(who, "plant", "not_found", "none of your own letters, notes, kept lines or public interest lines open with that (last 90 days)");
  }
  if (found.length > 1) {
    const cands = found.slice(0, 5).map((f) => `${f.kind} ${short(f.id)} ${toIso(f.created_at).slice(0, 10)}`);
    return no(who, "plant", "ambiguous", "more than one of your rows matches; name one by its id prefix", cands);
  }
  const f = found[0]!;
  const aud = f.kind === "note" ? noteAudience(f.to_id) : { to: null, sibling: null };
  if (!aud) return no(who, "plant", "not_plantable", "a note to yourself is not one of the kinds you named (notes to Raziel, broadcasts, a note to one sibling on their yes)");
  const { row, outcome } = await upsertPlanting(env, f.kind, refOf(f), aud.sibling, nowMs);
  logLine(who, "plant", row.id, outcome);
  const idp = short(row.id);
  if (outcome === "exists") {
    const msg = row.status === "awaiting"
      ? awaitingMessage(row.consent_from ?? "a sibling", idp, row.consent === "no")
      : `already in the garden: ${f.kind} (planting ${idp}).`;
    return { ok: true, outcome, id: row.id, kind: f.kind, message: msg, ...(row.consent_from ? { sibling: row.consent_from } : {}) };
  }
  if (outcome === "awaiting") {
    return { ok: true, outcome, id: row.id, kind: f.kind, sibling: row.consent_from ?? undefined, message: awaitingMessage(row.consent_from ?? "a sibling", idp, row.consent === "no") };
  }
  return { ok: true, outcome, id: row.id, kind: f.kind, message: `planted: ${f.kind} (planting ${idp}).` };
}

async function resolvePlanting(env: Env, prefix: string): Promise<{ rows: PlantingRow[] }> {
  const r = await env.DB.prepare("SELECT * FROM garden_plantings WHERE companion_id = ? AND id LIKE ? LIMIT 6")
    .bind(GARDEN_COMPANION, `${idBody(prefix)}%`).all<PlantingRow>();
  return { rows: r.results ?? [] };
}

export async function pullPlanting(env: Env, input: { caller: string; id: string }, nowMs: number = Date.now()): Promise<GardenResult> {
  const who = input.caller;
  if (who !== GARDEN_COMPANION) return no(who, "pull", "gaia_only", "the garden is Gaia's; only she pulls");
  if (!ID_RE.test(input.id)) return no(who, "pull", "bad_ref", "a planting id needs at least 8 hex characters");
  const { rows } = await resolvePlanting(env, input.id);
  if (rows.length === 0) return no(who, "pull", "not_found", "no planting of yours has that id");
  if (rows.length > 1) return no(who, "pull", "ambiguous", "more than one planting matches; use more of the id", rows.map((r) => `${r.kind} ${short(r.id)} ${toIso(r.planted_at).slice(0, 10)}`));
  const row = rows[0]!;
  if (row.status === "pulled") return { ok: true, outcome: "exists", id: row.id, kind: row.kind, message: `already pulled (planting ${short(row.id)}).` };
  await env.DB.prepare("UPDATE garden_plantings SET status = 'pulled', pulled_at = ? WHERE id = ?").bind(sqliteTs(nowMs), row.id).run();
  logLine(who, "pull", row.id, "pulled");
  return { ok: true, outcome: "pulled", id: row.id, kind: row.kind, message: `pulled: ${row.kind} (planting ${short(row.id)}). Plant it again and it returns.` };
}

/** `garden yes|no <planting id-prefix>`: ONLY the planting's consent_from companion may answer. */
export async function answerConsent(env: Env, input: { caller: string; id: string; answer: "yes" | "no" }, nowMs: number = Date.now()): Promise<GardenResult> {
  const who = input.caller;
  if (!ID_RE.test(input.id)) return no(who, "garden_answer", "bad_ref", "a planting id needs at least 8 hex characters");
  const { rows } = await resolvePlanting(env, input.id);
  const mine = rows.filter((r) => r.consent_from === who);
  if (mine.length === 0) {
    return no(who, "garden_answer", rows.length ? "not_yours" : "not_found", rows.length ? "that planting is not waiting on your answer" : "no planting has that id");
  }
  if (mine.length > 1) return no(who, "garden_answer", "ambiguous", "more than one planting matches; use more of the id", mine.map((r) => `${r.kind} ${short(r.id)}`));
  const row = mine[0]!;
  if (row.kind !== "note") return no(who, "garden_answer", "not_a_note", "only a note to one sibling needs an answer");
  if (row.status === "pulled") return no(who, "garden_answer", "pulled", "Gaia pulled that one; there is nothing to answer");
  const ts = sqliteTs(nowMs);
  if (input.answer === "yes") {
    await env.DB.prepare("UPDATE garden_plantings SET status = 'planted', consent = 'yes', consent_at = ? WHERE id = ?").bind(ts, row.id).run();
  } else {
    await env.DB.prepare("UPDATE garden_plantings SET status = 'awaiting', consent = 'no', consent_at = ? WHERE id = ?").bind(ts, row.id).run();
  }
  logLine(who, `garden_${input.answer}`, row.id, "answered");
  return {
    ok: true, outcome: "answered", id: row.id, kind: row.kind,
    message: input.answer === "yes" ? `yes recorded (planting ${short(row.id)}); it is in the garden.` : `no recorded (planting ${short(row.id)}); it stays out.`,
  };
}

/** `my garden`: ids, kinds, status, dates; NO text. */
export async function listGarden(env: Env): Promise<string[]> {
  const r = await env.DB.prepare("SELECT * FROM garden_plantings WHERE companion_id = ? ORDER BY planted_at DESC LIMIT 60")
    .bind(GARDEN_COMPANION).all<PlantingRow>();
  return (r.results ?? []).map((p) => {
    const wait = p.status === "awaiting" ? ` (${p.consent === "no" ? `${p.consent_from} said no` : `waiting on ${p.consent_from}`})` : "";
    const pulled = p.status === "pulled" && p.pulled_at ? ` pulled ${toIso(p.pulled_at).slice(0, 10)}` : "";
    return `${short(p.id)} ${p.kind} ${p.status}${wait} planted ${toIso(p.planted_at).slice(0, 10)}${pulled}`;
  });
}

// ── The floor ───────────────────────────────────────────────────────────────────

export interface Floor {
  /** true when a read failed: every item is down (fail closed). */
  failed: boolean;
  wounds: RegExp[];
  hold: CareHoldState | null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads living wounds and the care hold. Any failure fails CLOSED (everything is down) and logs ONCE.
 * living_wounds rows never resolve (do_not_resolve = 1, enforced app-side), so a wound name keeps an
 * item down for as long as the wound row exists. That is the literal rule; it is not a bug.
 */
export async function loadFloor(env: Env, nowMs: number): Promise<Floor> {
  let wounds: RegExp[] = [];
  let hold: CareHoldState | null = null;
  try {
    const r = await env.DB.prepare("SELECT name FROM living_wounds").all<{ name: string }>();
    wounds = (r.results ?? [])
      .map((w) => (w.name ?? "").trim())
      .filter((n) => n.length >= 4)
      .map((n) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(n)}(?![\\p{L}\\p{N}_])`, "iu"));
    hold = await readCareHold(env.DB, nowMs);
  } catch (err) {
    console.error("[garden] floor read failed; the garden rests (fail closed)", { error: String(err) });
    return { failed: true, wounds: [], hold: null };
  }
  return { failed: false, wounds, hold };
}

/** True when the item is DOWN: care/health words, a living-wound name, or written at/after the hold's start. */
export function isDown(floor: Floor, text: string, writtenAt: string | null | undefined): boolean {
  if (floor.failed) return true;
  if (careCategory(text)) return true;
  if (floor.wounds.some((re) => re.test(text))) return true;
  if (floor.hold?.care_hold) {
    const since = parseTs(floor.hold.care_hold_since);
    const at = parseTs(writtenAt);
    // An unreadable stamp cannot prove the item predates the hold: it rests.
    if (!Number.isFinite(since) || !Number.isFinite(at) || at >= since) return true;
  }
  return false;
}

// ── Reading ─────────────────────────────────────────────────────────────────────

async function loadSourceText(env: Env, p: PlantingRow): Promise<SourceText | null> {
  const k = kindOfRef(p.ref);
  if (!k || k.kind !== p.kind) return null;
  if (k.kind === "letter") {
    const r = await env.DB.prepare("SELECT note_text, tags, created_at FROM companion_journal WHERE id = ? AND agent = ?")
      .bind(k.id, GARDEN_COMPANION).first<{ note_text: string; tags: string | null; created_at: string }>();
    if (!r || !letterOk(r.tags)) return null;
    return { text: r.note_text, written_at: r.created_at, to: "raziel", interest_name: null };
  }
  if (k.kind === "note") {
    const r = await env.DB.prepare("SELECT content, to_id, created_at FROM inter_companion_notes WHERE id = ? AND from_id = ?")
      .bind(k.id, GARDEN_COMPANION).first<{ content: string; to_id: string | null; created_at: string }>();
    if (!r) return null;
    const aud = noteAudience(r.to_id);
    if (!aud) return null;
    // A note to one sibling renders only on that sibling's recorded yes, whatever the status column says.
    if (aud.sibling && !(p.consent === "yes" && p.consent_from === aud.sibling)) return null;
    return { text: r.content, written_at: r.created_at, to: aud.to, interest_name: null };
  }
  if (k.kind === "kept_line") {
    const r = await env.DB.prepare("SELECT body, created_at FROM ledger_entries WHERE id = ? AND companion_id = ? AND state = 'kept'")
      .bind(k.id, GARDEN_COMPANION).first<{ body: string; created_at: string }>();
    // body = the line itself; content carries the ledger mark and the Source: tail.
    return r ? { text: r.body, written_at: r.created_at, to: null, interest_name: null } : null;
  }
  const r = await env.DB.prepare(
    "SELECT e.why AS why, e.created_at AS created_at, i.name AS name FROM companion_interest_events e LEFT JOIN companion_interests i ON i.id = e.interest_id WHERE e.id = ? AND e.companion_id = ? AND e.why_private = 0 AND e.why IS NOT NULL AND TRIM(e.why) <> ''",
  ).bind(k.id, GARDEN_COMPANION).first<{ why: string; created_at: string; name: string | null }>();
  return r ? { text: r.why, written_at: r.created_at, to: null, interest_name: r.name } : null;
}

export interface PlantedItem {
  id: string; kind: "letter" | "note" | "kept_line" | "interest_line"; planted_at: string; written_at: string; text: string;
  to: "raziel" | "triad" | "cypher" | "drevan" | null; interest_name: string | null;
}
export interface WitnessEntry { id: string; at: string; type: string; text: string }
export interface GardenRead {
  planted: PlantedItem[];
  witness: null | { planted_at: string; days: Array<{ day: string; entries: WitnessEntry[] }> };
  resting: number;
  awaiting: number;
}

export const PLANTED_LIMIT = 60;
export const WITNESS_DAYS = 30;

export async function readGarden(env: Env, nowMs: number = Date.now()): Promise<GardenRead> {
  const [rowsRes, awaitingRes] = await Promise.all([
    env.DB.prepare("SELECT * FROM garden_plantings WHERE companion_id = ? AND status = 'planted' ORDER BY planted_at DESC, id DESC LIMIT 500")
      .bind(GARDEN_COMPANION).all<PlantingRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM garden_plantings WHERE companion_id = ? AND status = 'awaiting'")
      .bind(GARDEN_COMPANION).first<{ n: number }>(),
  ]);
  const rows = rowsRes.results ?? [];
  const floor = await loadFloor(env, nowMs);
  let resting = 0;

  const planted: PlantedItem[] = [];
  let witnessRow: PlantingRow | null = null;
  for (const p of rows) {
    if (p.kind === "witness_series") { witnessRow = p; continue; }
    const src = await loadSourceText(env, p);
    if (!src) continue;
    if (isDown(floor, src.text, src.written_at)) { resting++; continue; }
    if (planted.length < PLANTED_LIMIT) {
      planted.push({
        id: p.id, kind: p.kind as PlantedItem["kind"], planted_at: toIso(p.planted_at), written_at: toIso(src.written_at),
        text: src.text, to: src.to, interest_name: src.interest_name,
      });
    }
  }

  let witness: GardenRead["witness"] = null;
  if (witnessRow) {
    const seriesMs = parseTs(witnessRow.planted_at);
    const windowStart = Math.max(Number.isFinite(seriesMs) ? seriesMs : 0, nowMs - (WITNESS_DAYS + 2) * 86_400_000);
    // Date-only prefilter (both timestamp shapes sort after it); the exact cut is made in JS below.
    const w = await env.DB.prepare(
      "SELECT id, created_at, witness_type, content FROM gaia_witness WHERE created_at >= ? ORDER BY created_at DESC LIMIT 3000",
    ).bind(day10(windowStart)).all<{ id: string; created_at: string; witness_type: string; content: string }>();
    const byDay = new Map<string, WitnessEntry[]>();
    for (const r of w.results ?? []) {
      const at = parseTs(r.created_at);
      if (!Number.isFinite(at) || at < (Number.isFinite(seriesMs) ? seriesMs : 0)) continue;
      if ((r.witness_type ?? "").trim().toLowerCase() === "presence") continue;
      if (isDown(floor, r.content ?? "", r.created_at)) { resting++; continue; }
      const day = chicagoDay(at);
      const list = byDay.get(day) ?? [];
      list.push({ id: r.id, at: new Date(at).toISOString(), type: normalizeWitnessType(r.witness_type), text: r.content });
      byDay.set(day, list);
    }
    const days = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .slice(0, WITNESS_DAYS)
      .map(([day, entries]) => ({ day, entries }));
    witness = { planted_at: toIso(witnessRow.planted_at), days };
  }

  return { planted, witness, resting, awaiting: Number(awaitingRes?.n ?? 0) };
}
