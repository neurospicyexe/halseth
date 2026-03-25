import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

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
