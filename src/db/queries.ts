import { Env } from "../types";
import type { Session, HandoverPacket } from "../types";

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

// Returns the most recent open session (no handover_id set), or null.
export async function getOpenSession(env: Env): Promise<Session | null> {
  return env.DB.prepare(
    "SELECT * FROM sessions WHERE handover_id IS NULL ORDER BY created_at DESC LIMIT 1"
  ).first<Session>();
}

// Returns the most recent handover packet, or null.
export async function getLatestHandover(env: Env): Promise<HandoverPacket | null> {
  return env.DB.prepare(
    "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
  ).first<HandoverPacket>();
}
