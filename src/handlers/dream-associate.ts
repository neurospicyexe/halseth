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
import { associateDreams, dreamDedupKey, type DreamDoc } from "../webmind/dream-modes.js";

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
        `SELECT content AS text, created_at, run_id FROM growth_journal
         WHERE companion_id = ? AND created_at > datetime('now','-' || ? || ' days')
         ORDER BY created_at DESC LIMIT 100`,
      ).bind(id, windowDays).all<DreamDoc & { run_id: string | null }>();
      const docs = (rows.results ?? []).filter(d => d.text && d.text.trim().length > 0);
      // Temporal (cadence) mode only sees entries whose timestamps a companion chose:
      // run_id IS NOT NULL rows are written by the autonomous worker's cron, so their
      // hour-of-day is the schedule, not a rhythm (2026-07-05: the daily "07:00-09:00
      // UTC" dream was the worker's own crontab reflected back).
      const liveDocs = docs.filter(d => d.run_id == null);

      const dreams = associateDreams(docs, liveDocs);
      let written = 0;
      for (const dreamText of dreams) {
        // Dedup structurally (counts stripped) against ALL dreams in the window --
        // examined or not. Exact-text + unexamined-only meant every examined dream
        // was reissued next morning with the count ticked by one.
        const recent = await env.DB.prepare(
          `SELECT dream_text FROM companion_dreams
           WHERE companion_id = ? AND created_at > datetime('now','-' || ? || ' days')`,
        ).bind(id, windowDays).all<{ dream_text: string }>();
        const key = dreamDedupKey(dreamText);
        if ((recent.results ?? []).some(r => dreamDedupKey(r.dream_text) === key)) continue;
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
