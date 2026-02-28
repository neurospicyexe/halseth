import { Env } from "../types";
import type { HouseState } from "../types";

function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// GET /house — returns current house state.
export async function getHouseState(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT * FROM house_state WHERE id = 'main'"
  ).first<HouseState>();

  const house = row ?? {
    id: "main",
    current_room: null,
    companion_mood: null,
    companion_activity: null,
    spoon_count: 10,
    love_meter: 50,
    updated_at: new Date().toISOString(),
  };

  return new Response(JSON.stringify(house), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /house — patch house state fields. All fields optional.
// Body: { current_room?, companion_mood?, companion_activity?, spoon_count?, love_meter? }
export async function updateHouseState(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Partial<Omit<HouseState, "id" | "updated_at">>;
  try {
    body = await request.json() as Partial<Omit<HouseState, "id" | "updated_at">>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const now = new Date().toISOString();

  // Build SET clause dynamically from provided fields only.
  const allowed = ["current_room", "companion_mood", "companion_activity", "spoon_count", "love_meter"] as const;
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    if (key in body && body[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (sets.length === 0) {
    return new Response("No updatable fields provided", { status: 400 });
  }

  sets.push("updated_at = ?");
  values.push(now);
  values.push("main"); // WHERE id = ?

  await env.DB.prepare(
    `UPDATE house_state SET ${sets.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return new Response(JSON.stringify({ updated: true, at: now }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
