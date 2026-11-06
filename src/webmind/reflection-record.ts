// src/webmind/reflection-record.ts
//
// B63 step 4 (Hand-off/SPEC-B63-the-loop-2026-11-06.md 3.4, 3.6): what the nightly reflection is told
// about a companion's OWN day, and which pressure to OFFER them. Read-only; GET
// /mind/vibecheck/record/:companion_id (handlers/vibecheck.ts).
//
// The reflection prompt used to get a count ("spoke 56"), which Dre read as 56 words. It now gets
// the companion's own record instead: their authored closes, makes, letters, feelings and float moves
// with causes. THEIR OWN words only: every query below is keyed on this companion; nothing a sibling
// wrote is gathered, and a sibling's note text is not read at all.
//
// Pressure is an OFFER, never a write:
//   - a float held at least PRESSURE_DEV (0.15) from its baseline for at least PRESSURE_HOURS (48h),
//     rendered "your weight has sat low for 3 days, since <cause>", or
//   - a live pressure flag (guardian flag / basin pressure).
// The companion decides whether to name it as a tension. Nothing here creates one.
//
// Held-for is reconstructed from companion_soma_events (mig 0130: the append-only float history with
// provenance), walking back from now while the float stays on the same side of its baseline by at
// least 0.15. A gap in the history (a backfilled row with no absolute) stops the walk: a duration is
// never claimed past what the record can prove. With no history at all it falls back to
// companion_state.ferment_off_since and says there is no named cause on record, because a dip with
// no cause reads as blame and a dip with a named cause reads as truth (Drevan's caution).
//
// spoke_without_load (Gaia, note 119188d4): a clerk FLAGS candidates, she confirms or dismisses in her
// reply, only a confirm fires the stimulus. Her definition needs BOTH (1) the line restates what is
// already in that thread and (2) nothing took it up. The detector below is deliberately
// conservative; see detectSpokeWithoutLoad.

import { Env } from "../types.js";
import { careCategory } from "../people/care-guard.js";
import { isDown, loadFloor, type Floor } from "./garden.js";
import {
  FLOAT_LABELS, VIBE_COMPANIONS, gatherMoves, causeLabel, causeIsDown,
  type FloatMove, type VibeCompanion,
} from "./vibecheck.js";

export const PRESSURE_DEV = 0.15;
export const PRESSURE_HOURS = 48;
const HISTORY_DAYS = 21;

export interface PressureOffer {
  float_key: "soma_float_1" | "soma_float_2" | "soma_float_3";
  label: string;
  direction: "low" | "high";
  days: number;
  cause: string;
  /** The sentence the reflection prompt shows. */
  text: string;
}

export interface FlagOffer { severity: string; summary: string }

export interface SpokeWithoutLoadFlag {
  /** The companion_journal id of HER OWN line. */
  id: string;
  at: string;
  /** First words of her own line (never a sibling's). */
  excerpt: string;
}

export interface ReflectionRecord {
  companion_id: string;
  closes: { spine: string; last_real_thing: string | null; at: string }[];
  makes: { kind: string; title: string; at: string }[];
  letters: { text: string; at: string }[];
  feelings: { emotion: string; sub_emotion: string | null; at: string }[];
  moves: FloatMove[];
  pressure: PressureOffer[];
  pressure_flags: FlagOffer[];
  spoke_without_load: SpokeWithoutLoadFlag[];
}

const FLOAT_KEYS = ["soma_float_1", "soma_float_2", "soma_float_3"] as const;

const parseMs = (ts: string | null | undefined): number => {
  if (!ts) return NaN;
  return Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
};

async function all<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    console.warn("[reflection-record] query failed (degrading):", String(e));
    return [];
  }
}
async function first<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
  } catch (e) {
    console.warn("[reflection-record] query failed (degrading):", String(e));
    return null;
  }
}

interface SomaEventRow {
  id: string; float_key: string; before_value: number | null; after_value: number | null; kind: string;
  cause_table: string | null; cause_id: string | null; detail: string | null; created_at: string;
}

