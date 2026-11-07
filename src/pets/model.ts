// B64 Sol mind: the one seam between pets/ and an inference provider (spec 9, portability).
//
// Everything in pets/ that needs a model takes a PetModel, so tests inject a fake and a future pet server
// swaps the provider without touching the sleep pass or the voice. halsethPetModel is Halseth's: the same
// vendor order as synthesis/deepseek.ts (DeepInfra first, direct DeepSeek only as the emergency lane),
// with a hard timeout. It does NOT go through complete(): that has no timeout and prepends the owner
// pronoun prose rule, which is noise on a JSON-only crow prompt.
import type { Env } from "../types.js";
import { contentBudget, logFellBack, vendorFailover, vendors } from "../synthesis/deepseek.js";

export interface PetModel {
  /** The content, or null on any failure (no key, timeout, HTTP error, empty answer). Never throws. */
  complete(system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string | null>;
}

/** True when Halseth has any inference key at all (the sleep pass skips without a D1 write otherwise). */
export function hasPetModel(env: Env): boolean {
  return vendors(env).length > 0;
}

export function halsethPetModel(env: Env, temperature: number): PetModel {
  return {
    async complete(system, user, maxTokens, timeoutMs) {
      const order = vendors(env);
      if (!order.length) return null;
      let priorFailure: string | null = null;
      for (const vendor of order) {
        if (priorFailure !== null && vendor.label === "DeepSeek") logFellBack("pets", priorFailure);
        try {
          const res = await fetch(vendor.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${vendor.key}` },
            body: JSON.stringify({
              model: vendor.model,
              messages: [{ role: "system", content: system }, { role: "user", content: user }],
              max_tokens: contentBudget(maxTokens),
              temperature,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            console.error(`[pets/model] ${vendor.label} HTTP ${res.status}`);
            if (!vendorFailover(res.status)) return null;
            priorFailure = `HTTP ${res.status}`;
            continue;
          }
          const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } };
          if (data.error) {
            priorFailure = `api error: ${String(data.error.message).slice(0, 80)}`;
            continue;
          }
          const content = data.choices?.[0]?.message?.content ?? null;
          // Empty content = the reasoning ate the budget; same weights would repeat it, so stop.
          return content && content.trim() ? content : null;
        } catch (e) {
          // A timeout is not retried on the next vendor: the night just waits for the next tick.
          if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
            console.error(`[pets/model] ${vendor.label} timed out after ${timeoutMs}ms`);
            return null;
          }
          priorFailure = `network: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`;
        }
      }
      return null;
    },
  };
}
