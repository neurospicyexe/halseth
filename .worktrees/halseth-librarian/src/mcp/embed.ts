import { Env } from "../types.js";
import { generateId } from "../db/queries.js";

/**
 * Awaitable embed — use in backfill or any context where the response must not
 * return before Vectorize inserts complete (e.g. Cloudflare Workers lifecycle).
 * Throws on failure — caller decides how to handle.
 */
export async function embedAndStoreAsync(
  env: Env,
  text: string,
  table: string,
  rowId: string,
  companionId: string,
): Promise<void> {
  const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  }) as { data: number[][] };
  const vector = embedding.data[0];
  if (!vector) return;
  await env.VECTORIZE.insert([{
    id: generateId(),
    values: vector,
    metadata: { table, row_id: rowId, companion_id: companionId },
  }]);
}

/**
 * Fire-and-forget: embed text and store in Vectorize with table/row metadata.
 * Never throws — a Vectorize failure must never block the originating write.
 */
export function embedAndStore(
  env: Env,
  text: string,
  table: string,
  rowId: string,
  companionId: string,
): void {
  void (async () => {
    try {
      const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [text],
      }) as { data: number[][] };
      const vector = embedding.data[0];
      if (!vector) return;
      await env.VECTORIZE.insert([{
        id: generateId(),
        values: vector,
        metadata: { table, row_id: rowId, companion_id: companionId },
      }]);
    } catch (err) {
      // Never throws — the row is already safely persisted in D1.
      // Log so failures surface in Cloudflare Workers logs / wrangler tail.
      console.error("[embedAndStore] failed", { table, rowId, companionId, err: String(err) });
    }
  })();
}
