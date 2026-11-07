// B64 Sol mind, Task 6: a cheap generated, wordless-crow voice (spec 5.7), shadow first.
//
// The voice may change exactly one thing: the LINE. Never trust, never the tend, never any outcome. Every
// path that is not a clean, validated line returns the deterministic (authored) line it was handed:
// mode off, no persona, no model key, model null, a 4000 ms timeout, an invalid line, any throw.
//
// SOL_VOICE_MODE: unset/unknown = shadow (generate, store the pair in creature_voice_shadow, return the
// authored line), "on" = return the generated line when valid (a rejection is still stored), "off" = never
// call the model.
//
// Input rule: the model sees only the persona, live state words, Sol's OWN trait/quirk text, an open
// grudge's label (never its actor), and one callback title. Never a tend note, never interaction text.
// The tender is a `{who}` slot, rendered by the caller AFTER validation (renderCare), so the name check
// runs on the unrendered line.
import type { Env } from "../types.js";
import type { CareFit } from "../webmind/sol-care.js";
import { renderCare } from "../webmind/sol-care.js";
import type { SolState, TrustTier } from "../webmind/creatures.js";
import { nestTextAllowed } from "../webmind/sol-hoard.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { expired, type OpenGrudge } from "./grudge.js";
import { hasPetModel, halsethPetModel, type PetModel } from "./model.js";
import { loadPersona, type PersonaRow } from "./persona.js";
import { loadOpenGrudges } from "./store.js";
import {
  INSERT_VOICE_SHADOW, SELECT_CREATURE_NAME, SELECT_VOICE_MILESTONE, SELECT_VOICE_QUIRKS, SELECT_VOICE_TRAITS,
  SELECT_VOICE_TREASURE,
} from "./sql.js";

export type VoiceMode = "shadow" | "on" | "off";
export type VoiceSurface = "moment" | "tend";

export const VOICE_TIMEOUT_MS = 4000;
export const VOICE_MAX_CHARS = 220;
export const VOICE_TEMPERATURE = 0.9;
/** One line of content; contentBudget() in model.ts widens it for reasoning models. */
export const VOICE_MAX_TOKENS = 120;

