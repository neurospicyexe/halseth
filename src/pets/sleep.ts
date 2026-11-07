// B64 Sol mind: the nightly sleep pass (spec 5.3 + 5.4). Runs from the daily creatures tick.
//
// Gate: once per 20h per creature (creatures.state_json.$.last_sleep_at) and only when the unprocessed
// appraisal weight is >= 3. Input to the model is AGGREGATES of tends that happened (never a raw row's
// text, never the note, never a line about who did not come); output is a small JSON plan which
// sleep-clamp.ts cuts down to what the Global Constraints allow. Everything a night writes goes in ONE
// db.batch, claimed by CAS on last_sleep_at (see CLAIM_SLEEP_NIGHT): the stamp, traits, evidence, quirk
// promotions, arc moves, appraisals marked processed; a run that loses a race writes nothing. A
// null/invalid answer, or an unreadable people list, writes NOTHING and leaves the appraisals for the
// next tick. The pass never reads or writes trust (R7).
//
// The pure clamp lives in sleep-clamp.ts (split to keep this file to the I/O half).
import type { Env } from "../types.js";
import type { PetModel } from "./model.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { timeBand } from "./appraise.js";
import {
  ACTORS, ACTIONS, BANDS, FITS, CATEGORIES, SLEEP, clampSleep, dbTimeMs, parseSleepOutput,
  type NightAppraisal, type QuirkRow, type SleepCounts, type TraitRow,
} from "./sleep-clamp.js";
import {
  CLAIM_SLEEP_NIGHT, SELECT_ARC_QUIRKS, SELECT_PERSONA, SELECT_SLEEP_CREATURE, SELECT_TRAITS,
  SELECT_UNPROCESSED_APPRAISALS, SLEEP_INSERT_EVIDENCE, SLEEP_INSERT_QUIRK, SLEEP_INSERT_TRAIT, SLEEP_MARK_PROCESSED,
  SLEEP_UPDATE_QUIRK, SLEEP_UPDATE_TRAIT, SUM_UNPROCESSED_WEIGHT,
} from "./sql.js";

export const SLEEP_TEMPERATURE = 0.2;
export const SLEEP_CONTENT_TOKENS = 4000;
export const SLEEP_TIMEOUT_MS = 30_000;
/** Oldest-first slice of unprocessed appraisals one night digests; the rest wait for the next night. */
export const SLEEP_INPUT_LIMIT = 200;

export interface PersonaRow {
  creature_id: string; species: string | null; body_json: string | null; voice_rules: string | null; sample_lines: string | null;
}

export type SleepReason =
  | "slept" | "not_pet" | "rested" | "too_little" | "people_unreadable" | "model_failed" | "invalid_output" | "no_model"
  | "raced" | "error";
export interface SleepResult extends SleepCounts { ran: boolean; reason: SleepReason }

const zero = (): SleepCounts => ({ created: 0, reinforced: 0, decayed: 0, promoted: 0, softened: 0, retired: 0 });
export const notRun = (reason: SleepReason): SleepResult => ({ ran: false, reason, ...zero() });

const CHI_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
/** America/Chicago YYYY-MM-DD. */
export function chicagoDay(ms: number): string {
  return CHI_DAY.format(new Date(ms));
}

