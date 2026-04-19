import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

const NUMERIC_SOMA_FIELDS = ["soma_float_1", "soma_float_2", "soma_float_3", "surface_intensity", "undercurrent_intensity"] as const;
const TEXT_SOMA_FIELDS = ["heat", "reach", "weight", "current_mood", "compound_state", "surface_emotion", "undercurrent_emotion"] as const;

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

  const cols: string[] = [];
  const bindings: unknown[] = [];

  for (const f of NUMERIC_SOMA_FIELDS) {
    if (typeof body[f] === "number" && isFinite(body[f] as number)) {
      cols.push(`${f} = ?`);
      bindings.push(Math.max(0, Math.min(1, body[f] as number)));
    }
  }
  for (const f of TEXT_SOMA_FIELDS) {
    if (typeof body[f] === "string" && (body[f] as string).trim()) {
      cols.push(`${f} = ?`);
      bindings.push((body[f] as string).trim().slice(0, 100));
    }
  }

  if (cols.length === 0)
    return Response.json({ error: "no valid fields provided" }, { status: 400 });

  await env.DB.prepare(
    "INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES (?, datetime('now'))"
  ).bind(companion_id).run();

  cols.push("updated_at = datetime('now')");
  bindings.push(companion_id);

  await env.DB.prepare(
    `UPDATE companion_state SET ${cols.join(", ")} WHERE companion_id = ?`
  ).bind(...bindings).run();

  return Response.json({ ok: true, updated: companion_id });
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
