import { Env } from "../types.js";

export function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  // Accept either ADMIN_SECRET or MCP_AUTH_SECRET -- allows Discord bots (which
  // use HALSETH_SECRET = MCP_AUTH_SECRET) to call direct HTTP endpoints.
  const validSecrets = [env.ADMIN_SECRET, env.MCP_AUTH_SECRET].filter(Boolean);
  if (!validSecrets.some(s => auth === `Bearer ${s}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