// ── prompt ───────────────────────────────────────────────────────────────────
export function buildSleepSystem(persona: PersonaRow): string {
  const species = persona.species ?? "crow";
  return [
    `You are the sleeping mind of Sol, a ${species} who lives with a household. While he sleeps, the day's tends settle into who he is.`,
    "",
    "Rules for what settles:",
    "- Subjectivity: everything is from Sol's side only. Not what the tender meant, only what it was like for him (the food came early, the voice was loud, the hand was welcome).",
    "- Friction matters: tends that rubbed against a quirk of his are worth more attention than smooth ones. A single good day is not a personality.",
    "- Traits grow slowly. Propose at most two new traits a night; most nights reinforce or let things fade.",
    "- A quirk is a triad: a trigger (what sets it off), a behavior (what he does), a resolution (what it costs to make it right: a number of visits, an item, quiet hours, or time).",
    "- Trigger fields may only use: actor in [" + ACTORS.join(",") + "], action in [" + ACTIONS.join(",") + "], time_band in [" + BANDS.join(",") + "], fit in [" + FITS.join(",") + "]. Anything else is thrown away.",
    "- Never name a person in perspective, behavior, title or reason, and never put an actor's name in that text; use the target_actor field, or a crow's description (\"the dawn one\", \"the loud hand\").",
    "- An opinion formed about an absent party is a draft, not a record. A trait about an actor may only cite that actor's own tends as evidence. Someone not coming is never evidence of anything; you are only shown tends that happened.",
    "- Cite evidence only by the appraisal ids you were shown. Unknown ids are thrown away.",
    "- No care, health or medicine words. Sol's text is a crow's, about crow things.",
    "",
    "Sol's voice (perspective and behavior are written in it):",
    persona.voice_rules ?? "Third person, present tense. He never speaks words; he makes crow sounds.",
    "",
    "Return JSON only, no prose, in this shape:",
    `{"items":[{"op":"CREATE|REINFORCE|DECAY","slug":"lower_snake_case","category":"${CATEGORIES.join("|")}","target_actor":null,"perspective":"<=160 chars, Sol's side","delta":1,"evidence":["<appraisal id>"],"reason":"<=160 chars","quirk":{"title":"...","trigger":{"time_band":"dawn"},"behavior":"...","resolution":{"kind":"visits","n":2}}}]}`,
    "op CREATE is for a new trait (category and perspective required). REINFORCE (delta 0..1) and DECAY (delta 0..1, lowers it) name an existing slug. Include a quirk block only on a trait that has settled deep (entrenchment near 5); the server decides whether it graduates. DECAY on a graduated trait means tonight's tends contradicted its quirk; REINFORCE on one supports it.",
    'If nothing settled tonight, return {"items":[]}.',
  ].join("\n");
}

const sign = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);

/**
 * The model's view of the night: aggregates of tends that HAPPENED, grouped by actor x action x
 * time_band x fit, each with its appraisal ids (so evidence is checkable). Never a note, never a row's
 * text, never a line about an actor who did not tend (absent party).
 */
