// src/handlers/growth.ts
//
// HTTP route handlers for /mind/growth/* endpoints.
// Companion learning artifacts: journal entries, patterns, markers.
// Cap enforcement is per-companion: journal=200, patterns=50, markers=100.
// All routes require ADMIN_SECRET Bearer auth (enforced at index.ts level).
//
// Migration 0062 changes:
//   - growth_journal/patterns/markers all gained prehended_ids + vault_path columns.
//   - growth_journal gained evidence_json + novelty.
//   - postGrowthPattern is now a Jaccard-similarity UPSERT: same-companion pattern
//     with token overlap >= PATTERN_DEDUP_THRESHOLD merges into the existing row
//     (strength += 1, evidence/prehensions appended) instead of inserting a new row.
//     This is the "patterns accumulate weight" behavior the schema's strength
//     column was always meant to express.
//   - postGrowthMarker dedupes on (companion_id, marker_type, description).
//   - Marker type allowlist now includes 'thoughtform' for triad-level recurrence.
//   - PATCH /mind/growth/:kind/:id/vault sets vault_path after SB materializer
//     writes the .md file.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
const MAX_TEXT = 8000;

const JOURNAL_CAP = 200;
const PATTERNS_CAP = 50;
const MARKERS_CAP = 100;

// Jaccard threshold for pattern UPSERT. 0.5 = ~50% token overlap on the
// stop-word-stripped, lowercased pattern_text. Calibrated against realistic
// reflect-phase restatements: when the prompt shows the model an existing
// pattern and the model deepens it, the resulting pattern_text typically
// shares 5+ content words with the original. Distant paraphrases that
// share only a single word ("repair") will not merge -- by design, since
// token Jaccard cannot reliably distinguish "same idea, different words"
// from "different idea, coincidentally shares a word." The reflect prompt
// compensates by actively surfacing existing pattern_text to the model,
// nudging it toward restatement that does share vocabulary.
//
// Cross-companion thoughtforms use a tighter threshold (0.6, in triad.ts)
// since independent surfacing of the same shape from two companions is
// rare and should be unambiguous.
export const PATTERN_DEDUP_THRESHOLD = 0.5;

