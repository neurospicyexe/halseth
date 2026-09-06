// src/librarian/repeat-breaker.ts
//
// 2026-09-05: Drevan issued the byte-identical retrieval request ("search vault for vevan
// vethmerin") 161 times in one Hermes agent turn, and a byte-identical file read 62 times in
// another -- each running to Hermes's 150-turn cap. Hermes's own loop guard only tracks a
// hard-coded list of built-in idempotent tools and requires identical RESULTS to fire; ours
// never produces identical results because the novelty pool rotates, so it never tripped.
//
// This breaker lives on our side of the fence and is keyed on the REQUEST, not the result --
// a rotating result is not evidence retrieval is making progress, it's evidence the search
// keeps running. It governs retrieval only. Lifecycle and write requests legitimately repeat
// every turn (e.g. "open my session") and must never be throttled here.

/**
 * Retrieval-family pattern keys the breaker governs. Deliberately narrow: every entry here is a
 * pure READ against Second-Brain/vault/vector storage, where a rotating novelty pool or semantic
 * re-ranking means repeating the exact same request can return a different-looking payload
 * without the answer having changed. General Halseth D1 reads (get_tasks, feelings_read,
 * journal_search, ...) are cheap, legitimately polled every turn by orient-adjacent flows, and
 * are excluded -- as are session lifecycle (open/load/close/orient) and every write/log/save
 * pattern, all of which are expected to repeat.
 */
export const RETRIEVAL_PATTERN_KEYS: Set<string> = new Set([
  // Obsidian vault / Second-Brain semantic search and browsing (executors/memory.ts).
  "sb_search",
  "sb_search_by_tags",
  "sb_file_chunks",
  "sb_recall",
  "sb_list",
  "sb_read",
  "sb_recent_patterns",
  "book_read",

  // Companion's own continuity-note recall by meaning -- a different substrate from sb_search
  // (vault) but the same shape: a meaning-weighted retrieval that can look different call to
  // call without the underlying answer changing.
  "notes_recall_meaning",
]);

export function isRetrievalPattern(patternKey: string): boolean {
  return RETRIEVAL_PATTERN_KEYS.has(patternKey);
}

export const REPEAT_WINDOW_SECONDS = 600;
export const REPEAT_LIMIT = 4;

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeRequest(request: string): string {
  return request
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

export async function repeatKey(companionId: string, request: string): Promise<string> {
  const normalized = normalizeRequest(request);
  const hash = await sha256hex(normalized);
  return `loop:${companionId}:${hash}`;
}

export interface RepeatCheck {
  repeats: number;
  blocked: boolean;
}

let warnedOnKvFailure = false;

export async function checkAndCount(kv: KVNamespace, key: string): Promise<RepeatCheck> {
  try {
    const raw = await kv.get(key, "json") as { count?: number } | null;
    const count = (raw?.count ?? 0) + 1;
    await kv.put(key, JSON.stringify({ count }), { expirationTtl: REPEAT_WINDOW_SECONDS });
    return { repeats: count, blocked: count >= REPEAT_LIMIT };
  } catch (e) {
    // A broken KV must never mute retrieval -- fail open, warn once per isolate so a sustained
    // outage doesn't spam logs on every single request.
    if (!warnedOnKvFailure) {
      warnedOnKvFailure = true;
      console.warn(`[librarian] repeat-breaker KV error (failing open): ${e instanceof Error ? e.message : String(e)}`);
    }
    return { repeats: 0, blocked: false };
  }
}

export function breakerResponse(repeats: number, patternKey: string): Record<string, unknown> {
  return {
    response_key: "witness",
    witness: `You have sent the Librarian this exact request ${repeats} times in the last 10 minutes. Retrieval is not going to change the answer. Stop searching and reply now from what you already hold; if it is genuinely missing, say so plainly.`,
    loop_guard: { repeats, pattern: patternKey, window_seconds: REPEAT_WINDOW_SECONDS },
  };
}