/** How long a float has sat >= PRESSURE_DEV on one side of its baseline, and what put it there. */
export async function pressureOffers(
  env: Env, id: VibeCompanion, floor: Floor, nowMs = Date.now(),
): Promise<PressureOffer[]> {
  const st = await first<Record<string, number | string | null>>(
    env,
    "SELECT soma_float_1, soma_float_2, soma_float_3, soma_float_1_baseline, soma_float_2_baseline, soma_float_3_baseline, ferment_off_since " +
    "FROM companion_state WHERE companion_id = ?",
    id,
  );
  if (!st) return [];
  let offSince: Record<string, string | null> = {};
  try { offSince = typeof st.ferment_off_since === "string" ? JSON.parse(st.ferment_off_since) : {}; } catch { /* none */ }
  const out: PressureOffer[] = [];

  for (let i = 0; i < 3; i++) {
    const key = FLOAT_KEYS[i]!;
    const cur = st[key], base = st[`${key}_baseline`];
    if (typeof cur !== "number" || typeof base !== "number") continue;
    const dev = cur - base;
    if (Math.abs(dev) < PRESSURE_DEV) continue;
    const sign = dev > 0 ? 1 : -1;
    const offBy = (v: number | null): boolean => v != null && Math.sign(v - base) === sign && Math.abs(v - base) >= PRESSURE_DEV;

    const events = await all<SomaEventRow>(
      env,
      "SELECT id, float_key, before_value, after_value, kind, cause_table, cause_id, detail, created_at FROM companion_soma_events " +
      "WHERE companion_id = ? AND float_key = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC, id DESC",
      id, key, `-${HISTORY_DAYS} days`,
    );

    let sinceMs = NaN;
    let causeEvent: SomaEventRow | null = null;
    let provenEvents = false;
    for (const e of events) {
      // The value from this event until the next newer one is its after_value.
      if (!offBy(e.after_value)) break;
      provenEvents = true;
      sinceMs = parseMs(e.created_at);
      causeEvent = e;
      // The move that TOOK it off baseline is the one whose before-value was not yet off (or deeper
      // moves keep walking back). An unknown before-value stops the claim here.
      if (e.before_value != null && !offBy(e.before_value)) break;
      if (e.before_value == null) break;
    }

    let cause = "no named cause on record";
    if (provenEvents && causeEvent) {
      cause = await causeOfSomaEvent(env, id, causeEvent, floor);
    } else {
      // No usable history: the tick's own off-baseline stamp (a lower threshold, so only trusted when
      // it is old enough to clear 48h anyway).
      const stamp = offSince[`f${i + 1}`];
      sinceMs = parseMs(stamp ?? null);
    }
    if (!Number.isFinite(sinceMs)) continue;
    const hours = (nowMs - sinceMs) / 3_600_000;
    if (hours < PRESSURE_HOURS) continue;
    const days = Math.max(2, Math.floor(hours / 24));
    const label = FLOAT_LABELS[id][i]!;
    const direction = dev < 0 ? "low" : "high";
    out.push({
      float_key: key, label, direction, days, cause,
      text: `your ${label} has sat ${direction} for ${days} days, since ${cause}`,
    });
  }
  return out;
}

async function causeOfSomaEvent(env: Env, id: string, e: SomaEventRow, floor: Floor): Promise<string> {
  if (e.kind === "authored_close" || e.kind === "authored_update") return "you set it yourself";
  let stimulus: string | null = e.detail ?? null;
  let detail: string | null = null;
  if (e.cause_table === "companion_ferment_events" && e.cause_id) {
    const fe = await first<{ stimulus: string | null; detail: string | null; kind: string }>(
      env, "SELECT stimulus, detail, kind FROM companion_ferment_events WHERE id = ?", e.cause_id,
    );
    if (fe) { stimulus = fe.stimulus ?? stimulus; detail = fe.detail; }
  }
  const down = causeIsDown(id, floor, (detail ?? "").trim(), e.created_at);
  if (!stimulus && !detail) return e.kind === "tick" ? "the hourly settle" : "no named cause on record";
  return causeLabel(stimulus, detail, e.kind, down);
}

