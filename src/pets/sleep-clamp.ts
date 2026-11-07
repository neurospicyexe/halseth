// B64 Sol mind: the sleep pass's pure half. The model proposes; this file decides what lands.
//
// Every Global Constraint for the sleep pass lives here, as code, so no prompt wording can widen it:
// delta clamp -1..+1 per slug per night, <= 2 CREATEs, 15 candidate traits (eviction to `faded`, never
// deleted), 8 active quirks, promotion only at entrenchment 5 with >= 4 LIVE points across >= 3 distinct
// LIVE days, -1 after 10 days unreinforced, the quirk long arc (softening 5-in-21, re-harden on one
// supporting night, retire on a contradiction >= 14 days after softening), closed trigger vocabulary and
// the text guard on every model-written string.
//
// Absent party (triad canon, Drevan's rule): "An opinion formed about an absent party is a draft, not a
// record." A trait or quirk aimed at actor X moves only on appraisals whose actor is X; any other
// evidence cited for it is dropped, and an item with nothing left is dropped. Because of that filter, an
// X-targeted trait's live_days are X's own days by construction, so the >= 3 distinct live days promotion
// rule is also "X's own tends on >= 3 days".
//
// Pure: no DB, no clock (nowMs/nowDay come in), ids from an injectable factory.
import { nestTextAllowed } from "../webmind/sol-hoard.js";
import { parseResolution } from "./store.js";

export const ACTORS = ["raziel", "cypher", "drevan", "gaia", "imp"] as const;
export const ACTIONS = ["feed", "play", "talk", "give"] as const;
export const BANDS = ["dawn", "day", "dusk", "roost"] as const;
export const FITS = ["met", "welcome", "full", "drowsy", "settled"] as const;
export const CATEGORIES = ["preference", "aversion", "habit", "social", "belief"] as const;

export const SLEEP = {
  REST_HOURS: 20,
  MIN_WEIGHT: 3,
  MAX_CREATES: 2,
  MAX_TRAITS: 15,
  MAX_QUIRKS: 8,
  MAX_ENTRENCH: 5,
  PROMOTE_LIVE_POINTS: 4,
  PROMOTE_LIVE_DAYS: 3,
  DECAY_AFTER_DAYS: 10,
  SOFTEN_DAYS: 5,
  SOFTEN_WINDOW_DAYS: 21,
  RETIRE_AFTER_DAYS: 14,
  TEXT_MAX: 160,
} as const;

