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

// Per-companion env var keys. Reuses the same env vars librarian/index.ts
// already validates against (handleLibrarian -> resolveCompanionFromToken).
// Sharing the variable names means a single per-companion token works for
// BOTH the /librarian endpoint AND general HTTP routes -- one token per
// companion to provision and rotate, not two.
export const COMPANION_TOKEN_KEYS = {
  drevan: "DREVAN_MCP_SECRET",
  cypher: "CYPHER_MCP_SECRET",
  gaia:   "GAIA_MCP_SECRET",
} as const;

export type AuthIdentity = "drevan" | "cypher" | "gaia";

export const VALID_COMPANIONS: ReadonlySet<string> = new Set(Object.keys(COMPANION_TOKEN_KEYS));

/**
 * Returns the companion identity that issued this request, OR null if the
 * caller authenticated with an admin-tier token (ADMIN_SECRET / MCP_AUTH_SECRET)
 * or no per-companion token matched.
 *
 * C.2a phase: this is information-only. No route currently REJECTS based on
 * the result. Future C.2c will enforce: routes that take agent_id in body
 * must reject if identifyCallerCompanion(...) is set and doesn't match.
 *
 * Returning null means "either admin or unauthenticated -- caller should
 * still pass through authGuard separately to confirm the request is allowed."
 */
export function identifyCallerCompanion(request: Request, env: Env): AuthIdentity | null {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth) return null;
  for (const [id, key] of Object.entries(COMPANION_TOKEN_KEYS)) {
    const secret = env[key as keyof Env] as string | undefined;
    if (secret && safeEqual(auth, `Bearer ${secret}`)) {
      return id as AuthIdentity;
    }
  }
  return null;
}

/**
 * Auth gate for general HTTP routes (orient, /mind/*, /handovers, etc.).
 * Backward-compatible: every existing caller continues to work.
 *
 * Accepted token sources (any one passes):
 *   - ADMIN_SECRET           (admin tier; full access)
 *   - MCP_AUTH_SECRET        (admin tier; same scope as ADMIN_SECRET here)
 *   - DREVAN_MCP_SECRET      (companion tier; new in C.2a, no enforcement yet)
 *   - CYPHER_MCP_SECRET      (companion tier; new in C.2a, no enforcement yet)
 *   - GAIA_MCP_SECRET        (companion tier; new in C.2a, no enforcement yet)
 *
 * If ADMIN_SECRET is unset, auth is skipped entirely (local dev convenience).
 *
 * NOT extended for admin-tier endpoints (admin.ts, oauth.ts) -- those keep
 * their inline ADMIN_SECRET-only checks. A leaked companion token must NOT
 * grant OAuth-issuance or schema-touching powers.
 */
export function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  const auth = request.headers.get("Authorization") ?? "";

  // Admin-tier tokens.
  const adminSecrets = [env.ADMIN_SECRET, env.MCP_AUTH_SECRET].filter(Boolean) as string[];
  if (adminSecrets.some((s) => safeEqual(auth, `Bearer ${s}`))) return null;

  // Companion-tier tokens (opt-in -- only checked when at least one is configured).
  const companionSecrets = (Object.values(COMPANION_TOKEN_KEYS)
    .map((key) => env[key as keyof Env] as string | undefined)
    .filter(Boolean)) as string[];
  if (companionSecrets.length > 0
      && companionSecrets.some((s) => safeEqual(auth, `Bearer ${s}`))) {
    return null;
  }

  return new Response("Unauthorized", { status: 401 });
}