// Common English stop words and pattern-prefix noise stripped before
// Jaccard token comparison so structural overlap (the actual claim) wins
// over lexical filler.
const STOP_WORDS = new Set([
  "a", "an", "and", "or", "but", "the", "is", "are", "was", "were", "be",
  "been", "being", "to", "of", "in", "on", "at", "for", "with", "by", "as",
  "that", "this", "these", "those", "i", "me", "my", "you", "your", "we",
  "our", "it", "its", "they", "them", "their", "what", "when", "how", "why",
  "where", "if", "so", "because", "than", "then", "do", "does", "did", "have",
  "has", "had", "not", "no", "yes", "can", "will", "would", "should", "could",
  "pattern",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function optStr(val: unknown, max: number): string | null {
  return typeof val === "string" && val.trim() ? val.trim().slice(0, max) : null;
}

function safeJsonArray(val: unknown, fallback: unknown[] = []): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validateCompanion(id: unknown): id is string {
  return typeof id === "string" && VALID_COMPANIONS.has(id);
}

/**
 * Filter prehended_ids to the subset that actually exists in
 * growth_journal/patterns/markers. Silent strip of unknowns prevents
 * hallucinated UUIDs from a chatty model landing in the JSON column and
 * resolving to dangling wikilinks in the vault.
 *
 * One round-trip per write call (UNION across the three tables, expanded
 * placeholders), bounded at 32 ids by the caller's slice.
 */
export async function filterExistingIds(env: Env, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  // Dedupe + sanity-check shape before binding (bind is parameterized; this
  // is just an extra belt-and-suspenders guard against non-string ids).
  const clean = Array.from(new Set(ids.filter(id => typeof id === "string" && id.length > 0)));
  if (clean.length === 0) return [];
  const placeholders = clean.map(() => "?").join(",");
  const sql =
    `SELECT id FROM growth_journal  WHERE id IN (${placeholders}) ` +
    `UNION SELECT id FROM growth_patterns WHERE id IN (${placeholders}) ` +
    `UNION SELECT id FROM growth_markers  WHERE id IN (${placeholders})`;
  const r = await env.DB.prepare(sql)
    .bind(...clean, ...clean, ...clean)
    .all<{ id: string }>();
  const found = new Set((r.results ?? []).map(row => row.id));
  return clean.filter(id => found.has(id));
}

/** Enforce a per-companion row cap by deleting oldest rows when at limit. */
async function enforceCapOldest(
  env: Env,
  table: string,
  companion_id: string,
  cap: number,
): Promise<void> {
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${table} WHERE companion_id = ?`
  ).bind(companion_id).first<{ n: number }>();
  if (count && count.n >= cap) {
    await env.DB.prepare(
      `DELETE FROM ${table} WHERE id IN (
         SELECT id FROM ${table} WHERE companion_id = ? ORDER BY created_at ASC LIMIT ?
       )`
    ).bind(companion_id, count.n - cap + 1).run();
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

// POST /mind/growth/journal
export async function postGrowthJournal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.content !== "string" || !body.content.trim()) return json({ error: "content required" }, 400);
  if (body.content.toString().length > MAX_TEXT) return json({ error: `content too long (max ${MAX_TEXT})` }, 400);

  const valid_types = new Set(["learning", "insight", "connection", "question", "signal_audit"]);
  const entry_type = typeof body.entry_type === "string" && valid_types.has(body.entry_type)
    ? body.entry_type
    : "learning";
  const valid_sources = new Set(["autonomous", "conversation", "reflection"]);
  const source = typeof body.source === "string" && valid_sources.has(body.source)
    ? body.source
    : "autonomous";

  const valid_novelty = new Set(["new", "deepening", "recurring"]);
  const novelty = typeof body.novelty === "string" && valid_novelty.has(body.novelty)
    ? body.novelty
    : null;

  await enforceCapOldest(env, "growth_journal", body.companion_id as string, JOURNAL_CAP);

  const run_id = optStr(body.run_id, 64);
  const thread_id = optStr(body.thread_id, 128);
  const rawPrehended = safeJsonArray(body.prehended_ids).filter((x): x is string => typeof x === "string").slice(0, 32);
  const validPrehended = await filterExistingIds(env, rawPrehended);
  const prehended = JSON.stringify(validPrehended);
  const evidence  = JSON.stringify(safeJsonArray(body.evidence).slice(0, 16));

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO growth_journal
       (id, companion_id, entry_type, content, source, tags_json, run_id,
        thread_id, prehended_ids, evidence_json, novelty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    body.companion_id,
    entry_type,
    body.content,
    source,
    JSON.stringify(safeJsonArray(body.tags).slice(0, 8)),
    run_id,
    thread_id,
    prehended,
    evidence,
    novelty,
  ).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/growth/journal/:companion_id
// ?limit=N (max 100), ?pending=1 (only autonomous + awaiting review)
export async function getGrowthJournal(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const pendingOnly = url.searchParams.get("pending") === "1";

  const sql = pendingOnly
    ? "SELECT * FROM growth_journal WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending' ORDER BY created_at DESC LIMIT ?"
    : "SELECT * FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?";

  const rows = await env.DB.prepare(sql).bind(companion_id, limit).all();
  return json({ journal: rows.results });
}

async function setReviewStatus(
  env: Env,
  id: string,
  companion_id: string,
  status: "accepted" | "declined",
): Promise<Response> {
  const result = await env.DB.prepare(
    "UPDATE growth_journal SET review_status = ?, reviewed_at = datetime('now') WHERE id = ? AND companion_id = ? AND review_status = 'pending'"
  ).bind(status, id, companion_id).run();

  if (result.meta.changes === 0) {
    const row = await env.DB.prepare(
      "SELECT review_status, reviewed_at FROM growth_journal WHERE id = ? AND companion_id = ?"
    ).bind(id, companion_id).first<{ review_status: string; reviewed_at: string | null }>();
    if (!row) return json({ error: "entry not found" }, 404);
    return json({ ok: true, already_reviewed: true, review_status: row.review_status, reviewed_at: row.reviewed_at });
  }

  return json({ ok: true, already_reviewed: false, review_status: status });
}

// PATCH /mind/growth/journal/:id/accept
export async function acceptJournalEntry(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);

  return setReviewStatus(env, id, body.companion_id as string, "accepted");
}

// PATCH /mind/growth/journal/:id/decline
export async function declineJournalEntry(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);

  return setReviewStatus(env, id, body.companion_id as string, "declined");
}

// ---------------------------------------------------------------------------
// Patterns -- Jaccard-similarity UPSERT
// ---------------------------------------------------------------------------

/**
 * Find the most-similar existing pattern for this companion, if any clears
 * PATTERN_DEDUP_THRESHOLD. Used by postGrowthPattern to decide UPSERT vs INSERT.
 */
async function findSimilarPattern(
  env: Env,
  companion_id: string,
  pattern_text: string,
): Promise<{ id: string; pattern_text: string; strength: number; evidence_json: string; prehended_ids: string } | null> {
  const tokens = tokenize(pattern_text);
  if (tokens.size === 0) return null;

  // Pull recent patterns and Jaccard them in JS. Caps mean this set is <=50.
  const candidates = await env.DB.prepare(
    "SELECT id, pattern_text, strength, evidence_json, prehended_ids FROM growth_patterns WHERE companion_id = ? ORDER BY updated_at DESC LIMIT 50",
  ).bind(companion_id).all<{ id: string; pattern_text: string; strength: number; evidence_json: string; prehended_ids: string }>();

  let best: { row: typeof candidates.results[0]; score: number } | null = null;
  for (const row of candidates.results) {
    const score = jaccard(tokens, tokenize(row.pattern_text));
    if (score >= PATTERN_DEDUP_THRESHOLD && (best === null || score > best.score)) {
      best = { row, score };
    }
  }
  return best ? best.row : null;
}

// POST /mind/growth/patterns
export async function postGrowthPattern(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.pattern_text !== "string" || !body.pattern_text.trim()) return json({ error: "pattern_text required" }, 400);
  if (body.pattern_text.toString().length > MAX_TEXT) return json({ error: `pattern_text too long (max ${MAX_TEXT})` }, 400);

  const companion_id = body.companion_id as string;
  const pattern_text = body.pattern_text as string;
  const incomingEvidence  = safeJsonArray(body.evidence).slice(0, 16);
  const rawPrehended = safeJsonArray(body.prehended_ids).filter((x): x is string => typeof x === "string").slice(0, 32);
  const incomingPrehended = await filterExistingIds(env, rawPrehended);
  const incomingStrength  = typeof body.strength === "number"
    ? Math.max(1, Math.min(10, body.strength))
    : 1;
  const run_id = optStr(body.run_id, 64);

  // Try UPSERT path first.
  const existing = await findSimilarPattern(env, companion_id, pattern_text);
  if (existing) {
    const mergedEvidence  = mergeJsonArrays(existing.evidence_json,  incomingEvidence,  16);
    const mergedPrehended = mergeJsonArrays(existing.prehended_ids,  incomingPrehended, 32);
    const newStrength = Math.min(10, (existing.strength ?? 1) + 1);

    await env.DB.prepare(
      `UPDATE growth_patterns
         SET strength = ?, evidence_json = ?, prehended_ids = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(newStrength, mergedEvidence, mergedPrehended, existing.id).run();

    return json({
      id: existing.id,
      message: "merged",
      action: "upsert",
      strength: newStrength,
    }, 200);
  }

  // INSERT path.
  await enforceCapOldest(env, "growth_patterns", companion_id, PATTERNS_CAP);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO growth_patterns
       (id, companion_id, pattern_text, evidence_json, strength, run_id, prehended_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    companion_id,
    pattern_text,
    JSON.stringify(incomingEvidence),
    incomingStrength,
    run_id,
    JSON.stringify(incomingPrehended),
  ).run();

  return json({ id, message: "ok", action: "insert", strength: incomingStrength }, 201);
}

export function mergeJsonArrays(existingJson: string, incoming: unknown[], cap: number): string {
  let existing: unknown[] = [];
  try {
    const parsed = JSON.parse(existingJson || "[]");
    if (Array.isArray(parsed)) existing = parsed;
  } catch { /* fall through to empty */ }

  // Dedupe by JSON-stringified value so {quote: "x"} merges with itself.
  const seen = new Set<string>(existing.map(v => JSON.stringify(v)));
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      existing.push(item);
      seen.add(key);
    }
  }
  return JSON.stringify(existing.slice(-cap));
}

