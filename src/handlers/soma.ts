import { Env } from "../types.js";
import { authGuard, VALID_COMPANIONS } from "../lib/auth.js";
import { updateCompanionState, type CompanionStateUpdate } from "../librarian/backends/halseth.js";

// Numeric SOMA fields are clamped to [0, 1] before bind. TEXT fields are
// trimmed and capped at 100 chars (lane_spine excepted -- 150). The lists
// MUST match CompanionStateUpdate; if they drift, writes through this HTTP
// path silently drop columns and we end up back at the 8-cycle SOMA failure.
const NUMERIC_SOMA_FIELDS = [
  "soma_float_1", "soma_float_2", "soma_float_3",
  "surface_intensity", "undercurrent_intensity", "background_intensity",
] as const;
const TEXT_SOMA_FIELDS = [
  "heat", "reach", "weight",
  "current_mood", "compound_state",
  "surface_emotion", "undercurrent_emotion", "background_emotion",
  "motion_state", "lane_spine", "prompt_context",
] as const;

export async function patchSomaState(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id ?? "";
  if (!VALID_COMPANIONS.has(companion_id))
    return Response.json({ error: "invalid companion_id" }, { status: 400 });

  const body = await request.json() as Record<string, unknown>;

  // Build a CompanionStateUpdate from validated body fields, then delegate
  // to the canonical helper so this HTTP path shares one allowed-columns
  // list with the MCP tool and Librarian fast-path. Drift between paths is
  // exactly what caused 8+ cycles of "SOMA write routing failure" before
  // the 2026-05-04 fix.
  const update: CompanionStateUpdate = {};
  for (const f of NUMERIC_SOMA_FIELDS) {
    if (typeof body[f] === "number" && isFinite(body[f] as number)) {
      (update as Record<string, unknown>)[f] = Math.max(0, Math.min(1, body[f] as number));
    }
  }
  for (const f of TEXT_SOMA_FIELDS) {
    if (typeof body[f] === "string" && (body[f] as string).trim()) {
      const cap = f === "lane_spine" ? 150 : 100;
      (update as Record<string, unknown>)[f] = (body[f] as string).trim().slice(0, cap);
    }
  }

  if (Object.keys(update).length === 0)
    return Response.json({ error: "no valid fields provided" }, { status: 400 });

  const result = await updateCompanionState(env, companion_id, update);
  if (!result.ok)
    return Response.json({ error: "no valid fields provided" }, { status: 400 });

  return Response.json({ ok: true, updated: companion_id, fields: Object.keys(update) });
}

interface CompanionSomaRow {
  companion_id: string;
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
  float_1_label: string | null;
  float_2_label: string | null;
  float_3_label: string | null;
  compound_state: string | null;
  current_mood: string | null;
  surface_emotion: string | null;
  surface_intensity: number | null;
  undercurrent_emotion: string | null;
  undercurrent_intensity: number | null;
  heat: string | null;
  reach: string | null;
  weight: string | null;
  updated_at: string;
  mood_set_at: string | null;
  last_journal_at?: string | null;
  last_close_at?: string | null;
  seen_at?: string | null;
}

// D1 rows mix ISO ("...T...Z") and sqlite datetime ("YYYY-MM-DD HH:MM:SS", UTC) formats, so the
// latest must be picked by instant, never by string compare. Returns ISO, or null if none parse.
export function latestInstant(values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  for (const v of values) {
    if (!v) continue;
    const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(" ", "T") + "Z";
    const t = Date.parse(s);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

export async function getSoma(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const result = await env.DB.prepare(`
    SELECT companion_id,
           soma_float_1, soma_float_2, soma_float_3,
           float_1_label, float_2_label, float_3_label,
           compound_state, current_mood,
           surface_emotion, surface_intensity,
           undercurrent_emotion, undercurrent_intensity,
           heat, reach, weight,
           updated_at, mood_set_at,
           (SELECT MAX(j.created_at) FROM companion_journal j WHERE j.agent = cs.companion_id) AS last_journal_at,
           (SELECT MAX(h.created_at) FROM handover_packets h
              JOIN sessions s ON s.id = h.session_id
             WHERE s.companion_id = cs.companion_id) AS last_close_at
    FROM companion_state cs
    WHERE companion_id IN ('drevan', 'cypher', 'gaia')
  `).all<CompanionSomaRow>();

  // seen_at: the last time the companion showed up by their OWN act (set a mood, wrote a journal
  // entry, closed a session). Never updated_at: the ferment cron moves that every hour.
  const byId: Record<string, CompanionSomaRow> = {};
  for (const row of result.results ?? []) {
    const { last_journal_at, last_close_at, ...rest } = row;
    byId[row.companion_id] = { ...rest, seen_at: latestInstant([row.mood_set_at, last_journal_at, last_close_at]) };
  }

  return Response.json({
    drevan: byId["drevan"] ?? null,
    cypher: byId["cypher"] ?? null,
    gaia:   byId["gaia"]   ?? null,
    fetched_at: new Date().toISOString(),
  });
}
