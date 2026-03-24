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

export async function getMember(env: Env, member_input: string): Promise<{ name: string; member_id: string; description?: string } | null> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_input }),
    }));
    if (!res.ok) return null;
    return await res.json() as { name: string; member_id: string; description?: string };
  } catch {
    return null;
  }
}

export async function updateMemberDescription(env: Env, member_input: string, description: string): Promise<{ success: boolean; member_id?: string; name?: string; error?: string }> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/update-description", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_input, description }),
    }));
    const data = await res.json() as { success: boolean; member_id?: string; name?: string; error?: string };
    return data;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function searchMembers(env: Env, query: string): Promise<{ name: string; pk: string; description?: string }[]> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/search-members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }));
    if (!res.ok) return [];
    return await res.json() as { name: string; pk: string; description?: string }[];
  } catch {
    return [];
  }
}

export async function getFrontHistory(env: Env, limit?: number): Promise<{ member_id: string; name: string; startTime: number }[]> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/front-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    }));
    if (!res.ok) return [];
    return await res.json() as { member_id: string; name: string; startTime: number }[];
  } catch {
    return [];
  }
}

export async function logFrontChange(env: Env, params: {
  member_id: string;
  status: "fronting" | "co-con" | "unknown";
  custom_status?: string;
}): Promise<{ success: boolean; result?: string; front_id?: string | null; member_id?: string; name?: string; error?: string }> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/log-front-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }));
    return await res.json() as { success: boolean; result?: string; front_id?: string | null; member_id?: string; name?: string; error?: string };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function addMemberNote(env: Env, params: {
  member_id: string;
  note: string;
  title?: string;
  color?: string;
}): Promise<{ success: boolean; id?: string | null; member_id?: string; name?: string; error?: string }> {
  try {
    const res = await env.PLURAL.fetch(new Request("https://plural/internal/add-member-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }));
    return await res.json() as { success: boolean; id?: string | null; member_id?: string; name?: string; error?: string };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
