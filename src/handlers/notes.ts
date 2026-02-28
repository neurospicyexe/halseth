import { Env } from "../types";
import type { CompanionNote } from "../types";
import { generateId } from "../db/queries";

function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// GET /notes?limit=N — returns notes newest-first.
export async function getNotes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "20"), 100);

  const result = await env.DB.prepare(
    "SELECT id, author, content, note_type, created_at FROM companion_notes ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all<CompanionNote>();

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
