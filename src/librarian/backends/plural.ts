// src/librarian/backends/plural.ts
//
// Wrapper for nullsafe-plural-v2 Service Binding.
// IMPORTANT: Plural fronters are Raziel's system members.
// Companions (Cypher/Drevan/Gaia) are a separate identity layer.
// The front_state value from this module feeds into session_open -- it is NOT companion identity.

import { Env } from "../../types.js";

export interface FrontState {
  name: string;
  member_id: string;
}

export async function getCurrentFront(env: Env): Promise<FrontState | null> {
  try {
    const response = await env.PLURAL.fetch("https://plural-internal/internal/front", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return null;
    const data = await response.json() as FrontState | null;
    return data ?? null;
  } catch {
    // Plural unavailable is non-fatal -- session opens with front_state: null
    return null;
  }
}
