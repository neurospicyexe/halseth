import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  semanticSearch, filteredRecall, recentPatterns,
  sbRead, sbList, sbSaveDocument, sbLogObservation, sbSynthesizeSession, sbSaveStudy,
} from "../backends/second-brain.js";
import { truncateRaw } from "../response/budget.js";

// Validate vault paths: allow alphanumeric, slash, hyphen, underscore, dot, space.
// Block path traversal (.. segments) and absolute paths.
function isValidVaultPath(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.includes("..")) return false;
  if (path.startsWith("/")) return false;
  return /^[a-zA-Z0-9/_\-. ]+$/.test(path);
}

// Strip embedding float arrays from Second Brain chunk responses before returning to companions.
// sb_search returns { chunks: [{ chunk_text, embedding: [...], ... }] } -- embeddings are useless
// to companions and inflate response size by ~100x. Parse, strip, re-serialize, fall back on error.
function stripEmbeddings(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { chunks?: Array<Record<string, unknown>> };
    if (parsed?.chunks && Array.isArray(parsed.chunks)) {
      for (const chunk of parsed.chunks) {
        delete chunk.embedding;
      }
      return JSON.stringify(parsed);
    }
  } catch {
    // not parseable JSON -- return as-is
  }
  return raw;
}

export async function execSbSearch(ctx: ExecutorContext): Promise<ExecutorResult> {
  const query = parseContext<{ query: string }>(ctx.req.context)?.query ?? ctx.req.request;
  const result = await semanticSearch(ctx.env, query);
  return { data: result ? truncateRaw(stripEmbeddings(result)) : "No results.", meta: { operation: "sb_search" } };
}

export async function execSbRecall(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ companion?: string; content_type?: string; limit?: number }>(ctx.req.context);
  const result = await filteredRecall(ctx.env, { companion: p?.companion ?? ctx.req.companion_id, content_type: p?.content_type, limit: p?.limit });
  return { data: result ? truncateRaw(stripEmbeddings(result)) : "No results.", meta: { operation: "sb_recall" } };
}

export async function execSbRecentPatterns(ctx: ExecutorContext): Promise<ExecutorResult> {
  const result = await recentPatterns(ctx.env);
  return { data: result ? truncateRaw(result) : "No patterns found.", meta: { operation: "sb_recent_patterns" } };
}

export async function execSbRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ path: string; query?: string }>(ctx.req.context);
  if (!p?.path) return { response_key: "witness", witness: "sb_read requires { path } in context" };
  if (!isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
  const result = await sbRead(ctx.env, p.path, p.query);
  return { data: result ? truncateRaw(result) : "Not found.", meta: { operation: "sb_read" } };
}

export async function execSbList(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ path?: string }>(ctx.req.context);
  const result = await sbList(ctx.env, p?.path);
  return { data: result ? truncateRaw(result) : "Empty.", meta: { operation: "sb_list" } };
}

export async function execSbSaveDocument(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(ctx.req.context);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_document requires { content } in context" };
  if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
  const r = await sbSaveDocument(ctx.env, { ...p, content_type: "document" });
  return { ack: r.ack, response: r.response };
}

export async function execSbSaveNote(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(ctx.req.context);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_note requires { content } in context" };
  if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
  const r = await sbSaveDocument(ctx.env, { ...p, content_type: "note" });
  return { ack: r.ack, response: r.response };
}

export async function execSbLogObservation(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; tags?: string[] }>(ctx.req.context);
  if (!p?.content) return { response_key: "witness", witness: "sb_log_observation requires { content } in context" };
  const r = await sbLogObservation(ctx.env, p.content, p.tags);
  return { ack: r.ack };
}

export async function execSbSynthesizeSession(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ session_id: string }>(ctx.req.context);
  if (!p?.session_id) return { response_key: "witness", witness: "sb_synthesize_session requires { session_id } in context" };
  const r = await sbSynthesizeSession(ctx.env, p.session_id);
  return { ack: r.ack };
}

export async function execSbSaveStudy(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; subject?: string; tags?: string[] }>(ctx.req.context);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_study requires { content } in context" };
  // subject is not a file path -- no traversal validation needed
  const r = await sbSaveStudy(ctx.env, p);
  return { ack: r.ack, response: r.response };
}