// GET /mind/growth/patterns/:companion_id
export async function getGrowthPatterns(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const rows = await env.DB.prepare(
    "SELECT * FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC"
  ).bind(companion_id).all();

  return json({ patterns: rows.results });
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

// POST /mind/growth/markers
// Includes 'thoughtform' marker_type for triad-level recurring patterns.
// Dedupes on (companion_id, marker_type, description) to avoid duplicate
// thoughtform markers from repeated detector runs.
export async function postGrowthMarker(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  if (!validateCompanion(body.companion_id)) return json({ error: "invalid companion_id" }, 400);
  if (typeof body.description !== "string" || !body.description.trim()) return json({ error: "description required" }, 400);
  if (body.description.toString().length > MAX_TEXT) return json({ error: `description too long (max ${MAX_TEXT})` }, 400);

  const valid_marker_types = new Set(["milestone", "shift", "realization", "thoughtform"]);
  const marker_type = typeof body.marker_type === "string" && valid_marker_types.has(body.marker_type)
    ? body.marker_type
    : "milestone";

  // Dedupe: same companion + marker_type + description = no-op (return existing id).
  const dup = await env.DB.prepare(
    "SELECT id FROM growth_markers WHERE companion_id = ? AND marker_type = ? AND description = ? LIMIT 1",
  ).bind(body.companion_id, marker_type, body.description).first<{ id: string }>();
  if (dup) {
    return json({ id: dup.id, message: "duplicate", action: "skip" }, 200);
  }

  await enforceCapOldest(env, "growth_markers", body.companion_id as string, MARKERS_CAP);

  const run_id = optStr(body.run_id, 64);
  const rawPrehended = safeJsonArray(body.prehended_ids).filter((x): x is string => typeof x === "string").slice(0, 32);
  const validPrehended = await filterExistingIds(env, rawPrehended);
  const prehended = JSON.stringify(validPrehended);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO growth_markers
       (id, companion_id, marker_type, description, related_pattern_id, run_id, prehended_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    body.companion_id,
    marker_type,
    body.description,
    body.related_pattern_id ?? null,
    run_id,
    prehended,
  ).run();

  return json({ id, message: "ok", action: "insert" }, 201);
}

// GET /mind/growth/markers/:companion_id
export async function getGrowthMarkers(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const rows = await env.DB.prepare(
    "SELECT * FROM growth_markers WHERE companion_id = ? ORDER BY created_at DESC"
  ).bind(companion_id).all();

  return json({ markers: rows.results });
}

// ---------------------------------------------------------------------------
// Vault materialization
// ---------------------------------------------------------------------------

// GET /mind/growth/unmaterialized/:companion_id
// Returns growth_journal + growth_patterns + growth_markers rows that don't
// yet have a vault_path set. The Second Brain materializer cron polls this,
// writes structured .md files, and PATCHes vault_path back per row.
export async function getUnmaterialized(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id;
  if (!validateCompanion(companion_id)) return json({ error: "invalid companion_id" }, 400);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);

  const [journal, patterns, markers] = await Promise.all([
    env.DB.prepare(
      "SELECT id, entry_type, content, tags_json, source, created_at, prehended_ids, evidence_json, novelty FROM growth_journal WHERE companion_id = ? AND vault_path IS NULL ORDER BY created_at DESC LIMIT ?",
    ).bind(companion_id, limit).all(),
    env.DB.prepare(
      "SELECT id, pattern_text, evidence_json, strength, prehended_ids, created_at, updated_at FROM growth_patterns WHERE companion_id = ? AND vault_path IS NULL ORDER BY updated_at DESC LIMIT ?",
    ).bind(companion_id, limit).all(),
    env.DB.prepare(
      "SELECT id, marker_type, description, related_pattern_id, prehended_ids, created_at FROM growth_markers WHERE companion_id = ? AND vault_path IS NULL ORDER BY created_at DESC LIMIT ?",
    ).bind(companion_id, limit).all(),
  ]);

  return json({
    journal:  journal.results  ?? [],
    patterns: patterns.results ?? [],
    markers:  markers.results  ?? [],
  });
}