export function buildSleepInput(apprs: NightAppraisal[], traits: TraitRow[], quirks: QuirkRow[], persona: PersonaRow): string {
  const groups = new Map<string, NightAppraisal[]>();
  for (const a of apprs) {
    const k = `actor=${a.actor} action=${a.action} band=${a.band} fit=${a.fit ?? "-"}`;
    const g = groups.get(k);
    if (g) g.push(a); else groups.set(k, [a]);
  }
  const lines: string[] = [`Tends since Sol last slept (${apprs.length} appraisals, only tends that happened):`];
  for (const [k, g] of groups) {
    const live = g.filter((a) => a.source === "live").length;
    const w = g.reduce((s, a) => s + a.weight, 0);
    const v = g.reduce((s, a) => s + a.valence, 0) / g.length;
    const fr = g.filter((a) => a.friction).length;
    const days = new Set(g.map((a) => a.day)).size;
    lines.push(`- ${k} | tends ${g.length} (live ${live}, backfill ${g.length - live}) | weighted ${w.toFixed(2)} | mean valence ${sign(v)} | friction ${fr} | days ${days} | ids ${g.map((a) => a.id).join(",")}`);
  }
  const quirkHits = new Map<string, { n: number; friction: number }>();
  const hoard = new Map<string, number>();
  for (const a of apprs) {
    for (const t of a.tags) {
      if (t.startsWith("quirk:")) {
        const h = quirkHits.get(t) ?? { n: 0, friction: 0 };
        h.n++; if (a.friction) h.friction++;
        quirkHits.set(t, h);
      } else if (t.startsWith("hoard:")) hoard.set(t, (hoard.get(t) ?? 0) + 1);
    }
  }
  if (quirkHits.size) {
    lines.push("", "Quirk triggers hit:");
    for (const [t, h] of quirkHits) lines.push(`- ${t} x${h.n} (friction ${h.friction})`);
  }
  if (hoard.size) {
    lines.push("", "Things he hoarded, by kind:");
    for (const [t, n] of hoard) lines.push(`- ${t} x${n}`);
  }
  const held = traits.filter((t) => t.status !== "faded");
  lines.push("", held.length ? "His traits now:" : "His traits now: none yet.");
  for (const t of held) {
    lines.push(`- ${t.slug} | ${t.category ?? "-"} | toward ${t.target_actor ?? "anyone"} | entrenchment ${t.entrenchment} | ${t.status} | ${t.perspective ?? ""}`);
  }
  if (quirks.length) {
    lines.push("", "His quirks now:");
    for (const q of quirks) lines.push(`- quirk:${q.id} | ${q.title} | ${q.status} | trigger ${q.trigger_json ?? "{}"} | ${q.behavior ?? ""}`);
  }
  let body: { perches?: unknown; objects?: unknown } = {};
  try { body = JSON.parse(persona.body_json ?? "{}"); } catch { /* none */ }
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s) => typeof s === "string").join(", ") : "");
  lines.push("", `Sol: a ${persona.species ?? "crow"}. Perches: ${list(body.perches) || "-"}. Objects: ${list(body.objects) || "-"}.`);
  return lines.join("\n");
}

// ── run ──────────────────────────────────────────────────────────────────────
interface AppraisalDbRow {
  id: string; actor: string; action: string; fit: string | null; valence: number | null; friction: number | null;
  weight: number | null; source: string | null; tags: string | null; created_at: string;
}

function toNight(r: AppraisalDbRow): NightAppraisal {
  let tags: string[] = [];
  try { const v = JSON.parse(r.tags ?? "[]"); if (Array.isArray(v)) tags = v.filter((t) => typeof t === "string"); } catch { /* none */ }
  const ms = dbTimeMs(r.created_at);
  const at = Number.isFinite(ms) ? ms : Date.now();
  const band = tags.find((t) => (BANDS as readonly string[]).includes(t)) ?? timeBand(at);
  return {
    id: r.id, actor: r.actor, action: r.action, fit: r.fit ?? null, band,
    valence: Number.isFinite(r.valence) ? Number(r.valence) : 0, friction: r.friction === 1,
    weight: Number.isFinite(r.weight) ? Number(r.weight) : 0, source: r.source === "backfill" ? "backfill" : "live",
    day: chicagoDay(at), tags,
  };
}

