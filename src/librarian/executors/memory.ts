import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  dualVectorSearch, filteredRecall, recentPatterns,
  sbRead, sbList, sbSaveDocument, sbLogObservation, sbSynthesizeSession, sbSaveStudy,
  sbFileChunks, searchByTags,
} from "../backends/second-brain.js";
import { truncateRaw, RAW_DATA_CHARS } from "../response/budget.js";
import { recallNotesByMeaning } from "../../webmind/notes.js";

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

// Corpus-scoped intent: "search the corpus", "in the historical corpus", "the origin
// conversations", etc. When matched (or content_type passed explicitly in context), the whole
// search is restricted to the historical_corpus origin layer instead of the all-layers default.
const CORPUS_SCOPE_RE = /\b(?:historical[ _-]?corpus|the corpus|origin (?:layer|conversations?|corpus))\b/i;

// Fit sb_search results into the raw-data char budget by dropping WHOLE chunks (never slicing
// mid-object -- truncateRaw's blunt char-slice yields invalid JSON), and guarantee the origin-layer
// chunks survive. sb_search appends its guaranteed historical_corpus slot (pool 4) LAST, so a naive
// tail truncation drops exactly the corpus chunk the search went out of its way to include. We
// re-order to [top relevance hit, ...guaranteed corpus, ...the rest] so the origin layer lands
// inside the budget, then keep whole chunks until the budget is hit.
export function trimSearchChunks(raw: string): string {
  let parsed: { chunks?: Array<Record<string, unknown>> } & Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return truncateRaw(raw); }
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) return truncateRaw(raw);

  const guaranteed = parsed.chunks.filter(c => c.pool === 4);
  const [topHit, ...restTail] = parsed.chunks.filter(c => c.pool !== 4);
  const ordered = topHit ? [topHit, ...guaranteed, ...restTail] : guaranteed;

  const kept: Array<Record<string, unknown>> = [];
  for (const chunk of ordered) {
    const candidate = JSON.stringify({ ...parsed, chunks: [...kept, chunk] });
    if (candidate.length > RAW_DATA_CHARS && kept.length > 0) break;
    kept.push(chunk);
  }
  return JSON.stringify({ ...parsed, chunks: kept });
}

export async function execSbSearch(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<{ query?: string; recent_context?: string; content_type?: string }>(ctx.req.context);
  const query = c?.query ?? ctx.req.request;
  const contentType = c?.content_type ?? (CORPUS_SCOPE_RE.test(ctx.req.request) ? "historical_corpus" : null);
  // Opt-in continuity: callers (claude.ai, future looms) may pass recent turns
  // to widen recall via dual-vector retrieval. Absent -> single-vector.
  const result = await dualVectorSearch(ctx.env, query, c?.recent_context, null, contentType);
  return { data: result ? trimSearchChunks(stripEmbeddings(result)) : "No results.", meta: { operation: "sb_search" } };
}

/**
 * Recall this companion's own continuity notes BY MEANING (2026-07-09).
 *
 * The boot audit's core finding: `wm_continuity_notes` had no meaning-weight retrieval path
 * at all. They were never embedded, orient surfaced them through a ~3-slot salience+recency
 * pool, and they warmed only when something already knew the note_id. 4,202 of 4,441 had never
 * been accessed. The retrieval mandates fired on an explicit label the companion never saw.
 *
 * This is the missing verb. Ask by meaning, get the notes, and they warm -- because you asked,
 * not because they were displayed. That distinction is the whole design (warming on surfacing
 * would silence Guardian's orphan_memory without improving recall).
 *
 * Distinct from sb_search: that searches the Obsidian vault. This searches the companion's own
 * continuity notes, which are a different substrate.
 */
