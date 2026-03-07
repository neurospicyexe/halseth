import { Env, LivingWound } from "../types.js";

// GET /wounds — returns all living wounds, newest first.
// Living wounds are never archived or auto-resolved.
export async function getWounds(_request: Request, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT * FROM living_wounds ORDER BY created_at DESC"
  ).all<LivingWound>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
