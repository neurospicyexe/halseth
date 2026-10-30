import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

// Raziel's inbox: every letter a companion or system writer (steward, guardian) left for him.
// Source of truth is companion_journal rows tagged "letter" or "letter_to_raziel"; read marks live in
// raziel_reads (item_kind = 'letter'), written only by POST /raziel/inbox/read.

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// The LIKE term matches the partial index idx_companion_journal_letters (mig 0153) word for word, so the
// planner can use it. json_each gets '[]' for non-JSON tags: SQLite does not promise AND short-circuits,
// so json_valid alone would not stop one malformed row from failing the whole list with "malformed JSON".
const LETTER_WHERE =
  "j.tags LIKE '%letter%' AND json_valid(j.tags) " +
  "AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(j.tags) THEN j.tags ELSE '[]' END) " +
  "WHERE value IN ('letter','letter_to_raziel')) " +
  "AND COALESCE(j.review_state,'') <> 'dropped'";

const SELECT_ITEM =
  "SELECT j.id, j.agent, j.created_at, j.note_text, (r.item_id IS NOT NULL) AS is_read " +
  "FROM companion_journal AS j " +
  "LEFT JOIN raziel_reads r ON r.item_kind = 'letter' AND r.item_id = j.id ";

interface InboxItem {
  id: string;
  kind: "letter";
  agent: string;
  created_at: string;
  preview: string;
  text: string;
  read: boolean;
}

function toItem(row: any): InboxItem {
  const text = String(row.note_text ?? "");
  return {
    id: row.id,
    kind: "letter",
    agent: row.agent,
    created_at: row.created_at,
    preview: text.replace(/\s+/g, " ").trim().slice(0, 160),
    text,
    read: Boolean(row.is_read),
  };
}

export async function getRazielInbox(
  request: Request,
  env: Env,
  _params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const raw = parseInt(new URL(request.url).searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, isNaN(raw) ? 20 : raw), 100);

  const rows = await env.DB.prepare(
    `${SELECT_ITEM} WHERE ${LETTER_WHERE} ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
  ).bind(limit).all();
  // Counted over ALL matching rows, not the page.
  const unread = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_journal j " +
    "WHERE " + LETTER_WHERE + " " +
    "AND NOT EXISTS (SELECT 1 FROM raziel_reads r WHERE r.item_kind = 'letter' AND r.item_id = j.id)",
  ).first<{ n: number }>();

  return jsonRes({ items: (rows.results ?? []).map(toItem), unread_count: unread?.n ?? 0 });
}

export async function getRazielInboxItem(
  request: Request,
  env: Env,
  params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id;
  if (!id) return jsonRes({ error: "id required" }, 400);
  const row = await env.DB.prepare(`${SELECT_ITEM} WHERE j.id = ? AND ${LETTER_WHERE}`).bind(id).first();
  if (!row) return jsonRes({ error: "not found" }, 404);
  return jsonRes({ item: toItem(row) });
}

export async function postRazielInboxRead(
  request: Request,
  env: Env,
  _params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  let body: { ids?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonRes({ error: "invalid JSON" }, 400);
  }
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
      !ids.every((i) => typeof i === "string" && i.length > 0)) {
    return jsonRes({ error: "ids must be an array of 1..100 non-empty strings" }, 400);
  }
  const unique = [...new Set(ids as string[])];
  const results = await env.DB.batch(
    unique.map((id) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO raziel_reads (item_kind, item_id, read_at) VALUES ('letter', ?, datetime('now'))",
      ).bind(id)),
  );
  const marked = results.reduce((n: number, r: any) => n + (r?.meta?.changes ?? 0), 0);
  return jsonRes({ ok: true, marked });
}
