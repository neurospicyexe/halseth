// src/handlers/plural-store.ts
// HTTP handlers for /plural/* endpoints (Halseth-native plural store).

import type { Env } from "../types.js";
import {
  listSystemMembers, findMemberByName, upsertMember,
  logAlterNote, recallAlter, logFrontEvent, getCurrentFronters,
  type SystemMember,
} from "../librarian/backends/plural-store.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function getPluralMembers(_request: Request, env: Env): Promise<Response> {
  try {
    return json(await listSystemMembers(env));
  } catch (err) {
    console.error("[plural/members] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}

export async function postPluralMember(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as Partial<SystemMember> & { name?: string };
    if (!body.name) return json({ error: "name required" }, 400);
    // Prevent silent duplicate creation: check for existing member with same name
    const existing = await findMemberByName(env, body.name);
    if (existing && existing.name.toLowerCase() === body.name.toLowerCase() && !body.id) {
      return json({ error: `member '${body.name}' already exists (id: ${existing.id}). Provide id to update.` }, 409);
    }
    const id = await upsertMember(env, body as Partial<SystemMember> & { name: string });
    return json({ id });
  } catch (err) {
    console.error("[plural/members POST] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}

export async function getPluralMemberByName(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const { name } = params;
  if (!name) return json({ error: "name param required" }, 400);
  try {
    return json(await recallAlter(env, decodeURIComponent(name)));
  } catch (err) {
    console.error("[plural/members/:name] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}

export async function postPluralNote(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { member_name?: string; note?: string; source?: string; session_id?: string };
    if (!body.member_name || !body.note || !body.source) {
      return json({ error: "member_name, note, and source required" }, 400);
    }
    const member = await findMemberByName(env, body.member_name);
    if (!member) return json({ error: `member '${body.member_name}' not found` }, 404);
    const id = await logAlterNote(env, member.id, body.note, body.source, body.session_id ?? null);
    return json({ id, member_id: member.id, member_name: member.name });
  } catch (err) {
    console.error("[plural/notes POST] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}

export async function getPluralFront(_request: Request, env: Env): Promise<Response> {
  try {
    return json(await getCurrentFronters(env));
  } catch (err) {
    console.error("[plural/front] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}

export async function postPluralFront(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { member_name?: string; status?: string; custom_status?: string; session_id?: string };
    if (!body.member_name || !body.status) return json({ error: "member_name and status required" }, 400);
    if (!["fronting", "co-con", "unknown"].includes(body.status.toLowerCase())) {
      return json({ error: "status must be fronting, co-con, or unknown" }, 400);
    }
    const member = await findMemberByName(env, body.member_name);
    if (!member) return json({ error: `member '${body.member_name}' not found` }, 404);
    const id = await logFrontEvent(
      env, member.id,
      body.status.toLowerCase() as "fronting" | "co-con" | "unknown",
      body.custom_status ?? null,
      body.session_id ?? null,
    );
    return json({ id, member_id: member.id, member_name: member.name });
  } catch (err) {
    console.error("[plural/front POST] error", String(err));
    return json({ error: "internal error" }, 500);
  }
}