// POST /mind/growth/vault-paths
// Body: { ids: string[] } -- UUIDs of growth_journal/patterns/markers rows.
// Returns: { paths: { [id]: string | null } } -- vault_path for each id, null
// when the id is unknown or its row hasn't been materialized yet. Used by the
// SB materializer to resolve cross-tick [[halseth/<id>]] prehension wikilinks
// to actual vault file paths so links don't dangle.
export async function postVaultPathsLookup(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as Record<string, unknown>;
  const ids = safeJsonArray(body.ids)
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 200);

  if (ids.length === 0) return json({ paths: {} });

  const dedup = Array.from(new Set(ids));
  const placeholders = dedup.map(() => "?").join(",");
  const sql =
    `SELECT id, vault_path FROM growth_journal  WHERE id IN (${placeholders}) ` +
    `UNION SELECT id, vault_path FROM growth_patterns WHERE id IN (${placeholders}) ` +
    `UNION SELECT id, vault_path FROM growth_markers  WHERE id IN (${placeholders})`;
  const r = await env.DB.prepare(sql)
    .bind(...dedup, ...dedup, ...dedup)
    .all<{ id: string; vault_path: string | null }>();

  const paths: Record<string, string | null> = {};
  for (const id of dedup) paths[id] = null;
  for (const row of r.results ?? []) paths[row.id] = row.vault_path;

  return json({ paths });
}

