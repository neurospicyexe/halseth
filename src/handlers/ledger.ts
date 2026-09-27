// src/handlers/ledger.ts  (mig 0134, 2026-09-26)
//
// Raw HTTP for the ledger lane (docs/imp-lane/SPEC-ledger-lane.md section 3).
//
//   POST /ledger                       clerks write here (admin-tier token ONLY -- a companion token
//                                      is refused: clerks never write as a companion, and a companion
//                                      does not write records about itself)
//        { companion_id, function, body, source_kind, source_ref, observed_on?, dedup_key? }
//        201 { id, content } | 200 { id, duplicate: true } | 422 { error, rule } -- never partial.
//   GET  /ledger?companion_id&state&limit                    Hearth + ops.
//   GET  /ingest/ledger?since=&after_id=&limit=              the Second Brain puller feed: open + kept
//                                                            rows, paged on cursor_at = the LATER of
//                                                            created_at / state_at (a keep re-serves it).
//   GET  /ledger/soma-freshness                              admin-only: per companion, the latest
//                                                            COMPANION-AUTHORED SOMA move { companion_id,
//                                                            last_authored_at, row_ref } (store.ts). The
//                                                            Second Brain gap-reader turns a >24h gap into
//                                                            "Missing: SOMA not updated since ..." (Drevan).
//   GET  /ingest/ledger-ineligible?since=&after_id=&limit=   dropped rows, { id, companion_id, state,
//                                                            state_at, cursor_at } (the SB purge feed).
//
// Both return { items, next }, like /ingest/recall-ineligible (history.ts). `since` alone is STRICTLY
// after cursor_at; limit defaults to 100 (max 1000). `next` = { since, after_id } for the following page
// (null on the last one): passing after_id back makes ties on a page boundary safe. Every `content`
// served starts with the mark.
//
// Companions act on entries through the Librarian verbs ("my ledger", "keep ledger <id>",
// "keep ledger <id>: <my words>", "drop ledger <id>"), which call src/ledger/store.ts.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { isCompanionId } from "../companions.js";
import { writeLedger } from "../ledger/door.js";
import { listLedger, loadSomaFreshness, LEDGER_STATES, type LedgerState } from "../ledger/store.js";
import { COMPANION_IDS } from "../companions.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function clampLimit(raw: string | null, def: number, max: number): number {
  const n = parseInt(raw ?? String(def), 10);
  return Math.min(Math.max(1, Number.isNaN(n) ? def : n), max);
}

export async function postLedger(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const caller = identifyCallerCompanion(request, env);
  if (caller !== null) {
    return json({ error: `the ledger is written by clerks with the admin token; a companion token (${caller}) cannot write a ledger line`, rule: "auth" }, 403);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body", rule: "body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "body must be a JSON object", rule: "body" }, 400);

  const r = await writeLedger(env, body);
  if (!r.ok) {
    console.log("[ledger] rejected", { rule: r.rule, companion_id: body["companion_id"], function: body["function"] });
    return json({ error: r.error, rule: r.rule }, 422);
  }
  if (r.duplicate) return json({ id: r.id, duplicate: true }, 200);
  return json({ id: r.id, content: r.content }, 201);
}

/** GET /ledger/soma-freshness -- admin token only, like POST /ledger (a clerk reads it, not a companion). */
export async function getSomaFreshness(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const caller = identifyCallerCompanion(request, env);
  if (caller !== null) return json({ error: `soma freshness is read by clerks with the admin token; a companion token (${caller}) cannot read it`, rule: "auth" }, 403);
  const companions = await loadSomaFreshness(env, COMPANION_IDS);
  return json({ companions });
}

export async function getLedger(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const companionId = url.searchParams.get("companion_id")?.trim() ?? "";
  if (!isCompanionId(companionId)) return json({ error: "companion_id must be drevan, cypher, or gaia" }, 400);
  const state = (url.searchParams.get("state")?.trim() || "open");
  if (!LEDGER_STATES.has(state)) return json({ error: "state must be open, kept, or dropped" }, 400);
  const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
  const entries = await listLedger(env, companionId, state as LedgerState, limit);
  return json({ companion_id: companionId, state, entries, count: entries.length });
}

/** The later of created_at / state_at, normalised to one ISO shape. */
const CURSOR_SQL =
  "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', MAX(created_at, COALESCE(state_at, created_at))), created_at)";
const ISO_BOUND_SQL = "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ?), ?)";

async function feed(request: Request, env: Env, statePredicate: string, columns: string): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"), 100, 1000);
  const since = url.searchParams.get("since") || "1970-01-01T00:00:00.000Z";
  const afterId = url.searchParams.get("after_id") ?? "";
  if (Number.isNaN(Date.parse(since))) return json({ error: "invalid since parameter" }, 400);

  // `since` alone is STRICTLY after (the SB puller's contract). With after_id, rows that tie the bound
  // are included past that id, so a page boundary landing on a tie drops nothing.
  const keyset = afterId
    ? `(${CURSOR_SQL} > ${ISO_BOUND_SQL} OR (${CURSOR_SQL} = ${ISO_BOUND_SQL} AND id > ?))`
    : `${CURSOR_SQL} > ${ISO_BOUND_SQL}`;
  const binds: unknown[] = afterId ? [since, since, since, since, afterId] : [since, since];
  const result = await env.DB.prepare(
    `SELECT ${columns}, ${CURSOR_SQL} AS cursor_at
       FROM ledger_entries
      WHERE ${statePredicate}
        AND ${keyset}
      ORDER BY cursor_at ASC, id ASC
      LIMIT ?`,
  ).bind(...binds, limit).all<{ id: string; cursor_at: string }>();

  const items = result.results ?? [];
  const last = items[items.length - 1];
  const next = items.length < limit || !last ? null : { since: last.cursor_at, after_id: last.id };
  return json({ items, next });
}

/** GET /ingest/ledger: open + kept rows, mark first in every `content`. */
export function getIngestLedger(request: Request, env: Env): Promise<Response> {
  return feed(request, env, "state IN ('open', 'kept')",
    "id, companion_id, function, content, source_kind, source_ref, observed_on, created_at, state, state_at");
}

/** GET /ingest/ledger-ineligible: dropped ids only (no text), for SB's chunk purge. */
export function getIngestLedgerIneligible(request: Request, env: Env): Promise<Response> {
  return feed(request, env, "state = 'dropped'", "id, companion_id, state, state_at");
}