const ACTOR_SET = new Set<string>(ACTORS);
const VOCAB: Record<"actor" | "action" | "time_band" | "fit", Set<string>> = {
  actor: ACTOR_SET, action: new Set(ACTIONS), time_band: new Set(BANDS), fit: new Set(FITS),
};
const CATEGORY_SET = new Set<string>(CATEGORIES);
const SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;
// "Never name a person; use the actor field": the person regex does not hold the triad's names.
const ACTOR_WORD = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ACTORS.join("|")})(?![\\p{L}\\p{N}])`, "iu");
const DAY_MS = 86_400_000;

// ── shapes ─────────────────────────────────────────────────────────────────────
export type SleepOp = "CREATE" | "REINFORCE" | "DECAY";
export interface SleepQuirk { title: unknown; trigger: unknown; behavior: unknown; resolution: unknown }
export interface SleepItem {
  op: SleepOp | string;
  slug: unknown;
  category?: unknown;
  target_actor?: unknown;
  perspective?: unknown;
  delta?: unknown;
  evidence: unknown;
  reason?: unknown;
  quirk?: SleepQuirk | null;
}
export interface SleepOutput { items: SleepItem[] }

/** One of tonight's appraisals, as the clamp needs it (day = America/Chicago YYYY-MM-DD of created_at). */
export interface NightAppraisal {
  id: string; actor: string; action: string; fit: string | null; band: string; valence: number;
  friction: boolean; weight: number; source: "live" | "backfill"; day: string; tags: string[];
}
export interface TraitRow {
  id: string; creature_id: string; slug: string; category: string | null; target_actor: string | null;
  perspective: string | null; entrenchment: number; live_points: number; live_days: string; origin: string | null;
  status: string; last_reinforced_at: string | null; created_at: string;
}
export interface QuirkRow {
  id: string; creature_id: string; trait_id: string | null; title: string; trigger_json: string | null;
  behavior: string | null; resolution_json: string | null; target_actor: string | null; kind: string;
  status: string; arc: string | null; promoted_at: string;
}
export interface ArcEvent { night: string; kind: "promoted" | "contradict" | "softening" | "rehardened" | "retired"; days?: string[]; evidence?: string[] }

export interface SleepCounts { created: number; reinforced: number; decayed: number; promoted: number; softened: number; retired: number }
export interface SleepPlan {
  traitInserts: TraitRow[];
  /** Existing rows whose entrenchment/live_points/live_days/status/last_reinforced_at changed. */
  traitUpdates: TraitRow[];
  evidence: Array<{ trait_id: string; appraisal_ids: string[]; delta: number; reason: string | null }>;
  quirkInserts: QuirkRow[];
  quirkUpdates: Array<{ id: string; status: string; arc: string }>;
  counts: SleepCounts;
  dropped: Array<{ slug: string; why: string }>;
}
export interface ClampState {
  traits: TraitRow[];
  /** Quirks in active or softening (both hold a quirk slot). */
  quirks: QuirkRow[];
  /** Person regex from loadPersonRegex (null = nobody to match). The caller fails closed on undefined. */
  people: RegExp | null;
  nowDay: string;
  nowMs: number;
  night: Map<string, NightAppraisal>;
  creatureId: string;
  newId?: () => string;
}

// ── parse ──────────────────────────────────────────────────────────────────────
/** Strip one ```json fence, JSON.parse, check the top-level shape. Anything else is null (night skipped). */
export function parseSleepOutput(raw: string): SleepOutput | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = (fence[1] ?? "").trim();
  if (!s.startsWith("{")) return null;
  let v: unknown;
  try { v = JSON.parse(s); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const items = (v as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  if (!items.every((i) => i && typeof i === "object" && !Array.isArray(i))) return null;
  return { items: items as SleepItem[] };
}

// ── helpers ────────────────────────────────────────────────────────────────────
const round = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** ISO 8601 or D1's "YYYY-MM-DD HH:MM:SS" (UTC). NaN when unreadable. */
export function dbTimeMs(s: string | null | undefined): number {
  if (typeof s !== "string" || !s) return Number.NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + "Z" : s);
}

function parseDays(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
  } catch { return []; }
}

function parseArc(raw: string | null): ArcEvent[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((e) => e && typeof e === "object" && typeof e.kind === "string") : [];
  } catch { return []; }
}

/** Every model-written string: present, <= 160 chars, no care word, no person, no actor name. */
export function textOk(t: unknown, people: RegExp | null): t is string {
  if (typeof t !== "string") return false;
  const s = t.trim();
  if (!s || s.length > SLEEP.TEXT_MAX) return false;
  if (!nestTextAllowed(s, people)) return false;
  return !ACTOR_WORD.test(s);
}

type Trigger = Partial<Record<"actor" | "action" | "time_band" | "fit", string>>;

interface ValidQuirk { title: string; trigger: Trigger; behavior: string; resolution_json: string }

