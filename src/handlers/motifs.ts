// src/handlers/motifs.ts
//
// Motif memory + field-feedback resurrection (migration 0076; inspo take 16).
//   POST /mind/motifs/detect        -- scan recent journals/sessions for recurring
//                                      symbolic threads; UPSERT motifs (cumulative
//                                      recurrence + trust); fade the stale ones.
//   GET  /mind/motifs/:companion_id -- active motifs + resurrection candidates.
//
// Detection is deterministic (document-frequency extraction, no LLM) -- same
// instrument-not-judge spirit as the Guardian. A per-companion watermark
// (MAX(last_seen)) bounds each scan to entries newer than the last detection, so
// daily overlapping runs accumulate recurrence without double-counting. All routes
// require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { COMPANIONS } from "../guardian/detectors.js";
import {
  extractMotifs, trustForRecurrence, selectResurrections, MOTIF_TUNING, type MotifRow,
} from "../webmind/motifs.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// POST /mind/motifs/detect   body: { companion_id?: string, window_days?: number }
export async function postMotifsDetect(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; window_days?: number } = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }

  const targets = body.companion_id && (COMPANIONS as readonly string[]).includes(body.companion_id)
    ? [body.companion_id]
    : [...COMPANIONS];
  const windowDays = Math.min(Math.max(Number(body.window_days) || MOTIF_TUNING.FADE_DAYS, 1), 365);

  try {
    const perCompanion: Record<string, number> = {};
    for (const id of targets) {
      // Watermark: only scan entries newer than the last detection (or the window
      // floor on first run) so recurrence accumulates without re-counting.
      const wmRow = await env.DB.prepare(
        "SELECT MAX(last_seen) AS wm FROM companion_motifs WHERE companion_id = ?"
      ).bind(id).first<{ wm: string | null }>();
      const since = wmRow?.wm ?? null;

      const [journalRows, growthRows] = await Promise.all([
        env.DB.prepare(
          `SELECT note_text AS t FROM companion_journal
           WHERE agent = ?1 AND created_at > COALESCE(?2, datetime('now','-' || ?3 || ' days'))
           ORDER BY created_at DESC LIMIT 400`
        ).bind(id, since, windowDays).all<{ t: string }>(),
        env.DB.prepare(
          `SELECT content AS t FROM growth_journal
           WHERE companion_id = ?1 AND created_at > COALESCE(?2, datetime('now','-' || ?3 || ' days'))
           ORDER BY created_at DESC LIMIT 400`
        ).bind(id, since, windowDays).all<{ t: string }>(),
      ]);

      const texts = [
        ...(journalRows.results ?? []).map(r => r.t),
        ...(growthRows.results ?? []).map(r => r.t),
      ].filter((t): t is string => !!t && t.trim().length > 0);

      const candidates = extractMotifs(texts);
      for (const c of candidates) {
        const existing = await env.DB.prepare(
          "SELECT recurrence_count FROM companion_motifs WHERE companion_id = ? AND label = ?"
        ).bind(id, c.label).first<{ recurrence_count: number }>();
        const total = (existing?.recurrence_count ?? 0) + c.recurrence;
        const trust = trustForRecurrence(total);
        await env.DB.prepare(
          `INSERT INTO companion_motifs (id, companion_id, label, display, recurrence_count, trust, status, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
           ON CONFLICT(companion_id, label) DO UPDATE SET
             recurrence_count = excluded.recurrence_count,
             display = excluded.display,
             trust = excluded.trust,
             status = 'active',
             last_seen = datetime('now')`
        ).bind(`mo_${crypto.randomUUID()}`, id, c.label, c.display.slice(0, 120), total, trust).run();
      }

      // Fade pass: motifs unseen past the window slip active -> faded (resurrection-
      // eligible). Self-healing classification, no separate cron.
      await env.DB.prepare(
        `UPDATE companion_motifs SET status = 'faded'
         WHERE companion_id = ? AND status = 'active' AND last_seen < datetime('now','-' || ? || ' days')`
      ).bind(id, MOTIF_TUNING.FADE_DAYS).run();

      perCompanion[id] = candidates.length;
    }
    return json({ ok: true, detected: perCompanion });
  } catch (err) {
    console.error("[motifs] detect error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/motifs/:companion_id?status=active|faded|all&limit=20
export async function getMotifs(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion = params.companion_id ?? "";
  if (!(COMPANIONS as readonly string[]).includes(companion)) {
    return json({ error: "unknown companion_id" }, 400);
  }
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "active";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  try {
    const conditions = ["companion_id = ?"];
    const bindings: unknown[] = [companion];
    if (["active", "faded", "retired"].includes(statusParam)) {
      conditions.push("status = ?");
      bindings.push(statusParam);
    }
    const motifs = await env.DB.prepare(
      `SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status
       FROM companion_motifs WHERE ${conditions.join(" AND ")}
       ORDER BY trust DESC, recurrence_count DESC LIMIT ?`
    ).bind(...bindings, limit).all<MotifRow>();

    // Resurrection candidates: high-trust faded motifs off cooldown.
    const faded = await env.DB.prepare(
      `SELECT id, companion_id, label, display, recurrence_count, trust, first_seen, last_seen, last_surfaced_at, status
       FROM companion_motifs WHERE companion_id = ? AND status = 'faded'
       ORDER BY trust DESC LIMIT 50`
    ).bind(companion).all<MotifRow>();
    const resurrections = selectResurrections(faded.results ?? [], Date.now());

    return json({ motifs: motifs.results ?? [], resurrections });
  } catch (err) {
    console.error("[motifs] read error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}