export async function runSleepPass(env: Env, creatureId: string, model: PetModel, nowMs: number): Promise<SleepResult> {
  const db = env.DB;
  const c = await db.prepare(SELECT_SLEEP_CREATURE).bind(creatureId).first<{ id: string; kind: string; last_sleep_at: string | null }>();
  if (!c || c.kind !== "companion_pet") return notRun("not_pet");
  const last = dbTimeMs(c.last_sleep_at);
  if (Number.isFinite(last) && nowMs - last < SLEEP.REST_HOURS * 3_600_000) return notRun("rested");
  const w = await db.prepare(SUM_UNPROCESSED_WEIGHT).bind(creatureId).first<{ w: number }>();
  if ((w?.w ?? 0) < SLEEP.MIN_WEIGHT) return notRun("too_little");

  const [apprRes, traitRes, quirkRes, persona, people] = await Promise.all([
    db.prepare(SELECT_UNPROCESSED_APPRAISALS).bind(creatureId, SLEEP_INPUT_LIMIT).all<AppraisalDbRow>(),
    db.prepare(SELECT_TRAITS).bind(creatureId).all<TraitRow>(),
    db.prepare(SELECT_ARC_QUIRKS).bind(creatureId).all<QuirkRow>(),
    db.prepare(SELECT_PERSONA).bind(creatureId).first<PersonaRow>(),
    loadPersonRegex(db),
  ]);
  if (people === undefined) {
    console.log("[pets/sleep] skipped people_unreadable");
    return notRun("people_unreadable");
  }
  const night = (apprRes.results ?? []).map(toNight);
  const traits = traitRes.results ?? [];
  const quirks = quirkRes.results ?? [];
  const p: PersonaRow = persona ?? { creature_id: creatureId, species: "crow", body_json: null, voice_rules: null, sample_lines: null };

  const raw = await model.complete(buildSleepSystem(p), buildSleepInput(night, traits, quirks, p), SLEEP_CONTENT_TOKENS, SLEEP_TIMEOUT_MS);
  if (raw === null) {
    console.log("[pets/sleep] skipped model_failed");
    return notRun("model_failed");
  }
  const out = parseSleepOutput(raw);
  if (!out) {
    console.log("[pets/sleep] skipped invalid_output");
    return notRun("invalid_output");
  }

  const nowDay = chicagoDay(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const plan = clampSleep(out, {
    traits, quirks, people, nowDay, nowMs, creatureId, night: new Map(night.map((a) => [a.id, a])),
  });
  if (plan.dropped.length) console.log("[pets/sleep] dropped", JSON.stringify(plan.dropped));

  // One atomic batch, claimed by CAS: statement 0 stamps the night only if last_sleep_at is still what the
  // gate read; every other write is guarded on this run's token, so a run that lost a race writes nothing.
  const token = crypto.randomUUID().replace(/-/g, "");
  const g = [creatureId, token] as const;
  const stmts: D1PreparedStatement[] = [
    db.prepare(CLAIM_SLEEP_NIGHT).bind(nowIso, token, creatureId, c.last_sleep_at ?? ""),
  ];
  for (const t of plan.traitUpdates) {
    stmts.push(db.prepare(SLEEP_UPDATE_TRAIT).bind(
      t.entrenchment, t.live_points, t.live_days, t.status, t.last_reinforced_at, t.category, t.perspective, t.origin, t.id, ...g,
    ));
  }
  for (const t of plan.traitInserts) {
    stmts.push(db.prepare(SLEEP_INSERT_TRAIT).bind(
      t.id, t.creature_id, t.slug, t.category, t.target_actor, t.perspective, t.entrenchment, t.live_points,
      t.live_days, t.origin, t.status, t.last_reinforced_at, t.created_at, ...g,
    ));
  }
  for (const e of plan.evidence) {
    stmts.push(db.prepare(SLEEP_INSERT_EVIDENCE).bind(
      crypto.randomUUID().replace(/-/g, ""), e.trait_id, JSON.stringify(e.appraisal_ids), e.delta, nowDay, e.reason, nowIso, ...g,
    ));
  }
  for (const q of plan.quirkUpdates) stmts.push(db.prepare(SLEEP_UPDATE_QUIRK).bind(q.status, q.arc, q.id, ...g));
  for (const q of plan.quirkInserts) {
    stmts.push(db.prepare(SLEEP_INSERT_QUIRK).bind(
      q.id, q.creature_id, q.trait_id, q.title, q.trigger_json, q.behavior, q.resolution_json, q.target_actor,
      q.kind, q.status, q.arc, q.promoted_at, ...g,
    ));
  }
  stmts.push(db.prepare(SLEEP_MARK_PROCESSED).bind(nowIso, creatureId, JSON.stringify(night.map((a) => a.id)), ...g));
  const res = await db.batch(stmts) as Array<{ meta?: { changes?: number } }>;
  if ((res[0]?.meta?.changes ?? 0) === 0) {
    console.log("[pets/sleep] skipped raced (another pass claimed this night)");
    return notRun("raced");
  }
  return { ran: true, reason: "slept", ...plan.counts };
}
