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
//     (evidence/prehensions appended) instead of inserting a new row.
//     R18 (mig 0147, 2026-10-22): a merge no longer strengthens by itself. Strength is earned by a
//     new distinct MATERIAL (body.material, checked server-side); a restatement in a known
//     material is "returned, no new material". Rules: lib/pattern-materials.ts.
//   - postGrowthMarker dedupes on (companion_id, marker_type, description).
//   - Marker type allowlist now includes 'thoughtform' for triad-level recurrence.
//   - PATCH /mind/growth/:kind/:id/vault sets vault_path after SB materializer
//     writes the .md file.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { nextPhase, phaseAdvances, advanceChargeSql, type ChargeSignal } from "../webmind/charge.js";
import { noveltyCheck } from "../webmind/novelty.js";
import { applySighting, parseMaterials, MATERIAL_NAME_MAX, normalizeMaterial, type Material } from "../lib/pattern-materials.js";
import { storeVector, embedAndStoreAsync } from "../mcp/embed.js";
import { RATIFIABLE_PENDING_SQL, VAULT_WORTHY_SQL } from "../lib/ratifiable.js";

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
  // R18: a superseded pattern is a kept RECORD of a fold, not a live row -- it neither counts against
  // the cap nor is ever the one evicted. (Only growth_patterns has the column.)
  const live = table === "growth_patterns" ? " AND superseded_by IS NULL" : "";
  const count = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM ${table} WHERE companion_id = ?${live}`
  ).bind(companion_id).first<{ n: number }>();
  if (count && count.n >= cap) {
    await env.DB.prepare(
      `DELETE FROM ${table} WHERE id IN (
         SELECT id FROM ${table} WHERE companion_id = ?${live} ORDER BY created_at ASC LIMIT ?
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

  const valid_types = new Set(["learning", "insight", "connection", "question", "signal_audit", "reconsolidation"]);
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

  // Reconsolidation (0074): a proposal may supersede settled canon. The target must
  // exist, be accepted, and belong to the same companion -- validated at write time
  // so a stale or hallucinated id fails loudly here, not silently downstream.
  let supersedes_id: string | null = null;
  if (typeof body.supersedes_id === "string" && body.supersedes_id.trim()) {
    const target = await env.DB.prepare(
      "SELECT id FROM growth_journal WHERE id = ? AND companion_id = ? AND review_status = 'accepted'"
    ).bind(body.supersedes_id.trim(), body.companion_id).first<{ id: string }>();
    if (!target) {
      return json({ error: "supersedes_id must reference an accepted entry of the same companion" }, 400);
    }
    supersedes_id = target.id;
  }

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
        thread_id, prehended_ids, evidence_json, novelty, supersedes_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    supersedes_id,
  ).run();

  return json({ id, message: "ok" }, 201);
}

// GET /mind/growth/journal/:companion_id
// ?limit=N (max 100), ?offset=N, ?pending=1 (only autonomous + awaiting review),
// ?status=accepted (reconsolidation sampling)
// Returns { journal, total, limit, offset, has_more } -- total/has_more added 2026-08-12, because
// limit was capped at 100 with no offset and every companion sat AT the cap, so Hearth's "view the
// full list" could only ever show a first page it had no way to describe as partial.
/**
 * GET /mind/growth/pending-count
 *
 * Per-companion count of autonomous growth entries awaiting Raziel's ratification, plus the
 * oldest wait. Added 2026-07-27 because Raziel could not find where to ratify: the surface
 * existed the whole time at Hearth `/companions/<id>/growth` with working accept/decline
 * buttons, but it sits three levels deep behind a tab strip and NOTHING anywhere showed a
 * count. 55 entries had been waiting, the oldest 17 days.
 *
 * Same failure class as the rest of the 2026-07-27 sweep: a working mechanism with nothing
 * surfacing it is a dead loop. A queue only a search can find is a queue nobody drains.
 */
