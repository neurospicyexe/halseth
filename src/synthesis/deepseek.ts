// src/synthesis/deepseek.ts
//
// Thin DeepSeek client. Synthesis clerk only -- not for companion use.
// Cheap, coherent, no identity needed.

import { Env } from "../types.js";

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

export async function complete(
  systemPrompt: string,
  userPrompt: string,
  env: Env,
): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) {
    console.error("[synthesis:deepseek] DEEPSEEK_API_KEY not set");
    return null;
  }

  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: contentBudget(800),
        temperature: 0.3, // low temp -- assembly work, not creativity
      }),
    });

    if (!res.ok) {
      console.error(`[synthesis:deepseek] HTTP ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      console.error("[synthesis:deepseek] API error:", data.error.message);
      return null;
    }

    const content = data.choices?.[0]?.message?.content ?? null;
    // Empty content on a reasoning model means the thought consumed the whole budget. Return
    // null (not "") so callers treat it as a failed call rather than writing an empty summary.
    if (!content?.trim()) {
      const choice = (data.choices?.[0] ?? {}) as { finish_reason?: string };
      console.error(
        `[synthesis:deepseek] empty content (finish=${choice.finish_reason ?? "?"}, model=${MODEL}) -- ` +
        `if finish=length, raise REASONING_HEADROOM (currently ${REASONING_HEADROOM})`,
      );
      return null;
    }
    return content;
  } catch (e) {
    console.error("[synthesis:deepseek] exception:", e);
    return null;
  }
}