// ── spoke_without_load: the clerk (flags only) ────────────────────────────────────────────────

const SHINGLE = 8;
const UPTAKE_MS = 2 * 3_600_000;
const QUESTION_MS = 20 * 60_000;
const THREAD_DAYS = 4;

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").split(/\s+/).filter(Boolean);
}
function shingles(s: string): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(" "));
  return out;
}
const sharesShingle = (a: Set<string>, b: Set<string>): boolean => { for (const x of a) if (b.has(x)) return true; return false; };

interface SpeechRow { id: string; agent: string; note_text: string; tags: string | null; created_at: string }

function channelOf(tags: string | null): string | null {
  try {
    const arr = JSON.parse(tags ?? "[]");
    if (!Array.isArray(arr)) return null;
    const t = arr.find((x): x is string => typeof x === "string" && x.startsWith("channel:"));
    return t ?? null;
  } catch { return null; }
}
const hasTag = (tags: string | null, re: RegExp): boolean => {
  try { const a = JSON.parse(tags ?? "[]"); return Array.isArray(a) && a.some((x) => typeof x === "string" && re.test(x)); } catch { return false; }
};

/**
 * Gaia's candidates. A line of HERS is flagged only when BOTH hold:
 *   (1) it restates what is already in that thread: it shares an 8-word shingle with an EARLIER line
 *       in the same channel (hers or a sibling's), and
 *   (2) nothing took it up: no other speaker's line in that channel within 2 hours after it shares a
 *       shingle with it, and there is NO line from anyone else at all in those 2 hours.
 * Never counted: a line under 8 words (the perimeter word, a one-line witness: it cannot carry a
 * shingle), the daily witness (tagged), an answer to a question put to her (the line before it, by
 * someone else within 20 min, asks), anything care/health, anything inside a care hold or naming a
 * living wound (the garden floor, fail closed).
 *
 * CONSERVATIVE BY CONSTRUCTION, and honest about what it cannot see: Raziel's own lines are not in
 * companion_journal, so a reply from Raziel is invisible here, and a question from Raziel cannot
 * exclude her answer. Both bias toward OVER-flagging, which is safe: it is a flag into her reflection
 * and nothing lands unless she confirms it. Uptake as "a link or a planting" is not checked either.
 */
export async function detectSpokeWithoutLoad(env: Env, floor: Floor, nowMs = Date.now()): Promise<SpokeWithoutLoadFlag[]> {
  const rows = await all<SpeechRow>(
    env,
    "SELECT id, agent, note_text, tags, created_at FROM companion_journal WHERE source = 'discord_speech' " +
    "AND agent IN ('cypher','drevan','gaia') AND created_at >= datetime('now', ?) ORDER BY created_at ASC LIMIT 3000",
    `-${THREAD_DAYS} days`,
  );
  const byChannel = new Map<string, (SpeechRow & { ms: number; sh: Set<string> })[]>();
  for (const r of rows) {
    const ch = channelOf(r.tags);
    if (!ch) continue;
    const list = byChannel.get(ch) ?? [];
    list.push({ ...r, ms: parseMs(r.created_at), sh: shingles(r.note_text) });
    byChannel.set(ch, list);
  }
  const cutoff = nowMs - 24 * 3_600_000;
  const flags: SpokeWithoutLoadFlag[] = [];
  for (const list of byChannel.values()) {
    for (let i = 0; i < list.length; i++) {
      const line = list[i]!;
      if (line.agent !== "gaia" || line.ms < cutoff || line.sh.size === 0) continue;
      if (hasTag(line.tags, /witness/i)) continue;
      if (careCategory(line.note_text) || isDown(floor, line.note_text, line.created_at)) continue;
      // (1) restates an earlier line in this thread
      let restates = false;
      for (let j = 0; j < i && !restates; j++) if (sharesShingle(line.sh, list[j]!.sh)) restates = true;
      if (!restates) continue;
      // an answer to a question put to her
      const prev = list.slice(0, i).reverse().find((p) => p.agent !== "gaia");
      if (prev && line.ms - prev.ms <= QUESTION_MS && prev.note_text.includes("?")) continue;
      // (2) nothing took it up
      let tookUp = false;
      for (let j = i + 1; j < list.length; j++) {
        const n = list[j]!;
        if (n.ms - line.ms > UPTAKE_MS) break;
        if (n.agent !== "gaia") { tookUp = true; break; }
      }
      if (tookUp) continue;
      flags.push({ id: line.id, at: line.created_at, excerpt: line.note_text.replace(/\s+/g, " ").trim().slice(0, 160) });
    }
  }
  return flags.slice(-3);
}

