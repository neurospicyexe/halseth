// src/tools/live-providers.ts
//
// Live impls of the ToolProvider interface (take 14). Thin network glue -- the pure,
// testable logic (normalizers, key derivation, gate) lives in providers.ts and is unit
// tested; these classes just do the fetch and hand raw payloads to those normalizers.
// Mockable by construction: the service takes a ToolProvider, so tests inject a fake.
//
// Keys are deploy-time secrets (TAVILY_API_KEY, GEMINI_API_KEY). A missing key throws,
// which the service catches and logs as an 'error' tool-call row (never a silent no-op).

import type { Env } from "../types.js";
import {
  type ToolProvider,
  type SearchResult,
  type GeneratedImage,
  normalizeTavilyResults,
} from "./providers.js";

const TAVILY_URL = "https://api.tavily.com/search";
// Image gen stays on /v1beta -- the `responseModalities` field below is a v1beta-only
// feature (stable /v1 rejects it with a 400). The old gemini-2.5-flash-image-preview
// default was deprecated (2026-06); gemini-2.5-flash-image (Nano Banana) is the
// current Flash-tier image model that supports the `responseModalities` parameter.
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Live provider: Tavily for web search, Gemini for image generation.
 * Constructed from env at the call site (createProvider). Each method throws on a
 * missing key or a non-OK response; the service turns that into an audited error row.
 */
export class LiveToolProvider implements ToolProvider {
  readonly name = "live";
  constructor(private env: Env) {}

  async webSearch(query: string, maxResults: number): Promise<SearchResult[]> {
    const key = this.env.TAVILY_API_KEY;
    if (!key) throw new Error("TAVILY_API_KEY is not configured");
    const resp = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
    if (!resp.ok) {
      throw new Error(`tavily ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const raw = await resp.json();
    return normalizeTavilyResults(raw, maxResults);
  }

  async generateImage(prompt: string): Promise<GeneratedImage> {
    const key = this.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not configured");
    const model = this.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
    const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (!resp.ok) {
      throw new Error(`gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json() as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find(p => p.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new Error("gemini returned no image data");
    return {
      bytes: base64ToArrayBuffer(inline.data),
      mimeType: inline.mimeType || "image/png",
      prompt,
    };
  }
}

/** Build the live provider from env. Swap-point if a second impl (Tavily->Google Search) lands. */
export function createProvider(env: Env): ToolProvider {
  return new LiveToolProvider(env);
}
