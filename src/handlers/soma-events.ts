// src/handlers/soma-events.ts
//
// POST /admin/soma/backfill-events -- seed companion_soma_events (mig 0130) from the two detail
// tables that already recorded float moves, so the float history is not born empty. Mirrors
// /admin/graph/rebuild (src/handlers/graph.ts): admin-tier authGuard, one JSON response, counts out.
//
// IDEMPOTENT BY CONSTRUCTION, not by a gate. Every backfilled row carries a DETERMINISTIC id
// derived from its source row (`ss_<soma_shift_id>`, `fe_<ferment_event_id>_<f1|f2|f3>`) and is
// written with INSERT OR IGNORE. Running it twice writes nothing the second time -- and, because
// the LIVE writers (handlers/fermentation.ts, soma/emergent.ts) mint the same ids, running it
// after instrumentation shipped cannot double a move a live writer already recorded either.
//
// What each source can say:
//   * companion_soma_shifts -- before AND after, so the event carries absolutes and a real delta.
//   * companion_ferment_events -- float_deltas JSON {f1,f2,f3} only. The move is known, the
//     absolutes are not, so before/after stay NULL and `delta` carries the recorded value. This is
//     exactly the nullable case the migration header documents; do not invent absolutes for it.
//
// created_at is the SOURCE row's timestamp, never now(): a history backfilled today from a tick
// three months ago is dated three months ago (same law as graph_edges, mig 0127).
//
// GET /admin/soma/events/:companion_id?limit= -- read the raw rows back, for verifying the above.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { floatKeyFromShort, floatShort, somaEventStatements, type SomaEventInput } from "../soma/events.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

interface ShiftRow {
  id: string;
  companion_id: string;
  float_key: string;
  delta: number | null;
  before_value: number | null;
  after_value: number | null;
  reason: string | null;
  created_at: string;
}

interface FermentRow {
  id: string;
  companion_id: string;
  kind: string;
  stimulus: string | null;
  float_deltas: string | null;
  created_at: string;
}

const VALID_FLOAT_KEYS = new Set(["soma_float_1", "soma_float_2", "soma_float_3"]);

/** Head of a reason/detail string: single line, collapsed whitespace, <=120 chars. */
function detailHead(text: string | null): string | null {
  if (!text) return null;
  const line = String(text).split(/[\r\n]/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return null;
  return line.slice(0, 120);
}

/** Pure: the events one companion_soma_shifts row backfills into. Exported for the id-determinism test. */
export function eventsFromShift(row: ShiftRow): SomaEventInput[] {
  if (!VALID_FLOAT_KEYS.has(row.float_key)) return [];
  const before = typeof row.before_value === "number" && Number.isFinite(row.before_value) ? row.before_value : null;
  const after = typeof row.after_value === "number" && Number.isFinite(row.after_value) ? row.after_value : null;
  const delta = typeof row.delta === "number" && Number.isFinite(row.delta) ? row.delta : null;
  if (before === null && after === null && delta === null) return [];
  return [{
    id: `ss_${row.id}`,
    companion_id: row.companion_id,
    float_key: row.float_key as SomaEventInput["float_key"],
    before_value: before,
    after_value: after,
    delta,
    kind: "drift_shift",
    writer: "system",
    cause_table: "companion_soma_shifts",
    cause_id: row.id,
    session_id: null,
    version_after: null,
    detail: detailHead(row.reason),
    created_at: row.created_at,
  }];
}

/** Pure: the events one companion_ferment_events row backfills into (one per non-zero float). */
export function eventsFromFermentEvent(row: FermentRow): SomaEventInput[] {
  if (row.kind !== "tick" && row.kind !== "stimulus") return [];
  if (!row.float_deltas) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.float_deltas) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out: SomaEventInput[] = [];
  for (const short of ["f1", "f2", "f3"]) {
    const raw = Number(parsed[short]);
    if (!Number.isFinite(raw) || Math.abs(raw) <= 1e-9) continue;
    const float_key = floatKeyFromShort(short);
    if (!float_key) continue;
    out.push({
      id: `fe_${row.id}_${floatShort(float_key)}`,
      companion_id: row.companion_id,
      float_key,
      before_value: null,
      after_value: null,
      delta: raw,
      kind: row.kind === "tick" ? "tick" : "stimulus",
      writer: "system",
      cause_table: "companion_ferment_events",
      cause_id: row.id,
      session_id: null,
      version_after: null,
      detail: row.stimulus ?? null,
      created_at: row.created_at,
    });
  }
  return out;
}

const BATCH_SIZE = 50;

export async function postSomaBackfillEvents(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  try {
    const shifts = (await env.DB.prepare(
      "SELECT id, companion_id, float_key, delta, before_value, after_value, reason, created_at FROM companion_soma_shifts ORDER BY created_at ASC, id ASC",
    ).all<ShiftRow>()).results ?? [];
    const ferments = (await env.DB.prepare(
      "SELECT id, companion_id, kind, stimulus, float_deltas, created_at FROM companion_ferment_events WHERE kind IN ('tick','stimulus') AND float_deltas IS NOT NULL ORDER BY created_at ASC, id ASC",
    ).all<FermentRow>()).results ?? [];

    const events: SomaEventInput[] = [];
    for (const s of shifts) events.push(...eventsFromShift(s));
    for (const f of ferments) events.push(...eventsFromFermentEvent(f));

    // Chunked: a single batch of every historical event would be one very large D1 transaction.
    let written = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      const res = await env.DB.batch(somaEventStatements(env.DB, chunk));
      for (const r of res) written += (r.meta as { changes?: number } | undefined)?.changes ?? 0;
    }

    const byKind: Record<string, number> = {};
    for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    return json({
      ok: true,
      backfilled_at: new Date().toISOString(),
      source_rows: { companion_soma_shifts: shifts.length, companion_ferment_events: ferments.length },
      candidates: events.length,
      inserted: written,
      by_kind: byKind,
    });
  } catch (err) {
    console.error("[admin/soma/backfill-events] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getSomaEvents(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!companionId) return json({ error: "companion_id required" }, 400);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50), 200);

  try {
    const rows = (await env.DB.prepare(
      `SELECT id, companion_id, float_key, before_value, after_value, delta, kind, writer,
              cause_table, cause_id, session_id, version_after, detail, created_at
         FROM companion_soma_events WHERE companion_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(companionId, limit).all()).results ?? [];
    return json({ companion_id: companionId, count: rows.length, events: rows });
  } catch (err) {
    console.error("[admin/soma/events] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