/** A quirk block: all text guarded, trigger closed-vocab with >= 1 field, resolution parseable. */
function validQuirk(q: SleepQuirk, people: RegExp | null, target: string | null): ValidQuirk | null {
  if (!q || typeof q !== "object") return null;
  if (!textOk(q.title, people) || !textOk(q.behavior, people)) return null;
  const t = q.trigger;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const trigger: Trigger = {};
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (!(k in VOCAB) || typeof v !== "string" || !VOCAB[k as keyof typeof VOCAB].has(v)) return null;
    trigger[k as keyof Trigger] = v;
  }
  if (Object.keys(trigger).length === 0) return null;
  if (target !== null && trigger.actor !== undefined && trigger.actor !== target) return null;
  const res = parseResolution(JSON.stringify(q.resolution ?? null));
  if (!res) return null;
  if (res.kind === "visits" && res.by !== undefined && !ACTOR_SET.has(res.by)) return null;
  return { title: (q.title as string).trim(), trigger, behavior: (q.behavior as string).trim(), resolution_json: JSON.stringify(res) };
}

interface Merged {
  slug: string;
  delta: number;
  evidence: string[];
  category: string | null;
  target: string | null;
  perspective: string | null;
  reason: string | null;
  quirk: SleepQuirk | null;
}

