// src/librarian/backends/plural.ts
//
// Wrapper for nullsafe-plural-v2 Service Binding.
// IMPORTANT: Plural fronters are Raziel's system members.
// Companions (Cypher/Drevan/Gaia) are a separate identity layer.
// The front_state value from this module feeds into session_open -- it is NOT companion identity.

import { Env } from "../../types.js";

export interface FrontState {
  member_name: string;
  display_name: string | null;
  started_at: string | null;
}

export async function getCurrentFront(env: Env): Promise<FrontState | null> {
  try {
    const response = await env.PLURAL.fetch("https://plural-internal/get_current_front", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) return null;
    const data = await response.json() as { result?: { content?: Array<{ text: string }> } };
    const text = data?.result?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as FrontState;
  } catch {
    // Plural unavailable is non-fatal -- session opens with front_state: null
    return null;
  }
}
