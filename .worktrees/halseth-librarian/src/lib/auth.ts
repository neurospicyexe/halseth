import { Env } from "../types.js";

export function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
