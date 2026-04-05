import { Env } from "../types.js";

/**
 * Constant-time string comparison using Web Crypto API.
 * Prevents timing attacks on secret comparison.
 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

export function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) {
    return new Response("Service unavailable: ADMIN_SECRET not configured", { status: 503 });
  }
  const auth = request.headers.get("Authorization") ?? "";
  const validSecrets = [env.ADMIN_SECRET, env.MCP_AUTH_SECRET].filter(Boolean) as string[];
  if (!validSecrets.some(s => safeEqual(auth, `Bearer ${s}`))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
