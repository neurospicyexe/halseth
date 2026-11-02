import { Env } from "../types";
import type { CompanionNote } from "../types";
import { generateId } from "../db/queries";
import { authGuard } from "../lib/auth.js";

/**
 * Build the note_type predicate. A trailing `*` means prefix match (literal prefix, LIKE
 * wildcards escaped); any other value is an exact match. Null = invalid (empty or over 64).
 * The value is returned as a bind, never spliced into SQL.
 */
export function noteTypeClause(raw: string): { sql: string; bind: string } | null {
  const v = raw.trim();
  if (v.length < 1 || v.length > 64) return null;
  if (v.endsWith("*")) {
    const prefix = v.slice(0, -1).replace(/[\\%_]/g, (c) => "\\" + c);
    return { sql: "note_type LIKE ? ESCAPE '\\'", bind: prefix + "%" };
  }
  return { sql: "note_type = ?", bind: v };
}

// GET /notes?limit=N&note_type=<exact | prefix*> — returns notes newest-first.
export async function getNotes(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);

  const rawType = url.searchParams.get("note_type");
  let where = "";
  const binds: unknown[] = [];
  if (rawType !== null) {
    const clause = noteTypeClause(rawType);
    if (!clause) {
      return new Response(JSON.stringify({ error: "note_type must be 1 to 64 characters" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    where = ` WHERE ${clause.sql}`;
    binds.push(clause.bind);
  }
  binds.push(limit);

  const result = await env.DB.prepare(
    `SELECT id, author, content, note_type, created_at FROM companion_notes${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(...binds).all<CompanionNote>();

  return new Response(JSON.stringify(result.results ?? []), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /notes — { author, content, note_type? }
export async function createNote(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { author?: string; content?: string; note_type?: string };
  try {
    body = await request.json() as { author?: string; content?: string; note_type?: string };
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.author || !body.content) {
    return new Response("author and content are required", { status: 400 });
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO companion_notes (id, created_at, author, content, note_type) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, now, body.author, body.content, body.note_type ?? "message").run();

  return new Response(JSON.stringify({ id, created_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