// PATCH /mind/growth/:kind/:id/vault
// Set vault_path on a single row after the materializer wrote the .md file.
// kind ∈ { journal, patterns, markers }.
export async function patchVaultPath(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const tableByKind: Record<string, string> = {
    journal:  "growth_journal",
    patterns: "growth_patterns",
    markers:  "growth_markers",
  };
  const kind = params.kind ?? "";
  const table = tableByKind[kind];
  if (!table) return json({ error: "kind must be journal|patterns|markers" }, 400);

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const body = await request.json() as Record<string, unknown>;
  const vault_path = optStr(body.vault_path, 512);
  if (!vault_path) return json({ error: "vault_path required" }, 400);
  // Hard guard: must be inside Companions/ to prevent path-traversal of any kind
  // (we control formatting on the writer side; this is belt-and-suspenders).
  if (vault_path.includes("..") || vault_path.startsWith("/")) {
    return json({ error: "vault_path must be a relative vault-internal path" }, 400);
  }

  // Table name is bound from a hardcoded lookup, not user input.
  const result = await env.DB.prepare(
    `UPDATE ${table} SET vault_path = ? WHERE id = ?`,
  ).bind(vault_path, id).run();

  if (result.meta.changes === 0) {
    return json({ error: "row not found" }, 404);
  }
  return json({ ok: true, vault_path });
}