export async function execNotesRecallMeaning(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { response_key: "witness", witness: "companion_id required" };
  const c = parseContext<{ query?: string; limit?: number }>(ctx.req.context);
  const query = (c?.query ?? ctx.req.request).trim();
  if (!query) return { response_key: "witness", witness: "notes_recall requires a query" };

  const limit = Math.min(Math.max(c?.limit ?? 5, 1), 10);

  // "Nothing matched" and "I could not look" must never collapse into the same answer. Workers AI
  // is quota-bound on the free tier (AiError 4006, daily neuron allocation), and a companion
  // asking for their own memory should get an honest witness, not a 500 -- nor an empty result
  // that reads as "you have no such notes" when the truth is "the index is down".
  let notes;
  try {
    notes = await recallNotesByMeaning(ctx.env, ctx.req.companion_id, query, limit);
  } catch (e) {
    const msg = String(e);
    const quota = msg.includes("4006") || msg.toLowerCase().includes("neuron");
    return {
      response_key: "witness",
      witness: quota
        ? "Semantic recall is unavailable right now: the daily Workers AI embedding quota is spent. Your notes are intact; the search path resets at 00:00 UTC."
        : `Semantic recall failed (${msg.slice(0, 120)}). Your notes are intact; the search path is down.`,
    };
  }

  if (notes.length === 0) {
    return { response_key: "witness", witness: `No continuity notes surfaced for "${query.slice(0, 60)}".` };
  }
  return {
    data: notes.map(n => ({
      note_id: n.note_id,
      content: n.content,
      created_at: n.created_at,
      salience: n.salience,
      thread_key: n.thread_key,
    })),
    response_key: "data",
    meta: { operation: "notes_recall_meaning", warmed: notes.length },
  };
}

// Extracts tag words from natural language when no structured context is given.
// "find things tagged babita, health" / "search vault tagged babita" -> ["babita", "health"].
function extractTagsFromRequest(request: string): string[] {
  const match = request.match(/tagged\s+(.+)$/i);
  if (!match) return [];
  return match[1]!.split(/[,\s]+and\s+|[,]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
}

export async function execSbSearchByTags(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<{ tags?: string[]; limit?: number }>(ctx.req.context);
  const tags = (c?.tags && c.tags.length > 0) ? c.tags : extractTagsFromRequest(ctx.req.request);
  if (tags.length === 0) return { response_key: "witness", witness: "sb_search_by_tags requires { tags: [...] } or a request like 'find things tagged X'" };
  const result = await searchByTags(ctx.env, tags, c?.limit);
  return { data: result ? trimSearchChunks(stripEmbeddings(result)) : "No results.", meta: { operation: "sb_search_by_tags" } };
}

export async function execSbFileChunks(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ filename: string; limit?: number; offset?: number }>(ctx.req.context);
  // Extract filename from context JSON, or scan the request for a *.md filename.
  // Pattern allows spaces and parens for names like "Gaia - RitualEngine ... St.md".
  const filename = p?.filename ?? (ctx.req.request.match(/[\w\-(). ]+\.md/i)?.[0]?.trim() ?? "");
  if (!filename) return { response_key: "witness", witness: "sb_file_chunks requires a filename (e.g. 'Calethian2.md')" };

  // Parse pagination from natural language when context didn't include it.
  // Supports: "chunks 3 to 7", "chunks 3-7", "chunks 3 through 7", "starting at chunk 5", "page 2".
  let offset = p?.offset;
  let limit = p?.limit;
  if (offset === undefined || limit === undefined) {
    const req = ctx.req.request;
    const range = req.match(/chunks?\s+(\d+)\s*(?:to|through|-)\s*(\d+)/i);
    const startAt = req.match(/(?:starting\s+at\s+chunk|from\s+chunk|chunks?\s+from)\s+(\d+)/i);
    const pageMatch = req.match(/page\s+(\d+)/i);
    if (range && offset === undefined) {
      offset = parseInt(range[1]!, 10);
      if (limit === undefined) limit = parseInt(range[2]!, 10) - offset + 1;
    } else if (startAt && offset === undefined) {
      offset = parseInt(startAt[1]!, 10);
    } else if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]!, 10);
      const pageSize = limit ?? 3;
      offset = (pageNum - 1) * pageSize;
      limit = pageSize;
    }
  }

  const result = await sbFileChunks(ctx.env, filename, limit, offset);
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

