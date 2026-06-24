// src/handlers/imps.ts
//
// Activation log for the imps reply-flavor layer (wave 2, IMP_GRAMMAR.md).
// Imps have no autonomy and no identity -- this table is the instrument only:
// what fired when, off what state. Settings (imps_enabled, hex_enabled) live in
// the existing companion_settings KV table; no columns added here.
//
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
}

const IMPS = new Set(["iris", "nimbus", "hex", "mossling", "rock"]);
const COMPS = new Set(["cypher", "drevan", "gaia"]);

export function validateActivation(imp: string, companion_id: string): string | null {
  if (!IMPS.has(imp)) return "imp must be one of iris, nimbus, hex, mossling, rock";
  if (!COMPS.has(companion_id)) return "companion_id must be one of cypher, drevan, gaia";
  return null;
}

// POST /mind/imp-activations
// body: { imp, companion_id, trigger? }
export async function postImpActivation(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: { imp?: string; companion_id?: string; trigger?: string };
  try { b = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const err = validateActivation(b.imp ?? "", b.companion_id ?? "");
  if (err) return json({ error: err }, 400);

  try {
    const id = `ia_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO imp_activations (id, imp, companion_id, trigger) VALUES (?, ?, ?, ?)"
    ).bind(
      id,
      b.imp,
      b.companion_id,
      typeof b.trigger === "string" ? b.trigger.slice(0, 200) : null,
    ).run();
    return json({ id }, 201);
  } catch (e) {
    console.error("[mind/imp-activations] write error", String(e));
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/imp-activations?limit=
export async function getImpActivations(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);

  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM imp_activations ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
    return json({ activations: rows.results ?? [] });
  } catch (e) {
    console.error("[mind/imp-activations] read error", String(e));
    return json({ error: "Internal server error" }, 500);
  }
}
