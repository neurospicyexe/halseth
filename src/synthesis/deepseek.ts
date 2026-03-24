// src/synthesis/deepseek.ts
//
// Thin DeepSeek V3 client. Synthesis clerk only -- not for companion use.
// Model: deepseek-chat (DeepSeek V3). Cheap, coherent, no identity needed.

import { Env } from "../types.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

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
        max_tokens: 800,
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

    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error("[synthesis:deepseek] exception:", e);
    return null;
  }
}