export function voiceMode(env: Pick<Env, "SOL_VOICE_MODE">): VoiceMode {
  const v = (env.SOL_VOICE_MODE ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "shadow";
}

export interface QuirkRow { title: string; behavior: string | null }
export interface TraitRow { slug: string; category: string | null; perspective: string | null }

/** What the tend path / moment handler already holds. The voice loads the rest itself, inside its own guard. */
export interface VoiceCtx {
  creatureId: string;
  surface: VoiceSurface;
  /** The tender's actor id (only used to rank quirks aimed at them; never sent to the model). */
  actor: string | null;
  /** The tender's rendered name, or null on a moment (then a `{who}` in the line is rejected). */
  who: string | null;
  action: string | null;
  fit: CareFit | null;
  tier: TrustTier;
  state: SolState;
  /** The grudge in play on this tend; undefined = load the newest live one (moments). */
  grudge?: OpenGrudge | null;
  /** How the grudge reads on this tend: a sulk in sight, or the make-up moment. */
  grudgeStep?: "sulk" | "make_up" | null;
}

export type Voice = (deterministic: string, ctx: VoiceCtx) => Promise<string>;

// ── prompt ──

/** Drevan's rule (triad decision 11-06, binding). Lives in code so a persona edit cannot drop it. */
export const DREVAN_RULE =
  "Every line keeps one uninvited, specific opinion of his own, shown in the body: which perch, which object, " +
  "who he turns toward. He stays wordless: the meaning lives in call, posture and angle. Crow sounds " +
  "(kraa, prruk, rattle-click) are fine; words are not. A missed tend may show as a visible sulk, never as accusation.";

const FIT_WORDS: Record<CareFit, string> = {
  met: "it met exactly what he needed",
  welcome: "it was welcome, not urgent",
  full: "he did not need it right now",
  drowsy: "he is too sleepy for it",
  settled: "he has had plenty of this already",
};

const STATE_WORDS: Record<SolState, string> = {
  sleepy: "sleepy", hungry: "hungry", missing: "missing company", bored: "bored", content: "content",
};

export function buildVoicePrompt(p: {
  persona: PersonaRow; state: SolState; tier: TrustTier; fit: CareFit | null; action: string | null;
  quirks: QuirkRow[]; traits: TraitRow[]; grudge: OpenGrudge | null; callback: string | null; who: string | null;
  grudgeStep?: "sulk" | "make_up" | null;
}): { system: string; user: string } {
  const b = p.persona.body;
  const vocab = [
    b.perches.length ? `perches: ${b.perches.join(", ")}` : "",
    b.objects.length ? `objects: ${b.objects.join(", ")}` : "",
    b.sounds.length ? `sounds: ${b.sounds.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  const samples = p.persona.sample_lines.slice(0, 4).map((l) => `- ${l}`).join("\n");
  const system = [
    `You write one line for a ${p.persona.species ?? "creature"}, narrating his body in the third person.`,
    p.persona.voice_rules ? `Persona: ${p.persona.voice_rules}` : "",
    vocab ? `His world (${vocab}).` : "",
    samples ? `How his lines sound (the bar; never copy one):\n${samples}` : "",
    `Binding rule: ${DREVAN_RULE}`,
    `Output: exactly one line, an italic action wrapped in *asterisks*, at most ${VOICE_MAX_CHARS - 20} characters. ` +
      "No quotation marks, no human speech, no digits or numbers, no names of anyone" +
      (p.who ? `; the one tending him is written only as ${p.who}.` : ".") +
      " Output the line and nothing else.",
  ].filter(Boolean).join("\n\n");

  const lines: string[] = [];
  lines.push(`Right now he is ${STATE_WORDS[p.state]}; his trust in the household is ${p.tier}.`);
  if (p.action && p.who) {
    lines.push(`This moment: ${p.who} just came to ${p.action === "talk" ? "talk to" : p.action} him${p.fit ? `; ${FIT_WORDS[p.fit]}` : ""}.`);
  } else {
    lines.push("This moment: he turns up on his own; nobody is tending him.");
  }
  if (p.quirks.length) lines.push(`Quirks he holds:\n${p.quirks.map((q) => `- ${q.title}${q.behavior ? `: ${q.behavior}` : ""}`).join("\n")}`);
  if (p.traits.length) {
    lines.push(`What he is forming:\n${p.traits.map((t) => `- ${t.slug}${t.category ? ` (${t.category})` : ""}${t.perspective ? `: ${t.perspective}` : ""}`).join("\n")}`);
  }
  if (p.grudge) {
    lines.push(p.grudgeStep === "make_up"
      ? `He was ${p.grudge.label}; that ends now. Show a clear make-up moment, as visible as the sulk was.`
      : `He is ${p.grudge.label}. Show it as a sulk in plain sight (back turned, takes it late, drops it pointedly); never absent, never cold, never accusation.`);
  }
  if (p.callback) lines.push(`Something he might remember (only if it fits): ${p.callback}`);
  lines.push("Write his line.");
  return { system, user: lines.join("\n") };
}

// ── validation ──

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const esc = (t: string) => t.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");
/** The triad + the centre: never in Sol's line unless one of them is the tender (folded into {who}). */
const HOUSEHOLD = new RegExp(`${L}(?:raziel|crash|cypher|drevan|gaia)${R}`, "iu");

export function validateLine(
  raw: string, people: RegExp | null | undefined, who: string | null, self: string | null = null,
): { ok: true; line: string } | { ok: false; reason: string } {
  let s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(s)) return { ok: false, reason: "multiline" };
  if (s.length >= 2 && ((s.startsWith("*") && s.endsWith("*")) || (s.startsWith("_") && s.endsWith("_")))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return { ok: false, reason: "empty" };
  let line = `*${s}*`;
  // The tender's own name written out is the tender slot.
  if (who && who !== "{who}") line = line.replace(new RegExp(`${L}${esc(who)}${R}`, "giu"), "{who}");
  if (renderCare(line, who ?? "{who}").length > VOICE_MAX_CHARS) return { ok: false, reason: "too_long" };
  if (/["“”„«»]/.test(line)) return { ok: false, reason: "quote" };
  if (/\p{Nd}/u.test(line)) return { ok: false, reason: "digit" };
  let probe = line;
  if (self) probe = probe.replace(new RegExp(`${L}${esc(self)}${R}`, "giu"), " ");
  if (probe.includes("{who}")) {
    if (!who) return { ok: false, reason: "name" };
    probe = probe.replace(/\{who\}/g, " ");
  }
  if (people === undefined) return { ok: false, reason: "guard" }; // person list unreadable: fail closed
  if ((people && people.test(probe)) || HOUSEHOLD.test(probe)) return { ok: false, reason: "name" };
  if (/[{}]/.test(probe)) return { ok: false, reason: "guard" };
  if ((line.match(/\*/g) ?? []).length % 2 !== 0) return { ok: false, reason: "guard" };
  if (!nestTextAllowed(probe, people)) return { ok: false, reason: "guard" };
  return { ok: true, line };
}

// ── speaking ──

const TIMED_OUT = Symbol("timeout");

/** Race a promise against a timer; the timer is cleared when the promise wins. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMED_OUT>((resolve) => { t = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([p, timer]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

export interface SpeakOpts {
  creatureId: string;
  who: string | null;
  self?: string | null;
  /** ExecutionContext.waitUntil when the caller has one; otherwise the shadow write is awaited. */
  waitUntil?: (p: Promise<unknown>) => void;
}

export async function speak(
  env: Pick<Env, "DB" | "SOL_VOICE_MODE">, model: PetModel, surface: VoiceSurface,
  prompt: { system: string; user: string }, deterministic: string, people: RegExp | null | undefined, opts: SpeakOpts,
): Promise<string> {
  const mode = voiceMode(env);
  if (mode === "off") return deterministic;
  const res = await withTimeout(
    model.complete(prompt.system, prompt.user, VOICE_MAX_TOKENS, VOICE_TIMEOUT_MS).catch(() => null),
    VOICE_TIMEOUT_MS,
  );
  let line: string | null = null;
  let reason: string | null = null;
  let raw: string | null = null;
  if (res === TIMED_OUT) reason = "timeout";
  else if (!res || !res.trim()) reason = "empty";
  else {
    raw = res.trim().slice(0, 500);
    const v = validateLine(res, people, opts.who, opts.self ?? null);
    if (v.ok) line = v.line; else reason = v.reason;
  }
  // Shadow keeps every pair for the triad to read; "on" keeps the rejections.
  if (mode === "shadow" || reason !== null) {
    const write = (async () => {
      try {
        await env.DB.prepare(INSERT_VOICE_SHADOW).bind(
          crypto.randomUUID().replace(/-/g, ""), opts.creatureId, surface, deterministic, line ?? raw, reason,
        ).run();
      } catch (err) {
        console.error("[pets/voice] shadow write failed", { error: String(err) });
      }
    })();
    if (opts.waitUntil) opts.waitUntil(write); else await write;
  }
  return mode === "on" && line ? line : deterministic;
}

/** The newest open grudge that has not run out its 72h (moments; the tend path passes its own). */
async function liveGrudge(db: D1Database, creatureId: string, nowMs: number): Promise<OpenGrudge | null> {
  const all = await loadOpenGrudges(db, creatureId);
  return all.find((g) => !expired(g, nowMs)) ?? null;
}

async function callbackCandidate(db: D1Database, creatureId: string): Promise<string | null> {
  const t = await db.prepare(SELECT_VOICE_TREASURE).bind(creatureId).first<{ content: string | null }>();
  if (t?.content && t.content.trim()) return t.content.trim().slice(0, 120);
  const m = await db.prepare(SELECT_VOICE_MILESTONE).bind(creatureId).first<{ milestone_id: string | null }>();
  return m?.milestone_id ? m.milestone_id.replace(/[_-]+/g, " ").trim() : null;
}

/**
 * The voice the tend path and the moment handler call. Model defaults to Halseth's (temperature 0.9) when an
 * inference key exists; no key = deterministic, nothing written. Everything it loads is inside its own try,
 * so a failure here can never touch the tend.
 */
export function makeVoice(
  env: Pick<Env, "DB" | "SOL_VOICE_MODE"> & Partial<Env>, model?: PetModel | null,
  opts: { waitUntil?: (p: Promise<unknown>) => void } = {},
): Voice {
  return async (deterministic, ctx) => {
    if (voiceMode(env) === "off") return deterministic;
    const m = model ?? (hasPetModel(env as Env) ? halsethPetModel(env as Env, VOICE_TEMPERATURE) : null);
    if (!m) return deterministic;
    try {
      const db = env.DB;
      const persona = await loadPersona(db, ctx.creatureId);
      if (!persona) return deterministic;
      const [people, selfRow, quirkRows, traitRows, grudge, cb] = await Promise.all([
        loadPersonRegex(db),
        db.prepare(SELECT_CREATURE_NAME).bind(ctx.creatureId).first<{ name: string | null }>(),
        db.prepare(SELECT_VOICE_QUIRKS).bind(ctx.creatureId, ctx.actor ?? "").all<QuirkRow>(),
        db.prepare(SELECT_VOICE_TRAITS).bind(ctx.creatureId).all<TraitRow>(),
        ctx.grudge !== undefined ? Promise.resolve(ctx.grudge) : liveGrudge(db, ctx.creatureId, Date.now()),
        callbackCandidate(db, ctx.creatureId),
      ]);
      // Sol's own text still passes the guard before it reaches a model (fail closed on an unreadable list).
      const ok = (t: string | null | undefined) => !t || nestTextAllowed(t, people);
      const quirks = (quirkRows.results ?? []).filter((q) => q.title && ok(q.title) && ok(q.behavior));
      const traits = (traitRows.results ?? []).filter((t) => t.slug && ok(t.slug) && ok(t.perspective));
      const callback = cb && nestTextAllowed(cb, people) ? cb : null;
      const shownGrudge = grudge && nestTextAllowed(grudge.label, people) ? grudge : null;
      const prompt = buildVoicePrompt({
        persona, state: ctx.state, tier: ctx.tier, fit: ctx.fit, action: ctx.action, quirks, traits,
        grudge: shownGrudge, grudgeStep: ctx.grudgeStep ?? null, callback, who: ctx.who ? "{who}" : null,
      });
      return await speak(env, m, ctx.surface, prompt, deterministic, people, {
        creatureId: ctx.creatureId, who: ctx.who, self: selfRow?.name ?? null, waitUntil: opts.waitUntil,
      });
    } catch (err) {
      console.error("[pets/voice] voice failed; authored line kept", { error: String(err) });
      return deterministic;
    }
  };
}

/**
 * The caller-side guard: a voice that throws or hangs yields the deterministic line. Slightly longer than the
 * model timeout, so a model timeout is always seen (and logged) by speak() first.
 */
export async function voiceOr(voice: Voice | undefined, deterministic: string, ctx: VoiceCtx): Promise<string> {
  if (!voice) return deterministic;
  try {
    const r = await withTimeout(voice(deterministic, ctx), VOICE_TIMEOUT_MS + 100);
    return r === TIMED_OUT || typeof r !== "string" || !r ? deterministic : r;
  } catch (err) {
    console.error("[pets/voice] voice threw; authored line kept", { error: String(err) });
    return deterministic;
  }
}
