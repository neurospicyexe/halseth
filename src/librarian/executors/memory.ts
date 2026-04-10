import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  semanticSearch, filteredRecall, recentPatterns,
  sbRead, sbList, sbSaveDocument, sbLogObservation, sbSynthesizeSession, sbSaveStudy,
  sbFileChunks,
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

// Parse inline vault args from the request string when context field is absent.
// Handles the natural companion format: "save to vault: path=some/path.md content=# Document..."
// The path token ends at the first " content=" boundary. Content is everything after.
// Returns null if the inline format is not detectable (no " content=" present).
function parseInlineVaultArgs(request: string): { path?: string; content: string } | null {
  const lower = request.toLowerCase();
  const contentMarker = " content=";
  const contentIdx = lower.indexOf(contentMarker);
  if (contentIdx === -1) return null;

  const content = request.slice(contentIdx + contentMarker.length).trim();
  if (!content) return null;

  const pathMatch = request.slice(0, contentIdx).match(/\bpath=(\S+)/i);
  const path = pathMatch ? pathMatch[1] : undefined;

  return { path, content };
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

export async function execSbFileChunks(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ filename: string; limit?: number }>(ctx.req.context);
  // Extract filename from context or from the request string after trigger phrase
  const filename = p?.filename ?? ctx.req.request.replace(/^(read file|show file|file chunks|show chunks from|read chunks from|get file)[:\s]*/i, "").trim();
  if (!filename) return { response_key: "witness", witness: "sb_file_chunks requires a filename (e.g. 'Calethian2.md')" };
  const result = await sbFileChunks(ctx.env, filename, p?.limit);
  return { data: result ? truncateRaw(stripEmbeddings(result)) : "No chunks found.", meta: { operation: "sb_file_chunks" } };
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
  const p = parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(ctx.req.context)
    ?? parseInlineVaultArgs(ctx.req.request);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_document requires { content } in context or inline as 'path=<path> content=<text>'" };
  if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
  const r = await sbSaveDocument(ctx.env, { ...p, content_type: "document" });
  return { ack: r.ack, response: r.response };
}

export async function execSbSaveNote(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(ctx.req.context)
    ?? parseInlineVaultArgs(ctx.req.request);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_note requires { content } in context or inline as 'path=<path> content=<text>'" };
  if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
  const r = await sbSaveDocument(ctx.env, { ...p, content_type: "note" });
  return { ack: r.ack, response: r.response };
}

export async function execSbLogObservation(ctx: ExecutorContext): Promise<ExecutorResult> {
  const structured = parseContext<{ content: string; tags?: string[] }>(ctx.req.context);
  // Fallback: use the request string directly as the observation content (companions naturally
  // write "log observation: <text>" -- strip any leading trigger phrase).
  const inlineContent = ctx.req.request.replace(/^(log observation|note observation|observe|inbox observation)[:\s]*/i, "").trim() || null;
  const content = structured?.content ?? inlineContent;
  if (!content) return { response_key: "witness", witness: "sb_log_observation requires { content } in context or inline text after the trigger phrase" };
  const r = await sbLogObservation(ctx.env, content, structured?.tags);
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