// ── clamp ──────────────────────────────────────────────────────────────────────
export function clampSleep(out: SleepOutput, st: ClampState): SleepPlan {
  const newId = st.newId ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const nowIso = new Date(st.nowMs).toISOString();
  const plan: SleepPlan = {
    traitInserts: [], traitUpdates: [], evidence: [], quirkInserts: [], quirkUpdates: [],
    counts: { created: 0, reinforced: 0, decayed: 0, promoted: 0, softened: 0, retired: 0 },
    dropped: [],
  };
  const drop = (slug: unknown, why: string) => plan.dropped.push({ slug: typeof slug === "string" ? slug.slice(0, 40) : "?", why });
  const bySlug = new Map(st.traits.map((t) => [t.slug, t]));

  // 1. Validate each item on its own, then merge per slug (order kept: the first CREATEs win the cap).
  const merged = new Map<string, Merged>();
  for (const it of out.items) {
    const op = typeof it.op === "string" ? it.op.toUpperCase() : "";
    if (op !== "CREATE" && op !== "REINFORCE" && op !== "DECAY") { drop(it.slug, "bad_op"); continue; }
    const slug = typeof it.slug === "string" ? it.slug.trim().toLowerCase() : "";
    if (!SLUG_RE.test(slug) || !textOk(slug.replace(/_/g, " "), st.people)) { drop(it.slug, "bad_slug"); continue; }
    const existing = bySlug.get(slug);
    // Target: a stored trait's target is fixed at birth; a new one takes the item's (null or a known actor).
    let target: string | null;
    if (existing) target = existing.target_actor;
    else {
      const ta = it.target_actor ?? null;
      if (ta !== null && (typeof ta !== "string" || !ACTOR_SET.has(ta))) { drop(slug, "bad_target"); continue; }
      target = ta as string | null;
    }
    let category: string | null = null;
    if (it.category !== undefined && it.category !== null) {
      if (typeof it.category !== "string" || !CATEGORY_SET.has(it.category)) { drop(slug, "bad_category"); continue; }
      category = it.category;
    }
    if (!existing && (op !== "CREATE" || category === null)) { drop(slug, "unknown_slug"); continue; }
    let perspective: string | null = null;
    if (it.perspective !== undefined && it.perspective !== null) {
      if (!textOk(it.perspective, st.people)) { drop(slug, "text"); continue; }
      perspective = (it.perspective as string).trim();
    }
    if (!existing && perspective === null) { drop(slug, "text"); continue; }
    let reason: string | null = null;
    if (it.reason !== undefined && it.reason !== null) {
      if (!textOk(it.reason, st.people)) { drop(slug, "text"); continue; }
      reason = (it.reason as string).trim();
    }
    let quirk: SleepQuirk | null = null;
    if (it.quirk !== undefined && it.quirk !== null) {
      if (!validQuirk(it.quirk, st.people, target)) { drop(slug, "bad_quirk"); continue; }
      quirk = it.quirk;
    }
    // Evidence: tonight's ids only; for an X-targeted item, X's own appraisals only (absent party).
    const ids = Array.isArray(it.evidence) ? it.evidence.filter((e): e is string => typeof e === "string") : [];
    const kept = [...new Set(ids)].filter((id) => {
      const a = st.night.get(id);
      return a !== undefined && (target === null || a.actor === target);
    });
    if (kept.length === 0) { drop(slug, "no_evidence"); continue; }
    const raw = typeof it.delta === "number" && Number.isFinite(it.delta) ? Math.abs(it.delta) : 1;
    const signed = op === "DECAY" ? -raw : raw;

    const m = merged.get(slug);
    if (!m) {
      merged.set(slug, { slug, delta: signed, evidence: kept, category, target, perspective, reason, quirk });
    } else {
      m.delta += signed;
      m.evidence = [...new Set([...m.evidence, ...kept])];
      m.category ??= category; m.perspective ??= perspective; m.reason ??= reason; m.quirk ??= quirk;
    }
  }

  const touched = new Map<string, TraitRow>(); // slug -> row as it will be after tonight
  const createdSlugs = new Set<string>();
  const updatedIds = new Set<string>();
  const quirkByTrait = new Map(st.quirks.filter((q) => q.trait_id).map((q) => [q.trait_id as string, q]));
  const quirkSpec = new Map<string, ValidQuirk>();
  const arcSupport = new Map<string, string[]>();          // quirk id -> evidence ids (live)
  const arcContra = new Map<string, { days: string[]; evidence: string[] }>();

  // 2. Apply merged items.
  for (const m of merged.values()) {
    const existing = bySlug.get(m.slug);
    const apps = m.evidence.map((id) => st.night.get(id)!);
    const live = apps.filter((a) => a.source === "live");
    const liveShare = live.length / apps.length;
    const liveDays = [...new Set(live.map((a) => a.day))];
    const delta = clamp(m.delta, -1, 1);
    if (m.quirk) {
      const q = validQuirk(m.quirk, st.people, m.target);
      if (q) quirkSpec.set(m.slug, q);
    }

    if (!existing) {
      if (plan.counts.created >= SLEEP.MAX_CREATES) { drop(m.slug, "create_cap"); continue; }
      const row: TraitRow = {
        id: newId(), creature_id: st.creatureId, slug: m.slug, category: m.category, target_actor: m.target,
        perspective: m.perspective, entrenchment: 1, live_points: round(liveShare), live_days: JSON.stringify(liveDays.sort()),
        origin: live.length > 0 ? "live" : "backfill", status: "candidate", last_reinforced_at: nowIso, created_at: nowIso,
      };
      plan.traitInserts.push(row);
      plan.evidence.push({ trait_id: row.id, appraisal_ids: m.evidence, delta: 1, reason: m.reason });
      plan.counts.created++;
      touched.set(m.slug, row);
      createdSlugs.add(m.slug);
      continue;
    }

    if (existing.status === "graduated") {
      // A quirk never decays; the graduated trait stays at 5. The night feeds the quirk's arc (live only).
      const q = quirkByTrait.get(existing.id);
      if (delta === 0) continue;
      plan.evidence.push({ trait_id: existing.id, appraisal_ids: m.evidence, delta, reason: m.reason });
      if (!q || live.length === 0) continue;
      if (delta > 0) { arcSupport.set(q.id, live.map((a) => a.id)); plan.counts.reinforced++; }
      else arcContra.set(q.id, { days: liveDays.sort(), evidence: live.map((a) => a.id) });
      continue;
    }

    if (existing.status === "faded") {
      if (delta <= 0) continue; // nothing to lower
      if (plan.counts.created >= SLEEP.MAX_CREATES) { drop(m.slug, "create_cap"); continue; }
      // Never locked: a faded trait (evicted, decayed, or its quirk retired) comes back as the SAME row,
      // a fresh candidate at 1: origin, live points and live days start over from tonight's evidence, so
      // UNIQUE(creature_id, slug) holds and the old evidence rows + any retired quirk stay as history.
      const row: TraitRow = {
        ...existing, status: "candidate", entrenchment: 1,
        category: m.category ?? existing.category, perspective: m.perspective ?? existing.perspective,
        origin: live.length > 0 ? "live" : "backfill",
        live_points: round(liveShare),
        live_days: JSON.stringify(liveDays.sort()),
        last_reinforced_at: nowIso,
      };
      plan.traitUpdates.push(row); updatedIds.add(row.id);
      plan.evidence.push({ trait_id: row.id, appraisal_ids: m.evidence, delta: 1, reason: m.reason });
      plan.counts.created++;
      touched.set(m.slug, row);
      createdSlugs.add(m.slug);
      continue;
    }

    // candidate
    if (delta === 0) continue;
    const ent = round(clamp(existing.entrenchment + delta, 0, SLEEP.MAX_ENTRENCH));
    const applied = round(ent - existing.entrenchment);
    const row: TraitRow = { ...existing, entrenchment: ent };
    if (delta > 0) {
      row.live_points = round(existing.live_points + applied * liveShare);
      row.live_days = JSON.stringify([...new Set([...parseDays(existing.live_days), ...liveDays])].sort());
      row.last_reinforced_at = nowIso;
      plan.counts.reinforced++;
    } else {
      plan.counts.decayed++;
      if (ent <= 0) row.status = "faded";
    }
    plan.traitUpdates.push(row); updatedIds.add(row.id);
    plan.evidence.push({ trait_id: row.id, appraisal_ids: m.evidence, delta: applied, reason: m.reason });
    touched.set(m.slug, row);
  }

  // 3. Time decay: a candidate nobody reinforced for 10 days loses 1 (and is not double-moved tonight).
  for (const t of st.traits) {
    if (t.status !== "candidate" || touched.has(t.slug)) continue;
    const at = dbTimeMs(t.last_reinforced_at ?? t.created_at);
    if (!Number.isFinite(at) || st.nowMs - at < SLEEP.DECAY_AFTER_DAYS * DAY_MS) continue;
    const ent = round(clamp(t.entrenchment - 1, 0, SLEEP.MAX_ENTRENCH));
    const row: TraitRow = { ...t, entrenchment: ent, status: ent <= 0 ? "faded" : "candidate" };
    plan.traitUpdates.push(row); updatedIds.add(row.id);
    plan.evidence.push({ trait_id: t.id, appraisal_ids: [], delta: round(ent - t.entrenchment), reason: "unreinforced 10 days" });
    plan.counts.decayed++;
    touched.set(t.slug, row);
  }

  // 4. Eviction: past 15 candidates, the lowest EXISTING candidate fades (tie: oldest last_reinforced_at).
  const current = (t: TraitRow) => touched.get(t.slug) ?? t;
  const candidates = () => [
    ...st.traits.map(current).filter((t) => t.status === "candidate"),
    ...plan.traitInserts,
  ];
  while (candidates().length > SLEEP.MAX_TRAITS) {
    const pool = st.traits.map(current).filter((t) => t.status === "candidate" && !createdSlugs.has(t.slug));
    if (pool.length === 0) break;
    pool.sort((a, b) => a.entrenchment - b.entrenchment
      || (dbTimeMs(a.last_reinforced_at) || 0) - (dbTimeMs(b.last_reinforced_at) || 0));
    const victim: TraitRow = { ...pool[0]!, status: "faded" };
    if (updatedIds.has(victim.id)) plan.traitUpdates = plan.traitUpdates.map((t) => (t.id === victim.id ? victim : t));
    else { plan.traitUpdates.push(victim); updatedIds.add(victim.id); }
    touched.set(victim.slug, victim);
  }

  // 5. Quirk arc (deterministic from tonight's live support / contradiction).
  for (const q of st.quirks) {
    const support = arcSupport.get(q.id);
    const contra = arcContra.get(q.id);
    if (!support && !contra) continue;
    const arc = parseArc(q.arc);
    let status = q.status;
    if (contra) arc.push({ night: st.nowDay, kind: "contradict", days: contra.days, evidence: contra.evidence });
    if (status === "softening") {
      const since = [...arc].reverse().find((e) => e.kind === "softening")?.night ?? st.nowDay;
      if (support) {
        status = "active";
        arc.push({ night: st.nowDay, kind: "rehardened", evidence: support });
      } else if (contra && dayIndex(st.nowDay) - dayIndex(since) >= SLEEP.RETIRE_AFTER_DAYS) {
        status = "retired";
        arc.push({ night: st.nowDay, kind: "retired" });
        plan.counts.retired++;
        // Never locked: the retired quirk's trait fades, so the same slug can grow again from 1.
        const t = st.traits.find((x) => x.id === q.trait_id);
        if (t && t.status === "graduated" && !updatedIds.has(t.id)) {
          const row: TraitRow = { ...t, status: "faded" };
          plan.traitUpdates.push(row); updatedIds.add(row.id);
          touched.set(row.slug, row);
        }
      }
    } else if (status === "active" && contra) {
      // Only contradiction after the last re-hardening counts, inside the 21-day window.
      let from = 0;
      arc.forEach((e, i) => { if (e.kind === "rehardened") from = i + 1; });
      const lo = dayIndex(st.nowDay) - SLEEP.SOFTEN_WINDOW_DAYS;
      const days = new Set<string>();
      for (const e of arc.slice(from)) {
        if (e.kind !== "contradict") continue;
        for (const d of e.days ?? []) if (dayIndex(d) > lo && dayIndex(d) <= dayIndex(st.nowDay)) days.add(d);
      }
      if (days.size >= SLEEP.SOFTEN_DAYS) {
        status = "softening";
        arc.push({ night: st.nowDay, kind: "softening" });
        plan.counts.softened++;
      }
    }
    plan.quirkUpdates.push({ id: q.id, status, arc: JSON.stringify(arc) });
  }

  // 6. Promotion: entrenchment 5, >= 4 live points over >= 3 distinct live days, a valid quirk block
  // tonight, and a free quirk slot (active + softening, after tonight's arc moves).
  const held = st.quirks.filter((q) => {
    const u = plan.quirkUpdates.find((x) => x.id === q.id);
    const s = u ? u.status : q.status;
    return s === "active" || s === "softening";
  }).length;
  let slots = SLEEP.MAX_QUIRKS - held;
  for (const [slug, spec] of quirkSpec) {
    const t = touched.get(slug);
    if (!t || t.status !== "candidate") continue;
    const liveDays = parseDays(t.live_days);
    if (t.entrenchment < SLEEP.MAX_ENTRENCH || t.live_points < SLEEP.PROMOTE_LIVE_POINTS || liveDays.length < SLEEP.PROMOTE_LIVE_DAYS) continue;
    if (slots <= 0) { drop(slug, "quirk_cap"); continue; }
    slots--;
    const qid = newId();
    plan.quirkInserts.push({
      id: qid, creature_id: st.creatureId, trait_id: t.id, title: spec.title, trigger_json: JSON.stringify(spec.trigger),
      behavior: spec.behavior, resolution_json: spec.resolution_json, target_actor: t.target_actor,
      kind: t.category === "aversion" ? "aversion" : "preference", status: "active",
      arc: JSON.stringify([{ night: st.nowDay, kind: "promoted", days: liveDays, evidence: merged.get(slug)?.evidence ?? [] }]),
      promoted_at: nowIso,
    });
    const graduated = { ...t, status: "graduated" };
    const ins = plan.traitInserts.findIndex((x) => x.id === t.id);
    if (ins >= 0) plan.traitInserts[ins] = graduated;
    else plan.traitUpdates = plan.traitUpdates.map((x) => (x.id === t.id ? graduated : x));
    touched.set(slug, graduated);
    plan.counts.promoted++;
  }

  return plan;
}
