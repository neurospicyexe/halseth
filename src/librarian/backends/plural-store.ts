// src/librarian/backends/plural-store.ts
// Halseth-native plural store: D1 queries for system_members,
// system_member_notes, and front_events.
// Separate from backends/plural.ts (SimplyPlural API calls).

import type { Env } from "../../types.js";

export interface SystemMember {
  id: string;
  name: string;
  pronouns: string | null;
  role: string | null;
  age_presentation: string | null;
  description: string | null;
  affinity: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberNote {
  id: string;
  member_id: string;
  note: string;
  source: string;
  session_id: string | null;
  created_at: string;
}

export interface FrontEvent {
  id: string;
  member_id: string;
  name: string;
  status: "fronting" | "co-con" | "unknown";
  custom_status: string | null;
  started_at: string;
  ended_at: string | null;
}

export async function listSystemMembers(env: Env): Promise<SystemMember[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, pronouns, role, age_presentation, description, affinity, created_at, updated_at
     FROM system_members ORDER BY name COLLATE NOCASE`
  ).all<SystemMember>();
  return rows.results ?? [];
}

export async function findMemberByName(env: Env, name: string): Promise<SystemMember | null> {
  // Exact match first (case-insensitive); substring fallback only if no hit.
  // Prevents wrong-member writes when names share a substring (e.g. "Ray" vs "Rayven").
  const exact = await env.DB.prepare(
    `SELECT * FROM system_members WHERE name = ? COLLATE NOCASE LIMIT 1`
  ).bind(name).first<SystemMember>();
  if (exact) return exact;

  return env.DB.prepare(
    `SELECT * FROM system_members WHERE name LIKE ? COLLATE NOCASE ORDER BY name COLLATE NOCASE LIMIT 1`
  ).bind(`%${name}%`).first<SystemMember>();
}

/**
 * Upserts a system member.
 * Merge semantics: optional fields use COALESCE on update, so null or omitted
 * values DO NOT clear existing data. Exception: `name` always overwrites.
 * Use a dedicated update path if explicit field clearing is needed.
 * Provide `id` to update an existing member; omit `id` to insert new.
 */
export async function upsertMember(
  env: Env,
  data: Partial<SystemMember> & { name: string },
): Promise<string> {
  const id = data.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO system_members (id, name, pronouns, role, age_presentation, description, affinity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       pronouns = COALESCE(excluded.pronouns, pronouns),
       role = COALESCE(excluded.role, role),
       age_presentation = COALESCE(excluded.age_presentation, age_presentation),
       description = COALESCE(excluded.description, description),
       affinity = COALESCE(excluded.affinity, affinity),
       updated_at = excluded.updated_at`
  ).bind(id, data.name, data.pronouns ?? null, data.role ?? null,
          data.age_presentation ?? null, data.description ?? null,
          data.affinity ?? null, data.created_at ?? now, now).run();
  return id;
}

export async function logAlterNote(
  env: Env,
  memberId: string,
  note: string,
  source: string,
  sessionId: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO system_member_notes (id, member_id, note, source, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(id, memberId, note, source, sessionId).run();
  return id;
}

export async function recallAlter(
  env: Env,
  name: string,
): Promise<{ member: SystemMember | null; notes: MemberNote[] }> {
  const member = await findMemberByName(env, name);
  if (!member) return { member: null, notes: [] };
  const rows = await env.DB.prepare(
    `SELECT * FROM system_member_notes WHERE member_id = ? ORDER BY created_at DESC LIMIT 20`
  ).bind(member.id).all<MemberNote>();
  return { member, notes: rows.results ?? [] };
}

// Invariant: one active status per member at a time.
// Logging any new event (including co-con) closes all prior open events for that member.
// Co-con does not persist independently of fronting changes -- update by logging a new event.
export async function logFrontEvent(
  env: Env,
  memberId: string,
  status: "fronting" | "co-con" | "unknown",
  customStatus: string | null,
  sessionId: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE front_events SET ended_at = ? WHERE member_id = ? AND ended_at IS NULL`
    ).bind(now, memberId),
    env.DB.prepare(
      `INSERT INTO front_events (id, member_id, status, custom_status, session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, memberId, status, customStatus, sessionId, now),
  ]);
  return id;
}

export async function getCurrentFronters(env: Env): Promise<FrontEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT fe.id, fe.member_id, sm.name, fe.status, fe.custom_status, fe.started_at, fe.ended_at
     FROM front_events fe
     JOIN system_members sm ON sm.id = fe.member_id
     WHERE fe.ended_at IS NULL
     ORDER BY fe.started_at DESC LIMIT 20`
  ).all<FrontEvent>();
  return rows.results ?? [];
}
