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

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) {
    return null;
  }
  const auth = request.headers.get("Authorization") ?? "";
  const validSecrets = [env.ADMIN_SECRET, env.MCP_AUTH_SECRET].filter(Boolean) as string[];
  if (!validSecrets.some(s => safeEqual(auth, `Bearer ${s}`))) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
