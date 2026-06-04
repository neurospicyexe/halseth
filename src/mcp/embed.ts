import { Env } from "../types.js";

/**
 * Single source of truth for the embedding model. The query side
 * (halseth_semantic_query in mcp/tools/memory.ts) MUST use this same constant --
 * stored and query vectors have to live in the same embedding space or recall
 * silently returns garbage. Swap the model here, in one place, then rebuild.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/**
 * Deterministic vector id so re-embedding a row REPLACES its vector instead of
 * accumulating a new one. This is what makes the Vectorize index rebuildable:
 * D1 is the source of truth, the index is disposable and regenerable. Running
 * the backfill/rebuild twice converges to the same state.
 */
export function vectorId(table: string, rowId: string): string {
  return `${table}:${rowId}`;
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  const embedding = await env.AI.run(EMBEDDING_MODEL, {
    text: [text],
  }) as { data: number[][] };
  return embedding.data[0] ?? null;
}

/**
 * Awaitable embed — use in backfill/rebuild or any context where the response
 * must not return before Vectorize writes complete (Cloudflare Workers lifecycle).
 * Throws on failure — caller decides how to handle. Idempotent: deterministic id
 * + upsert means re-running replaces rather than duplicates.
 */
export async function embedAndStoreAsync(
  env: Env,
  text: string,
  table: string,
  rowId: string,
  companionId: string,
): Promise<void> {
  const vector = await embed(env, text);
  if (!vector) return;
  await env.VECTORIZE.upsert([{
    id: vectorId(table, rowId),
    values: vector,
    metadata: { table, row_id: rowId, companion_id: companionId },
  }]);
}

export interface EmbedItem {
  text: string;
  table: string;
  rowId: string;
  companionId: string;
}

/**
 * Batched embed + upsert: one AI.run call for the whole array, one VECTORIZE.upsert.
 * Both Workers AI (bge) and Vectorize accept arrays, so a 50-row batch costs 2
 * subrequests instead of 100. This is what makes a full rebuild feasible -- a
 * per-row loop blows Cloudflare's per-request subrequest limit on large tables
 * (e.g. companion_journal). Idempotent via deterministic ids. Returns count stored.
 */
export async function embedAndStoreBatch(env: Env, items: EmbedItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const embedding = await env.AI.run(EMBEDDING_MODEL, {
    text: items.map((i) => i.text),
  }) as { data: number[][] };
  const vectors = items
    .map((it, idx) => {
      const values = embedding.data[idx];
      if (!values) return null;
      return {
        id: vectorId(it.table, it.rowId),
        values,
        metadata: { table: it.table, row_id: it.rowId, companion_id: it.companionId },
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
  if (vectors.length === 0) return 0;
  await env.VECTORIZE.upsert(vectors);
  return vectors.length;
}

/**
 * Fire-and-forget: embed text and store in Vectorize with table/row metadata.
 * Never throws — a Vectorize failure must never block the originating write.
 * Idempotent via deterministic id + upsert.
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
      const vector = await embed(env, text);
      if (!vector) return;
      await env.VECTORIZE.upsert([{
        id: vectorId(table, rowId),
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