export async function getGrowthPendingCount(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  // Counts the SAME predicate the list serves (`RATIFIABLE_PENDING_SQL`), not a hand-written one.
  // Original note, still true: the first draft filtered source = 'autonomous' and reported 10 when
  // 55 were waiting, because 45 carried source = 'reflection'. That was fixed by dropping the
  // filter entirely -- correct on the data of the day, but it left the count and the list keyed on
  // two different rules, so a pending row from any THIRD source would be counted here and be
  // unlistable (hence unratifiable) there: the 2026-08-01 bug pointing the other way. Both sides
  // now read one constant. 2026-08-08: zero rows differ between the two predicates in prod, so
  // this is a no-op on today's data and a guarantee going forward.
  const rows = await env.DB.prepare(
    `SELECT companion_id,
            COUNT(*) AS pending,
            MIN(created_at) AS oldest_at,
            SUM(CASE WHEN source = 'autonomous' THEN 1 ELSE 0 END) AS from_autonomous,
            SUM(CASE WHEN source = 'reflection' THEN 1 ELSE 0 END) AS from_reflection
     FROM growth_journal
     WHERE ${RATIFIABLE_PENDING_SQL}
     GROUP BY companion_id`
  ).all<{ companion_id: string; pending: number; oldest_at: string; from_autonomous: number; from_reflection: number }>();

  const per_companion = rows.results ?? [];
  const total = per_companion.reduce((n, r) => n + (r.pending ?? 0), 0);
  const oldest = per_companion.reduce<string | null>(
    (acc, r) => (!acc || (r.oldest_at && r.oldest_at < acc) ? r.oldest_at ?? acc : acc), null);

  return json({ total, oldest_at: oldest, per_companion });
}

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
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20, 100);
  const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const pendingOnly = url.searchParams.get("pending") === "1";
  const acceptedOnly = url.searchParams.get("status") === "accepted";

  // One predicate per view mode, used for BOTH the page and its total. Reusing a single global
  // count across three differently-filtered views is the bug this file has already recorded twice
  // (see getGrowthPendingCount): a total that disagrees with the list it labels is worse than none.
  const where = pendingOnly
    ? `companion_id = ? AND ${RATIFIABLE_PENDING_SQL}`
    : acceptedOnly
      ? "companion_id = ? AND review_status = 'accepted'"
      : "companion_id = ?";

  // ASC for the queue, because a backlog drains from the OLDEST end and `DESC LIMIT n` cuts off
  // precisely the rows that have waited longest. With 39 pending that was academic; the moment a
  // queue exceeds the cap, newest-first makes its tail unreachable, which is the whole complaint.
  // ?status=accepted is likewise ASC -- reconsolidation wants the stalest canon first.
  const order = pendingOnly || acceptedOnly ? "created_at ASC, id ASC" : "created_at DESC, id DESC";

  // `id` breaks ties: created_at is not unique in growth_journal (the nightly reflect phase writes
  // several rows in the same second), and a non-deterministic ORDER BY under LIMIT/OFFSET
  // duplicates rows on one page and skips them on the next.
  const rows = await env.DB.prepare(
    `SELECT * FROM growth_journal WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).bind(companion_id, limit, offset).all();

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM growth_journal WHERE ${where}`
  ).bind(companion_id).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  return json({
    journal: rows.results,
    total,
    limit,
    offset,
    // Explicit, so a consumer never has to infer "is there more?" from a full page -- the inference
    // that made `length >= limit` mean both "exactly limit rows exist" and "hundreds do".
    has_more: offset + (rows.results?.length ?? 0) < total,
  });
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

  // Reconsolidation (0074), Zikkaron "archive+replace" lean variant: canon history is
  // never deleted -- when an accepted entry supersedes another, the old row stays
  // accepted but gains a machine-readable forward pointer in its tags.
  if (status === "accepted") {
    const accepted = await env.DB.prepare(
      "SELECT supersedes_id, charge_phase FROM growth_journal WHERE id = ? AND companion_id = ?"
    ).bind(id, companion_id).first<{ supersedes_id: string | null; charge_phase: string | null }>();
    // Non-fatal side-writes surface their failures in the response instead of
    // vanishing into console.warn -- the caller decides whether a lost canon
    // link or stalled charge phase matters.
    let supersededLinked: boolean | undefined;
    let chargeAdvanced: boolean | undefined;
    if (accepted?.supersedes_id) {
      supersededLinked = true;
      await env.DB.prepare(
        "UPDATE growth_journal SET tags_json = json_insert(coalesce(tags_json, '[]'), '$[#]', ?) WHERE id = ?"
      ).bind(`superseded:${id}`, accepted.supersedes_id).run()
        .catch(e => { console.warn("[growth] superseded tag failed:", e); supersededLinked = false; });
    }
    // Charge-phase lifecycle (0075, take 2): ratifying an entry is intentional engagement,
    // so the memory metabolizes one step along the ladder. A reconsolidation (supersede) is a
    // burning paradox -- it jumps to at least 'processing'. Stored, monotonic, non-fatal.
    const signal: ChargeSignal = accepted?.supersedes_id ? "reconsolidated" : "ratified";
    if (phaseAdvances(accepted?.charge_phase, signal)) {
      chargeAdvanced = true;
      await env.DB.prepare(advanceChargeSql())
        .bind(nextPhase(accepted?.charge_phase, signal), id).run()
        .catch(e => { console.warn("[growth] charge advance failed:", e); chargeAdvanced = false; });
    }
    return json({
      ok: true, already_reviewed: false, review_status: status,
      ...(supersededLinked === false ? { superseded_link: false } : {}),
      ...(chargeAdvanced === false ? { charge_advanced: false } : {}),
    });
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

// DELETE /mind/growth/journal/:id?companion_id=
// Hard-prune for bad autonomous (DeepSeek) noise. Honors the "canon is never deleted"
// covenant structurally: an ACCEPTED entry cannot be hard-deleted (use decline/supersede
// instead) -- only pending/declined rows are removable. Ownership-scoped by companion_id so
// a mistargeted delete can't hit the wrong companion's row. FK-safe: supersedes_id only ever
// points at accepted parents (which this refuses to delete), so no child is orphaned.
export async function deleteJournalEntry(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id required" }, 400);

  const url = new URL(request.url);
  const companion_id = url.searchParams.get("companion_id");
  if (!validateCompanion(companion_id)) return json({ error: "companion_id query param required" }, 400);

  const row = await env.DB.prepare(
    "SELECT review_status FROM growth_journal WHERE id = ? AND companion_id = ?"
  ).bind(id, companion_id).first<{ review_status: string }>();
  if (!row) return json({ error: "entry not found" }, 404);
  if (row.review_status === "accepted") {
    return json({ error: "accepted canon cannot be deleted -- decline or supersede instead" }, 409);
  }

  await env.DB.prepare(
    "DELETE FROM growth_journal WHERE id = ? AND companion_id = ? AND review_status != 'accepted'"
  ).bind(id, companion_id).run();

  return json({ ok: true, deleted: true });
}

// ---------------------------------------------------------------------------
// Patterns -- Jaccard-similarity UPSERT
// ---------------------------------------------------------------------------

/** The mergeable fields of a growth_patterns row (R18 added the materials counters). */
const PATTERN_STATE_COLS =
  "strength, evidence_json, prehended_ids, materials_json, times_stated, returns_since_material, last_new_material_at, superseded_by";
interface ExistingPattern {
  id: string;
  strength: number;
  evidence_json: string;
  prehended_ids: string;
  materials_json?: string | null;
  times_stated?: number | null;
  returns_since_material?: number | null;
  last_new_material_at?: string | null;
  superseded_by?: string | null;
}

/**
 * Find the most-similar existing pattern for this companion, if any clears
 * PATTERN_DEDUP_THRESHOLD. Used by postGrowthPattern to decide UPSERT vs INSERT.
 */
async function findSimilarPattern(
  env: Env,
  companion_id: string,
  pattern_text: string,
): Promise<ExistingPattern | null> {
  const tokens = tokenize(pattern_text);
  if (tokens.size === 0) return null;

  // Pull recent patterns and Jaccard them in JS. Caps mean this set is <=50.
  const candidates = await env.DB.prepare(
    `SELECT id, pattern_text, ${PATTERN_STATE_COLS} FROM growth_patterns WHERE companion_id = ? AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT 50`,
  ).bind(companion_id).all<ExistingPattern & { pattern_text: string }>();

  let best: { row: typeof candidates.results[0]; score: number } | null = null;
  for (const row of candidates.results) {
    const score = jaccard(tokens, tokenize(row.pattern_text));
    if (score >= PATTERN_DEDUP_THRESHOLD && (best === null || score > best.score)) {
      best = { row, score };
    }
  }
  return best ? best.row : null;
}

/**
 * Merge incoming evidence/prehensions into an existing growth_patterns row -- the shared UPSERT tail for
 * BOTH match paths (Jaccard and semantic). One code path, so a semantic-gate match is judged exactly the
 * way a Jaccard match always has.
 *
 * R18: this no longer bumps strength by itself. `material` is what the caller says this sighting is in;
 * applySighting checks it against the stored list (normalised, server-side). A new material appends and
 * strengthens; a known one is "returned, no new material" -- times_stated and returns_since_material
 * climb, strength does not move.
 */
async function mergeIntoExistingPattern(
  env: Env,
  existing: ExistingPattern,
  incomingEvidence: unknown[],
  incomingPrehended: string[],
  material: string | null,
): Promise<{ id: string; strength: number; outcome: "new_material" | "returned"; materials: Material[]; times_stated: number }> {
  const mergedEvidence  = mergeJsonArrays(existing.evidence_json,  incomingEvidence,  16);
  const mergedPrehended = mergeJsonArrays(existing.prehended_ids,  incomingPrehended, 32);
  const next = applySighting({
    strength: existing.strength ?? 1,
    times_stated: existing.times_stated ?? 1,
    returns_since_material: existing.returns_since_material ?? 0,
    last_new_material_at: existing.last_new_material_at ?? null,
    materials: parseMaterials(existing.materials_json),
  }, material, Date.now());

  await env.DB.prepare(
    `UPDATE growth_patterns
       SET strength = ?, evidence_json = ?, prehended_ids = ?, materials_json = ?, times_stated = ?,
           returns_since_material = ?, last_new_material_at = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(
    next.strength, mergedEvidence, mergedPrehended, JSON.stringify(next.materials), next.times_stated,
    next.returns_since_material, next.last_new_material_at, existing.id,
  ).run();

  if (next.outcome === "returned") {
    console.log("[growth patterns] returned, no new material", { id: existing.id, times_stated: next.times_stated, returns_since_material: next.returns_since_material });
  }
  return { id: existing.id, strength: next.strength, outcome: next.outcome, materials: next.materials, times_stated: next.times_stated };
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
  // R18: any `strength` in the body is ignored on purpose -- strength is earned by distinct material,
  // not asserted by the writer. `material` names what THIS sighting is in (short, e.g. "the dime").
  const material = optStr(body.material, MATERIAL_NAME_MAX);
  const run_id = optStr(body.run_id, 64);

  // Semantic novelty gate (Wave 2, 2026-07-21) -- runs BEFORE the Jaccard check below.
  // Live paraphrase pairs of the same pattern scored only 0.077-0.375 Jaccard token
  // overlap (nowhere near PATTERN_DEDUP_THRESHOLD) while embedding at >=0.95 cosine
  // similarity -- restatements the Jaccard check alone was structurally blind to.
  // Fails open to the Jaccard fallback on ANY trouble: noveltyCheck's own internals
  // already fail open to {action:"insert"} on an embed/Vectorize error, and the
  // try/catch here is defense in depth -- this write path must never be blocked by
  // the gate. Reuses the gate's embedding on insert (net +0 AI.run on the common path).
  let noveltyEmbedding: number[] | null = null;
  try {
    const decision = await noveltyCheck(env, pattern_text, "growth_patterns", companion_id);
    if (decision.action === "skip") {
      // Fetch the matched row's mergeable fields fresh -- noveltyCheck only returns an id.
      // Scoped to companion_id as belt-and-suspenders (the vector filter already scopes it).
      let semanticMatch = await env.DB.prepare(
        `SELECT id, ${PATTERN_STATE_COLS} FROM growth_patterns WHERE id = ? AND companion_id = ?`,
      ).bind(decision.matchRowId, companion_id).first<ExistingPattern>();
      // R18: a superseded row keeps its vector, so the gate can still land on it. Follow the fold to the
      // live row it was merged into (one hop; a fold always points at the survivor).
      if (semanticMatch?.superseded_by) {
        semanticMatch = await env.DB.prepare(
          `SELECT id, ${PATTERN_STATE_COLS} FROM growth_patterns WHERE id = ? AND companion_id = ? AND superseded_by IS NULL`,
        ).bind(semanticMatch.superseded_by, companion_id).first<ExistingPattern>();
      }

      if (semanticMatch) {
        const merged = await mergeIntoExistingPattern(env, semanticMatch, incomingEvidence, incomingPrehended, material);
        return json({
          id: merged.id,
          message: merged.outcome === "returned" ? "returned, no new material" : "merged",
          action: "upsert",
          strength: merged.strength,
          outcome: merged.outcome,
          times_stated: merged.times_stated,
          materials: merged.materials.map(m => m.name),
          matched_via: "semantic",
        }, 200);
      }
      // Defensive (mirrors novelty.ts's own dead-row handling for conclusions): the vector
      // pointed at a row that no longer exists in D1. Fall through to Jaccard/insert rather
      // than ever blocking the write.
      console.warn("[growth patterns] semantic match row missing, falling through", { matchRowId: decision.matchRowId });
    } else {
      noveltyEmbedding = decision.embedding;
    }
  } catch (err) {
    console.warn("[growth patterns] novelty gate error, falling back to Jaccard:", String(err));
  }

  // Jaccard UPSERT path (unchanged, now the fallback for what the semantic gate missed).
  const existing = await findSimilarPattern(env, companion_id, pattern_text);
  if (existing) {
    const merged = await mergeIntoExistingPattern(env, existing, incomingEvidence, incomingPrehended, material);
    return json({
      id: merged.id,
      message: merged.outcome === "returned" ? "returned, no new material" : "merged",
      action: "upsert",
      strength: merged.strength,
      outcome: merged.outcome,
      times_stated: merged.times_stated,
      materials: merged.materials.map(m => m.name),
    }, 200);
  }

  // INSERT path.
  await enforceCapOldest(env, "growth_patterns", companion_id, PATTERNS_CAP);

  // A new pattern starts at one sighting: strength 1, in the material it was first seen in (if named).
  const id = crypto.randomUUID();
  const firstSeen = new Date().toISOString();
  const startMaterials: Material[] = material && normalizeMaterial(material) ? [{ name: material, first_seen: firstSeen }] : [];
  await env.DB.prepare(
    `INSERT INTO growth_patterns
       (id, companion_id, pattern_text, evidence_json, strength, run_id, prehended_ids,
        materials_json, times_stated, returns_since_material, last_new_material_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
  ).bind(
    id,
    companion_id,
    pattern_text,
    JSON.stringify(incomingEvidence),
    1,
    run_id,
    JSON.stringify(incomingPrehended),
    JSON.stringify(startMaterials),
    startMaterials.length > 0 ? firstSeen : null,
  ).run();

  // Store the vector for future novelty checks. Reuse the gate's embedding when we have
  // one (net +0 AI.run on the common gated path); otherwise embed fresh. Never fatal --
  // D1 is truth, Vectorize is rebuildable (POST /admin/backfill-embeddings?table=growth_patterns).
  if (noveltyEmbedding) {
    try {
      await storeVector(env, noveltyEmbedding, "growth_patterns", id, companion_id);
    } catch (e) {
      console.warn(`[growth patterns] vector store failed for ${id} (row kept, index stale):`, String(e));
    }
  } else {
    try {
      await embedAndStoreAsync(env, pattern_text, "growth_patterns", id, companion_id);
    } catch (e) {
      console.warn(`[growth patterns] embed failed for ${id} (row kept, index stale):`, String(e));
    }
  }

  return json({ id, message: "ok", action: "insert", strength: 1, materials: startMaterials.map(m => m.name) }, 201);
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
    "SELECT * FROM growth_patterns WHERE companion_id = ? AND superseded_by IS NULL ORDER BY strength DESC, updated_at DESC"
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

  const [journal, patterns, markers, orphaned] = await Promise.all([
    // Accepted canon, PLUS unraised nightly reflections (2026-08-12). Ratification still gates
    // canon; it no longer gates searchability. A reflection the companion did not raise is a log
    // that will never be accepted, so gating the vault on acceptance would make every future
    // nightly self-read unfindable. Declined rows are still excluded: declining is a verdict.
    // One constant, shared with the orphan sweep below -- see VAULT_WORTHY_SQL.
    env.DB.prepare(
      `SELECT id, entry_type, content, tags_json, source, created_at, prehended_ids, evidence_json, novelty FROM growth_journal WHERE companion_id = ? AND vault_path IS NULL AND ${VAULT_WORTHY_SQL} ORDER BY created_at DESC LIMIT ?`,
    ).bind(companion_id, limit).all(),
    env.DB.prepare(
      "SELECT id, pattern_text, evidence_json, strength, prehended_ids, created_at, updated_at FROM growth_patterns WHERE companion_id = ? AND vault_path IS NULL AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT ?",
    ).bind(companion_id, limit).all(),
    env.DB.prepare(
      "SELECT id, marker_type, description, related_pattern_id, prehended_ids, created_at FROM growth_markers WHERE companion_id = ? AND vault_path IS NULL ORDER BY created_at DESC LIMIT ?",
    ).bind(companion_id, limit).all(),
    // Orphaned: rows that WERE materialized but no longer belong in the vault (declined, or an
    // entry the companion has since raised so it is awaiting a verdict rather than sitting as a
    // log). The materializer deletes these files and clears vault_path.
    //
    // Derived as the exact complement of the feed above, NOT restated. These two are a
    // write/delete pair over the same rows: if they disagreed by one row, the materializer would
    // write that file and this sweep would delete it on every single run, forever.
    env.DB.prepare(
      `SELECT id, vault_path FROM growth_journal WHERE companion_id = ? AND vault_path IS NOT NULL AND NOT ${VAULT_WORTHY_SQL} ORDER BY created_at DESC LIMIT ?`,
    ).bind(companion_id, limit).all(),
  ]);

  return json({
    journal:  journal.results  ?? [],
    patterns: patterns.results ?? [],
    markers:  markers.results  ?? [],
    orphaned: orphaned.results ?? [],
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

  // Explicit null clears vault_path (un-materialization, after the materializer
  // deletes the .md file). Distinguished from a missing field, which is rejected.
  if (body.vault_path === null) {
    const cleared = await env.DB.prepare(
      `UPDATE ${table} SET vault_path = NULL WHERE id = ?`,
    ).bind(id).run();
    if (cleared.meta.changes === 0) return json({ error: "row not found" }, 404);
    return json({ ok: true, vault_path: null });
  }

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
