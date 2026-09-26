// src/synthesis/deepseek.ts
//
// Thin DeepSeek client. Synthesis clerk only -- not for companion use.
// Cheap, coherent, no identity needed.

import { Env } from "../types.js";
import { withOwnerPronounRule } from "../pronoun-rule.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

/**
 * Supported model + reasoning headroom (2026-07-28).
 *
 * Was `deepseek-chat`, which DeepSeek has DELISTED -- `GET /v1/models` returns exactly
 * `deepseek-v4-pro` and `deepseek-v4-flash`. The old alias still answers, which is why this
 * kept working, but "still answers while delisted" is precisely the state that produced the
 * 2026-07-27 outage: the worker sat on the same alias and started 400ing intermittently for a
 * day before anyone noticed. Two callers in this Worker were on it (here and the Librarian
 * classifier), so both moved to a listed model.
 *
 * Both listed models are REASONING models: reasoning tokens are billed against `max_tokens`
 * and emitted BEFORE any content, so a ceiling at or below the reasoning burn returns an empty
 * string with `finish_reason: "length"`. Every content ceiling therefore needs headroom on top.
 * Measured on flash with a classifier-shaped prompt: 60-117 reasoning tokens, 1.6-2.0s.
 *
 * Flash, not pro: this is assembly work, and the clerk wants cheap and fast.
 */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";
export const REASONING_HEADROOM = 3000;
/** Turn an intended CONTENT ceiling into a wire `max_tokens`. */
export const contentBudget = (contentTokens: number): number => contentTokens + REASONING_HEADROOM;

const MODEL = DEEPSEEK_DEFAULT_MODEL;

/** A status the SAME payload might survive on another vendor: auth flaps, an empty balance
 * (funds are per-vendor), rate limits, server errors. A 400 is deterministic -- the payload is
 * malformed on every vendor -- so it must NOT fail over: the weights are identical on both
 * lanes, so the same payload would fail again on DeepSeek and spend the emergency balance for
 * nothing. Canonical home (moved from librarian/router.ts, which re-exports it) so the
 * classifier and the synthesis clerk share one rule. */
export function vendorFailover(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/** The ONE log line every Halseth inference caller emits when a call drops onto direct
 * DeepSeek (2026-09-26, Raziel: DeepSeek-direct is a ~$10 EMERGENCY lane only). One stable
 * prefix so a single search -- `FELL BACK to direct DeepSeek` -- finds every drain across the
 * Worker's logs, and so a future health-check counter has exactly one string to match. */
export const FELL_BACK_TAG = "[inference] FELL BACK to direct DeepSeek";
export function logFellBack(caller: string, reason: string): void {
  console.warn(`${FELL_BACK_TAG} (DeepInfra failed: ${reason}) caller=${caller}`);
}

/** Vendor order for synthesis (2026-08-31): DeepInfra PRIMARY, DeepSeek-direct fallback.
 * The bots and the Librarian classifier moved to DeepInfra after the 2026-08 DeepSeek
 * repricing, but this module kept calling api.deepseek.com directly -- which is what kept
 * draining the DeepSeek platform balance. Same weights either way (DeepSeek-V4-Flash);
 * only the vendor changes. Exported for tests and for callers that need the order. */
export function vendors(env: Env): Array<{ url: string; key: string; model: string; label: string }> {
  const list: Array<{ url: string; key: string; model: string; label: string }> = [];
  if (env.DEEPINFRA_API_KEY) {
    list.push({
      url: "https://api.deepinfra.com/v1/openai/chat/completions",
      key: env.DEEPINFRA_API_KEY,
      model: "deepseek-ai/DeepSeek-V4-Flash-0731",
      label: "DeepInfra",
    });
  }
  if (env.DEEPSEEK_API_KEY) {
    list.push({ url: DEEPSEEK_URL, key: env.DEEPSEEK_API_KEY, model: MODEL, label: "DeepSeek" });
  }
  return list;
}

export interface CompleteOptions {
  /** CONTENT ceiling; reasoning headroom is added on top via contentBudget(). Default 800. */
  contentTokens?: number;
  /** Default 0.3 -- assembly work, not creativity. */
  temperature?: number;
  /** Log tag for the FELL BACK line. Default "synthesis". */
  caller?: string;
}

/** Returns the content, or null when every vendor failed. Fails over to the next vendor ONLY
 * on a vendorFailover() status or a network error; a 400 or an empty/starved answer stops the
 * chain, because the same weights would repeat it on DeepSeek and burn the emergency lane. */
export async function complete(
  systemPrompt: string,
  userPrompt: string,
  env: Env,
  opts: CompleteOptions = {},
): Promise<string | null> {
  const order = vendors(env);
  if (!order.length) {
    console.error("[synthesis:deepseek] no inference key set (DEEPINFRA_API_KEY / DEEPSEEK_API_KEY)");
    return null;
  }
  if (!env.DEEPINFRA_API_KEY) {
    console.warn("[synthesis:deepseek] DEEPINFRA_API_KEY absent -- running on direct DeepSeek ONLY (emergency lane)");
  }

  // Every caller of complete() writes prose that can reference Raziel (session summaries, daily
  // narratives, somatic snapshots, spiral synthesis) -- carry the owner pronoun rule on every call
  // rather than trusting each caller's own systemPrompt to include it (2026-09-24).
  const systemWithRule = withOwnerPronounRule(systemPrompt);
  const caller = opts.caller ?? "synthesis";
  let priorFailure: string | null = null;

  for (const vendor of order) {
    if (priorFailure !== null && vendor.label === "DeepSeek") logFellBack(caller, priorFailure);
    try {
      const res = await fetch(vendor.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${vendor.key}`,
        },
        body: JSON.stringify({
          model: vendor.model,
          messages: [
            { role: "system", content: systemWithRule },
            { role: "user",   content: userPrompt },
          ],
          max_tokens: contentBudget(opts.contentTokens ?? 800),
          temperature: opts.temperature ?? 0.3,
        }),
      });

      if (!res.ok) {
        console.error(`[synthesis:deepseek] ${vendor.label} HTTP ${res.status}: ${await res.text()}`);
        if (!vendorFailover(res.status)) return null; // deterministic -- would fail on every vendor
        priorFailure = `HTTP ${res.status}`;
        continue; // funds/quotas are per-vendor -- the other vendor may still answer
      }

      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message: string };
      };

      if (data.error) {
        console.error(`[synthesis:deepseek] ${vendor.label} API error:`, data.error.message);
        priorFailure = `api error: ${data.error.message.slice(0, 80)}`;
        continue;
      }

      const content = data.choices?.[0]?.message?.content ?? null;
      // Empty content on a reasoning model means the thought consumed the whole budget. Return
      // null (not "") so callers treat it as a failed call rather than writing an empty summary.
      // Not retried on the next vendor: same weights, same budget, same starvation.
      if (!content?.trim()) {
        const choice = (data.choices?.[0] ?? {}) as { finish_reason?: string };
        console.error(
          `[synthesis:deepseek] empty content (finish=${choice.finish_reason ?? "?"}, model=${vendor.model}) -- ` +
          `if finish=length, raise REASONING_HEADROOM (currently ${REASONING_HEADROOM})`,
        );
        return null;
      }
      return content;
    } catch (e) {
      console.error(`[synthesis:deepseek] ${vendor.label} exception:`, e);
      priorFailure = `network: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`;
    }
  }
  return null;
}
