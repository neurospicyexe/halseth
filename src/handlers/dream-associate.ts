// src/handlers/dream-associate.ts
//
// Dream engine expansion (migration -- none; reuses companion_dreams; inspo take 3).
//   POST /mind/dreams/associate   { companion_id?, window_days? }
//
// Runs the deterministic association modes (webmind/dream-modes.ts) over each target
// companion's recent growth_journal, and writes any surfaced dreams as companion_dreams
// rows (source='autonomous') -- held at orient until examined. Dedup: an identical
// unexamined dream is skipped so daily runs don't pile duplicates. Auth: authGuard.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { associateDreams, type DreamDoc } from "../webmind/dream-modes.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const COMPANIONS = ["cypher", "drevan", "gaia"] as const;

export async function associateDreamsHandler(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; window_days?: number } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  const targets = body.companion_id && (COMPANIONS as readonly string[]).includes(body.companion_id)
    ? [body.companion_id]
    : [...COMPANIONS];
  const windowDays = Math.min(Math.max(Number(body.window_days) || 14, 1), 90);

  try {
    const perCompanion: Record<string, number> = {};
    for (const id of targets) {
      const rows = await env.DB.prepare(
        `SELECT content AS text, created_at FROM growth_journal
         WHERE companion_id = ? AND created_at > datetime('now','-' || ? || ' days')
         ORDER BY created_at DESC LIMIT 100`,
      ).bind(id, windowDays).all<DreamDoc>();
      const docs = (rows.results ?? []).filter(d => d.text && d.text.trim().length > 0);

      const dreams = associateDreams(docs);
      let written = 0;
      for (const dreamText of dreams) {
        // Dedup against existing unexamined dreams for this companion.
        const existing = await env.DB.prepare(
          "SELECT id FROM companion_dreams WHERE companion_id = ? AND examined = 0 AND dream_text = ?",
        ).bind(id, dreamText).first<{ id: string }>();
        if (existing) continue;
        await env.DB.prepare(
          "INSERT INTO companion_dreams (id, companion_id, dream_text, source, do_not_auto_examine, created_at) VALUES (?, ?, ?, 'autonomous', 0, datetime('now'))",
        ).bind(crypto.randomUUID(), id, dreamText).run();
        written++;
      }
      perCompanion[id] = written;
    }
    return json({ ok: true, written: perCompanion });
  } catch (err) {
    console.error("[mind/dreams/associate] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
