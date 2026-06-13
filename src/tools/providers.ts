// src/tools/providers.ts
//
// Companion tool layer (inspo-takes-2026-06-13 take 14) -- PURE part.
// The provider INTERFACE plus the pure, unit-testable helpers: result normalizers,
// R2 key derivation, audit-arg summaries, and the per-companion gate decision.
// No network, no env, no I/O lives here -- the live Tavily/Gemini impls are in
// live-providers.ts (constructed from env at the call site, mockable in tests).

// ── Tool result types ─────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

export interface GeneratedImage {
  bytes: ArrayBuffer;
  mimeType: string;
  prompt: string;
}

/** The two-tool surface. Live impls in live-providers.ts; a mock satisfies this in tests. */
export interface ToolProvider {
  name: string;
  webSearch(query: string, maxResults: number): Promise<SearchResult[]>;
  generateImage(prompt: string): Promise<GeneratedImage>;
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

const SNIPPET_MAX = 500;

/**
 * Normalize Tavily's `{ results: [{ title, url, content, score }] }` into our bounded
 * SearchResult shape. Defensive: tolerates missing fields, non-array results, null.
 * Drops entries with no url (nothing to cite). Caps to `max` and truncates snippets.
 */
export function normalizeTavilyResults(raw: unknown, max: number): SearchResult[] {
  const results = (raw as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= max) break;
    const row = r as Record<string, unknown>;
    const url = typeof row["url"] === "string" ? (row["url"] as string).trim() : "";
    if (!url) continue; // no citation target -> useless
    const title = typeof row["title"] === "string" && (row["title"] as string).trim()
      ? (row["title"] as string).trim()
      : "(untitled)";
    const snippetRaw = typeof row["content"] === "string" ? (row["content"] as string) : "";
    const score = typeof row["score"] === "number" && Number.isFinite(row["score"] as number)
      ? (row["score"] as number)
      : 0;
    out.push({ title: title.slice(0, 300), url, snippet: snippetRaw.slice(0, SNIPPET_MAX), score });
  }
  return out;
}

/** image/* -> file extension. Unknown -> png (the safe inline default). */
export function extImageMime(mimeType: string | null | undefined): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/jpg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "png";
  }
}

/** Deterministic R2 key for a generated image: tool-images/<companion>/<callId>.<ext>. */
export function imageKeyFor(companionId: string, callId: string, mimeType: string | null | undefined): string {
  return `tool-images/${companionId}/${callId}.${extImageMime(mimeType)}`;
}

/** Short, bounded human summary of a tool invocation's input -- for the audit log. */
export function summarizeArgs(tool: "web_search" | "generate_image", input: string): string {
  const label = tool === "web_search" ? "query" : "prompt";
  return `${label}: ${input}`.slice(0, 220);
}

/**
 * Per-companion gate decision. An explicit companion_settings 'tools_enabled' row wins:
 * only the literal string "true" (case/space tolerant) enables; any other present value
 * disables. Absence of the row falls back to the deploy-time env default.
 */
export function toolsEnabled(setting: string | null | undefined, envDefault: boolean): boolean {
  if (setting === null || setting === undefined) return envDefault;
  return setting.trim().toLowerCase() === "true";
}
