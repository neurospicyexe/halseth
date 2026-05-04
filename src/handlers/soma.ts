import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { updateCompanionState, type CompanionStateUpdate } from "../librarian/backends/halseth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

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
           updated_at
    FROM companion_state
    WHERE companion_id IN ('drevan', 'cypher', 'gaia')
  `).all<CompanionSomaRow>();

  const byId: Record<string, CompanionSomaRow> = {};
  for (const row of result.results ?? []) {
    byId[row.companion_id] = row;
  }

  return Response.json({
    drevan: byId["drevan"] ?? null,
    cypher: byId["cypher"] ?? null,
    gaia:   byId["gaia"]   ?? null,
    fetched_at: new Date().toISOString(),
  });
}
