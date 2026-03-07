import { Env, HandoverPacket } from "../types.js";

// GET /handovers?limit=N — returns handover packets, newest first.
export async function getHandovers(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);

  const result = await env.DB.prepare(
    "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all<HandoverPacket>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
