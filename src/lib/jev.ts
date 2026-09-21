// src/lib/jev.ts -- Jev (TypeSafe System One) through the Workers AI binding.
//
// Jev is a judgment-only model: one `state` string, a dict of typed questions, and it returns
// probabilities -- never text. Three question types:
//   noul   -> P(true) for a binary proposition
//   choice -> a distribution over declared alternatives + a confidence
//   score  -> a continuous value over ordered descriptive levels + a distribution + confidence
//
// WHY THIS IS A LIB AND NOT JUST AN ENDPOINT. The first consumer is the retro scoring harness
// (scripts/jev-writeback-score.mjs) hitting POST /admin/jev; the intended second consumer is the
// writeback gate in front of the bots' judgeWriteback (docs/PLAN-jev-2026-09-20.md §2), which will
// call this directly from a Librarian executor. One function, two doors.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not retry, cache, or fall back. Every caller of Jev
// in this codebase replaces a gate with a known fail-open/fail-closed posture, and that posture
// belongs to the CALLER (replacement-must-keep-the-guarantees). A lib that silently returned a
// default on error would erase the distinction between "Jev said no" and "Jev was down".
//
// Public facts this code relies on (2026-09-20): model route `typesafe/jev` on Workers AI;
// context 64k total with state + longest question <= 32k tokens; text-only; measured median
// latency ~240ms with a ~160ms network floor (third-party benchmark, not the vendor's 70ms).

import type { Env } from "../types.js";

export const JEV_MODEL = "typesafe/jev";

/** Hard input cap, characters. ~4 chars/token keeps us well inside the 32k state+question limit. */
export const JEV_MAX_STATE_CHARS = 100_000;

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  /** Optional per-side criteria; keys are exactly "true" and "false". */
  criteria?: { true: string; false: string };
};
export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** alternative id -> description. At least two. */
  criteria: Record<string, string>;
};
export type JevScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest first. At least two. */
  criteria: string[];
};
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};
export type JevScoreAnswer = {
  type: "score";
  score: number;
  distribution?: number[];
  confidence?: number;
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  latency_ms: number;
  /** Whatever usage the binding reports; shape is the vendor's, passed through untouched. */
  usage: unknown;
  /**
   * Present ONLY when the binding answered fewer questions than were asked: the raw binding
   * payload, JSON-serialised and clipped to 2000 chars, so a caller with `?debug=1` can see the
   * shape that did not fit. Never set on a full answer. Found necessary 2026-09-21: 667 live
   * calls returned 200 with `answers: {}` and the `[jev]` warn line could not say WHY.
   */
  raw_preview?: string;
}

export class JevInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevInputError";
  }
}

/**
 * Validate the request shape before it reaches the binding. Errors here are the caller's
 * bug (400), not Jev's (502), and the two must stay distinguishable in logs.
 */
export function validateJevInput(state: unknown, questions: unknown): asserts questions is Record<string, JevQuestion> {
  if (typeof state !== "string" || state.trim().length === 0) throw new JevInputError("state must be a non-empty string");
  if (state.length > JEV_MAX_STATE_CHARS) throw new JevInputError(`state exceeds ${JEV_MAX_STATE_CHARS} chars`);
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) throw new JevInputError("questions must be an object");
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0) throw new JevInputError("questions must have at least one entry");
  for (const [key, q] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new JevInputError(`question key "${key}" must be an identifier`);
    if (!q || typeof q !== "object") throw new JevInputError(`question "${key}" must be an object`);
    const qq = q as Record<string, unknown>;
    if (typeof qq.instructions !== "string" || !qq.instructions.trim()) throw new JevInputError(`question "${key}" needs instructions`);
    switch (qq.type) {
      case "noul": {
        if (qq.criteria !== undefined) {
          const c = qq.criteria as Record<string, unknown>;
          if (!c || typeof c !== "object" || typeof c.true !== "string" || typeof c.false !== "string") {
            throw new JevInputError(`noul "${key}" criteria must be { true, false } strings`);
          }
        }
        break;
      }
      case "choice": {
        const c = qq.criteria as Record<string, unknown>;
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).length < 2) {
          throw new JevInputError(`choice "${key}" needs >= 2 criteria alternatives`);
        }
        for (const [alt, desc] of Object.entries(c)) {
          if (typeof desc !== "string") throw new JevInputError(`choice "${key}" alternative "${alt}" must describe itself as a string`);
        }
        break;
      }
      case "score": {
        const c = qq.criteria;
        if (!Array.isArray(c) || c.length < 2 || c.some((x) => typeof x !== "string")) {
          throw new JevInputError(`score "${key}" needs an ordered array of >= 2 level strings`);
        }
        break;
      }
      default:
        throw new JevInputError(`question "${key}" type must be noul | choice | score`);
    }
  }
}

/**
 * One Jev evaluation. Throws JevInputError on a malformed request and rethrows the binding's own
 * error otherwise -- the caller decides what "Jev is down" means for its gate.
 *
 * Every call emits one `[jev]` observability line (a worker with no observability block persists
 * nothing and reads as a broken feature -- the shadow-mode lesson from 09-19).
 */
export async function jevEval(
  env: Env,
  state: string,
  questions: Record<string, JevQuestion>,
  opts: { purpose?: string } = {},
): Promise<JevResult> {
  validateJevInput(state, questions);
  const t0 = Date.now();
  const purpose = opts.purpose ?? "unlabelled";
  try {
    // `typesafe/jev` is a third-party Workers AI model; the workers-types model union lags the
    // catalogue, so the model id is cast rather than the whole binding.
    type JevPayload = { model?: string; answers?: Record<string, JevAnswer>; usage?: unknown };
    const raw = await env.AI.run(JEV_MODEL as never, { state, questions } as never) as unknown as
      JevPayload & { state?: string; result?: JevPayload; gatewayMetadata?: unknown };
    const latency_ms = Date.now() - t0;
    // Through AI Gateway Unified Billing the binding returns an ENVELOPE, not the vendor payload:
    // `{ state: "Completed", result: { model, answers, usage }, gatewayMetadata }`. The docs page
    // shows only the inner payload. Read the envelope when present, the bare payload otherwise
    // (seen 2026-09-21: 667 live calls scored as `answers: {}` because of this one level).
    const payload: JevPayload = raw?.result && typeof raw.result === "object" ? raw.result : raw;
    const answers = payload?.answers ?? {};
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    if (missing.length > 0) {
      // A 200 with holes is a contract violation, not a soft miss; say so where a grep will find it.
      let raw_preview = "";
      try { raw_preview = JSON.stringify(raw).slice(0, 2000); } catch { raw_preview = String(raw).slice(0, 2000); }
      console.warn(`[jev] purpose=${purpose} answered=${Object.keys(answers).length}/${Object.keys(questions).length} missing=${missing.join(",")} latency_ms=${latency_ms} raw=${raw_preview.slice(0, 500)}`);
      return { model: payload?.model ?? JEV_MODEL, answers, latency_ms, usage: payload?.usage ?? null, raw_preview };
    } else {
      console.log(`[jev] purpose=${purpose} ok questions=${Object.keys(questions).length} state_chars=${state.length} latency_ms=${latency_ms} model=${payload?.model ?? "?"}`);
    }
    return { model: payload?.model ?? JEV_MODEL, answers, latency_ms, usage: payload?.usage ?? null };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    console.error(`[jev] purpose=${purpose} FAILED latency_ms=${latency_ms} error=${String(e).slice(0, 300)}`);
    throw e;
  }
}