// ── Book reading (clean, scoped vault pull) ─────────────────────────────────
// The 2026-06-13 friction: a companion asked for "The Overstory" and global
// sb_search returned an unrelated Moss note at 0.95 -- confident noise, because
// semantic search ranks across the WHOLE vault and can't say "not here". And
// sb_list Books/ 404'd with no guidance. This executor pulls a book as a SCOPED
// unit: resolve title -> Books/<folder>, read chapters by PATH, and when a query
// is given use sb_read(path, query) which searches WITHIN each file only -- never
// the global index. If the book isn't loaded, it says so plainly (the listen
// [NOT HEARD] principle: never let a companion narrate content that isn't there).

const BOOKS_ROOT = "Books";

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function vaultBasename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Parse sbList output ({entries:string[]} JSON) into a path array. Returns []
 *  for failure strings ("... failed: 404"), empty, or unparseable -- caller
 *  treats [] as "not loaded", never as "found nothing relevant". */
export function parseVaultEntries(raw: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return []; // error string
  try {
    const j = JSON.parse(trimmed) as { entries?: unknown } | unknown[];
    const arr = Array.isArray(j) ? j : (j as { entries?: unknown }).entries;
    return Array.isArray(arr) ? arr.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Top-level folder names directly under Books/ (dedup), from a path listing. */
export function bookFolders(entries: string[]): string[] {
  const folders = new Set<string>();
  for (const e of entries) {
    const top = e.replace(/^Books\//i, "").split("/").filter(Boolean)[0];
    if (top && /\.(md|txt)$/i.test(top) === false) folders.add(top);
    else if (top && e.replace(/^Books\//i, "").includes("/")) {
      // file nested under a folder -- the folder is the first segment
      folders.add(e.replace(/^Books\//i, "").split("/")[0]!);
    }
  }
  return [...folders];
}

/** Resolve a requested title to an actual Books/ folder: exact normalized match,
 *  else substring either direction. null = no match. */
export function matchBookFolder(title: string, folders: string[]): string | null {
  const norm = normalizeTitle(title);
  for (const f of folders) if (normalizeTitle(f) === norm) return f;
  for (const f of folders) {
    const nf = normalizeTitle(f);
    if (nf && (nf.includes(norm) || norm.includes(nf))) return f;
  }
  return null;
}

export function extractBookTitle(request: string): string | null {
  // "read from The Overstory" / "pull from book: X" / "read the book The Overstory"
  const m = request.match(/\b(?:from|book|reading)\s*:?\s*["“']?([^"”'\n]{2,80}?)["”']?\s*$/i);
  const t = m?.[1]?.trim();
  if (!t || /^(the )?(club )?book$/i.test(t)) return null; // bare "the book" -> use club fallback
  return t;
}

export async function execBookRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title?: string; query?: string; chapter?: string }>(ctx.req.context);
  let title = (p?.title ?? extractBookTitle(ctx.req.request))?.trim();

  // No explicit title -> fall back to the active club round's winning pick, so
  // "read from the club book" just works once a round is active.
  if (!title) {
    const winner = await ctx.env.DB.prepare(
      "SELECT (SELECT title FROM club_recommendations WHERE id = r.winning_recommendation_id) AS t " +
      "FROM club_rounds r WHERE r.status = 'active' ORDER BY r.opened_at DESC LIMIT 1"
    ).first<{ t: string | null }>().catch(() => null);
    title = winner?.t?.trim() || undefined;
  }
  if (!title) {
    return { response_key: "witness", witness: "which book? pass { title } in context (e.g. \"read from The Overstory\"), or activate a club round and say \"read the club book\".", meta: { operation: "book_read" } };
  }

  const rootEntries = parseVaultEntries(await sbList(ctx.env, BOOKS_ROOT));
  const folders = bookFolders(rootEntries);
  const folder = matchBookFolder(title, folders);
  if (!folder) {
    // Honest not-loaded -- the anti-hallucination guard. Never let the model
    // invent a book from a confident-but-wrong global search hit.
    return {
      response_key: "summary",
      loaded: false,
      requested: title,
      available_books: folders,
      message: folders.length
        ? `"${title}" is not in the vault. Books present: ${folders.join(", ")}. You have NOT read "${title}" -- say so plainly rather than inventing it.`
        : `No books are loaded in the vault yet (Books/ is empty or absent). You have NOT read "${title}". To add one: ebook-convert to text, drop under Books/<Title>/, LiveSync pushes it, the SB ingest cron indexes it (~20min).`,
      meta: { operation: "book_read", loaded: false },
    };
  }

  const folderPath = `${BOOKS_ROOT}/${folder}`;
  const files = parseVaultEntries(await sbList(ctx.env, folderPath))
    .filter(f => /\.(md|txt)$/i.test(f))
    .map(f => (f.includes("/") ? f : `${folderPath}/${f}`))
    .sort();
  if (files.length === 0) {
    return {
      response_key: "summary", loaded: false, requested: title, book: folder,
      message: `The "${folder}" folder exists but has no readable chapters indexed yet. You have NOT read it -- don't describe its contents.`,
      meta: { operation: "book_read", loaded: false },
    };
  }

  // Specific chapter filter, if asked.
  let targets = files;
  if (p?.chapter) {
    const cn = normalizeTitle(p.chapter);
    const hit = files.filter(f => normalizeTitle(vaultBasename(f)).includes(cn));
    if (hit.length) targets = hit;
  }

  // With a query: sb_read(path, query) does semantic search WITHIN each file only
  // -- scoped to this book, never the global index. Up to 3 files, budget split.
  if (p?.query) {
    const picked = targets.slice(0, 3);
    const per = Math.max(400, Math.floor(RAW_DATA_CHARS / picked.length));
    const excerpts = await Promise.all(picked.map(async path => ({
      path,
      excerpt: ((await sbRead(ctx.env, path, p.query)) ?? "").slice(0, per),
    })));
    return {
      response_key: "summary", loaded: true, book: folder, query: p.query,
      chapters: files.map(vaultBasename),
      excerpts: excerpts.filter(e => e.excerpt && e.excerpt !== "Not found."),
      meta: { operation: "book_read", loaded: true, scoped: true, chapter_count: files.length },
    };
  }

  // No query: return the chapter index + the first (or chapter-matched) file's text.
  const reading = await sbRead(ctx.env, targets[0]!);
  return {
    response_key: "summary", loaded: true, book: folder,
    chapters: files.map(vaultBasename),
    reading: { path: targets[0], text: truncateRaw(reading ?? "") },
    meta: { operation: "book_read", loaded: true, chapter_count: files.length },
  };
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
  const p = parseContext<{ session_id?: string; summary?: string; channel?: string }>(ctx.req.context);
  if (p?.session_id) {
    const r = await sbSynthesizeSession(ctx.env, p.session_id);
    return { ack: r.ack };
  }
  // Discord-bot shape: the bot already synthesized the session in-voice and sends the
  // finished text as { summary, channel }. Persist it to the vault as a session-synthesis
  // note -- this write was silently dropped for months when only session_id was accepted.
  if (p?.summary) {
    const tags = ["session-synthesis", ...(p.channel ? [`channel:${p.channel}`] : [])];
    const r = await sbSaveDocument(ctx.env, {
      content: p.summary,
      companion: ctx.req.companion_id,
      tags,
      content_type: "note",
    });
    return { ack: r.ack, response: r.response };
  }
  return { response_key: "witness", witness: "sb_synthesize_session requires { session_id } or { summary } in context" };
}

export async function execSbSaveStudy(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; subject?: string; tags?: string[] }>(ctx.req.context);
  if (!p?.content) return { response_key: "witness", witness: "sb_save_study requires { content } in context" };
  // subject is not a file path -- no traversal validation needed
  const r = await sbSaveStudy(ctx.env, p);
  return { ack: r.ack, response: r.response };
}