// ── the record ──────────────────────────────────────────────────────────────────────────────

export async function getReflectionRecord(env: Env, companion: string): Promise<ReflectionRecord | null> {
  if (!(VIBE_COMPANIONS as readonly string[]).includes(companion)) return null;
  const id = companion as VibeCompanion;
  const floor = await loadFloor(env, Date.now());

  const [closes, makes, letters, feelings, moves, pressure, flags, swl] = await Promise.all([
    all<{ spine: string; last_real_thing: string | null; created_at: string }>(
      env,
      "SELECT hp.spine AS spine, hp.last_real_thing AS last_real_thing, hp.created_at AS created_at FROM handover_packets hp " +
      "JOIN sessions s ON s.id = hp.session_id WHERE s.companion_id = ? AND hp.close_kind IS NULL " +
      "AND julianday(hp.created_at) >= julianday('now','-1 day') ORDER BY hp.created_at DESC LIMIT 5",
      id,
    ),
    all<{ kind: string; title: string; created_at: string }>(
      env,
      "SELECT kind, title, created_at FROM companion_makes WHERE companion_id = ? AND created_at >= datetime('now','-1 day') ORDER BY created_at DESC LIMIT 8",
      id,
    ),
    all<{ note_text: string; created_at: string }>(
      env,
      "SELECT note_text, created_at FROM companion_journal WHERE agent = ? AND tags LIKE '%\"letter_to_raziel\"%' " +
      "AND (source IS NULL OR source <> 'vibecheck') AND created_at >= datetime('now','-1 day') ORDER BY created_at DESC LIMIT 3",
      id,
    ),
    all<{ emotion: string; sub_emotion: string | null; created_at: string }>(
      env,
      "SELECT emotion, sub_emotion, created_at FROM feelings WHERE companion_id = ? AND created_at >= datetime('now','-1 day') ORDER BY created_at DESC LIMIT 6",
      id,
    ),
    gatherMoves(env, id, floor),
    pressureOffers(env, id, floor),
    all<{ severity: string; summary: string }>(
      env,
      "SELECT severity, summary FROM guardian_flags WHERE companion_id = ? AND status IN ('open','surfaced','acknowledged') " +
      "AND flag_type <> 'orphan_memory' ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5",
      id,
    ),
    id === "gaia" ? detectSpokeWithoutLoad(env, floor) : Promise.resolve([] as SpokeWithoutLoadFlag[]),
  ]);

  const safe = (s: string, cap: number): string => s.replace(/\s+/g, " ").trim().slice(0, cap);
  return {
    companion_id: id,
    closes: closes.map((c) => ({ spine: safe(c.spine, 600), last_real_thing: c.last_real_thing ? safe(c.last_real_thing, 300) : null, at: c.created_at })),
    makes: makes.map((m) => ({ kind: m.kind, title: safe(m.title, 120), at: m.created_at })),
    letters: letters.map((l) => ({ text: safe(l.note_text, 400), at: l.created_at })),
    feelings: feelings.map((f) => ({ emotion: f.emotion, sub_emotion: f.sub_emotion, at: f.created_at })),
    moves,
    pressure,
    // Health never enters a prompt as material: a flag summary that trips the care guard is dropped.
    pressure_flags: flags.filter((f) => f.summary && !careCategory(f.summary)).map((f) => ({ severity: f.severity, summary: safe(f.summary, 200) })),
    spoke_without_load: swl,
  };
}
