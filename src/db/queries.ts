import { Env } from "../types";

// Lightweight ID generator — crypto.randomUUID is available in Workers.
export function generateId(): string {
  return crypto.randomUUID();
}

// Convenience: verify a companion exists and 404 early if not.
export async function assertCompanionExists(
  env: Env,
  companionId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM companions WHERE id = ? LIMIT 1"
  ).bind(companionId).first();
  return row !== null;
}
