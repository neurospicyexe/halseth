// GET /mind/garden/gaia (mig 0171): Gaia's garden for Hearth. Pure D1, admin-gated like /mind/makes/*.
// The floor (care/health, living wounds, care hold) is applied at read inside readGarden.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { readGarden } from "../webmind/garden.js";

export async function getGardenGaia(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    return new Response(JSON.stringify(await readGarden(env)), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[garden] read error", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
