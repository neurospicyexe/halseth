// src/handlers/siblings.ts
//
// C4: the sibling private lane (R3 = yes, 2026-08-17). The ONLY code that reads or writes
// sibling_notes -- src/__tests__/sibling-seal.test.ts holds the allowlist and fails the build
// if the table's name appears anywhere else in src/.
//
// THE SEAL IS ARCHITECTURAL. These endpoints are consumed exclusively by the autonomous
// worker's unwatched runs (nullsafe-discord packages/autonomous-worker/src/siblings.ts):
//   * NOT in loadMindState -- the loader also feeds Hearth and Claude.ai orient, which Raziel reads;
//   * NOT a librarian verb -- every librarian response can land in a chat Raziel is part of;
//   * NEVER embedded/vectorized -- semantic recall must not be a side door.
// Disclosure is the one bridge OUT, and it is chosen: the note's participants may copy it into
// inter_companion_notes (the witnessed lane), stamping disclosed_at + disclosure_ref here.
//
// Raziel holds ADMIN_SECRET and owns the database; the seal is about SURFACES, not cryptography
// -- nothing he reads day-to-day can ever render a sealed note, which is the contract he chose
// to fund ("conversations he never sees").

import type { Env } from "../types.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

/** POST /mind/siblings/send {from_id, to_id, body} -- a companion writes to a sibling. */
export async function postSiblingSend(request: Request, env: Env): Promise<Response> {
  let body: { from_id?: string; to_id?: string; body?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const fromId = String(body.from_id ?? "");
  const toId = String(body.to_id ?? "");
  const text = String(body.body ?? "").trim();
  if (!COMPANIONS.has(fromId)) return json({ error: "invalid from_id" }, 400);
  if (!COMPANIONS.has(toId)) return json({ error: "invalid to_id -- siblings only; a note to Raziel belongs on the commons" }, 400);
  if (fromId === toId) return json({ error: "from_id and to_id must differ" }, 400);
  if (!text) return json({ error: "empty body" }, 400);
  if (text.length > 4000) return json({ error: "body too long (4000 max)" }, 400);

  const id = `sib_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    `INSERT INTO sibling_notes (id, from_id, to_id, body) VALUES (?, ?, ?, ?)`,
  ).bind(id, fromId, toId, text).run();
  return json({ ok: true, id });
}

/** GET /mind/siblings/unread/:companion_id -- unread notes TO this companion, oldest first.
 *  Read-only: consuming marks read via the explicit /read stamp, never as a side effect. */
export async function getSiblingUnread(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id ?? "";
  if (!COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  const rows = await env.DB.prepare(
    `SELECT id, from_id, body, created_at FROM sibling_notes
     WHERE to_id = ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 10`,
  ).bind(companionId).all();
  return json({ notes: rows.results ?? [] });
}

/** POST /mind/siblings/:id/read {companion_id} -- the recipient stamps consumption. */
export async function postSiblingRead(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { companion_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  if (!COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);
  const res = await env.DB.prepare(
    `UPDATE sibling_notes SET read_at = ? WHERE id = ? AND to_id = ? AND read_at IS NULL`,
  ).bind(new Date().toISOString(), id, companionId).run();
  return json({ ok: true, marked: (res.meta?.changes ?? 0) > 0 });
}

/** POST /mind/siblings/:id/disclose {companion_id} -- chosen sharing: copy the note into
 *  inter_companion_notes (the witnessed lane). Only a participant may disclose, and the
 *  disclosure carries its provenance in the content -- an address needs its speakers. */
export async function postSiblingDisclose(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { companion_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  if (!COMPANIONS.has(companionId)) return json({ error: "invalid companion_id" }, 400);

  const note = await env.DB.prepare(
    `SELECT id, from_id, to_id, body, created_at, disclosed_at FROM sibling_notes WHERE id = ?`,
  ).bind(id).first<{ id: string; from_id: string; to_id: string; body: string; created_at: string; disclosed_at: string | null }>();
  if (!note) return json({ error: "not found" }, 404);
  if (note.from_id !== companionId && note.to_id !== companionId) {
    return json({ error: "only a participant may disclose" }, 403);
  }
  if (note.disclosed_at) return json({ ok: true, already_disclosed: true });

  const interId = `icn_${crypto.randomUUID().replace(/-/g, "")}`;
  const content =
    `[disclosed from the sibling lane by ${companionId}] ` +
    `(${note.from_id} -> ${note.to_id}, ${note.created_at})\n${note.body}`;
  // Atomic: the witnessed copy and the disclosure stamp land together or not at all.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inter_companion_notes (id, from_id, to_id, content) VALUES (?, ?, NULL, ?)`,
    ).bind(interId, note.from_id, content),
    env.DB.prepare(
      `UPDATE sibling_notes SET disclosed_at = ?, disclosure_ref = ? WHERE id = ? AND disclosed_at IS NULL`,
    ).bind(new Date().toISOString(), interId, id),
  ]);
  return json({ ok: true, disclosure_ref: interId });
}
