// src/handlers/guardian.ts
//
// Unified Guardian (migration 0073): meta-observer endpoints.
//   POST  /mind/guardian/run        -- run all detectors; insert deduped flags;
//                                      auto-resolve cleared conditions; optional weekly letter
//   GET   /mind/guardian/flags      -- ?status=&companion_id=&limit=
//   PATCH /mind/guardian/flags/:id  -- { status: 'acknowledged'|'resolved' }
//
// The Guardian is an instrument, not a judge: deterministic SQL only, every
// flag carries evidence_json, and the weekly letter is assembled prose, not
// inference. All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { runAllDetectors, COMPANIONS } from "../guardian/detectors.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// POST /mind/guardian/run   body: { letter?: boolean }
export async function postGuardianRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { letter?: boolean; catchup?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const writeLetter = body.letter === true;

  // Catch-up calls (fired on autonomous-worker startup) no-op if the Guardian already ran
  // recently. node-cron timers are in-memory, so a worker restart resets them and a restart
  // landing after the daily 8AM slot silently skips that day -- that is how the Guardian
  // napped 2026-06-26 -> 06-28. The startup catch-up recovers a genuine nap on the next
  // restart; this 18h guard stops it from spamming runs on rapid restarts.
  if (body.catchup === true) {
    const recent = await env.DB
      .prepare("SELECT 1 AS x FROM guardian_runs WHERE ran_at >= datetime('now','-18 hours') LIMIT 1")
      .first<{ x: number }>()
      .catch(() => null);
    if (recent) {
      return json({ skipped: true, reason: "guardian ran within 18h", flags_created: 0, flags_resolved: 0, letter_id: null });
    }
  }

  try {
    const candidates = await runAllDetectors(env);

    // Insert new flags; the partial unique index on dedup_key makes re-detection a no-op.
    let created = 0;
    for (const f of candidates) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO guardian_flags (id, companion_id, flag_type, severity, summary, evidence_json, dedup_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `gf_${crypto.randomUUID()}`, f.companion_id, f.flag_type, f.severity,
        f.summary.slice(0, 500), JSON.stringify(f.evidence).slice(0, 2000), f.dedup_key,
      ).run();
      created += res.meta.changes ?? 0;
    }

    // Auto-resolve live flags whose condition no longer holds (self-healing,
    // same spirit as the vault materializer's orphan cleanup).
    const liveKeys = candidates.map(f => f.dedup_key);
    const notIn = liveKeys.length > 0
      ? ` AND dedup_key NOT IN (${liveKeys.map(() => "?").join(",")})`
      : "";
    const resolveRes = await env.DB.prepare(
      `UPDATE guardian_flags SET status = 'resolved', resolved_at = datetime('now')
       WHERE status IN ('open','surfaced','acknowledged')` + notIn
    ).bind(...liveKeys).run();
    const resolved = resolveRes.meta.changes ?? 0;

    let letterId: string | null = null;
    if (writeLetter) letterId = await composeWeeklyLetter(env);

    await env.DB.prepare(
      `INSERT INTO guardian_runs (id, mode, flags_created, flags_resolved, stats_json) VALUES (?, ?, ?, ?, ?)`
    ).bind(
      `gr_${crypto.randomUUID()}`, writeLetter ? "letter" : "tick", created, resolved,
      JSON.stringify({ candidates: candidates.length }),
    ).run();

    return json({ flags_created: created, flags_resolved: resolved, candidates: candidates.length, letter_id: letterId });
  } catch (err) {
    console.error("[guardian] run error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

// Weekly letter: deterministic meta-commentary to Raziel from the week's flags
// + stats. Written to companion_journal with agent='guardian' (0012 has no
// CHECK on agent) and the letter_to_raziel tag Hearth /journal already surfaces.
async function composeWeeklyLetter(env: Env): Promise<string> {
  const [weekFlags, live, voiceRows, runRows, tensions, pendingRows] = await Promise.all([
    env.DB.prepare(
      `SELECT flag_type, severity, summary, status FROM guardian_flags
       WHERE created_at >= datetime('now','-7 days')
       ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 20`
    ).all<{ flag_type: string; severity: string; summary: string; status: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM guardian_flags WHERE status IN ('open','surfaced','acknowledged')`
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT companion_id, ROUND(AVG(score), 2) AS avg, COUNT(*) AS n FROM voice_scores
       WHERE created_at >= datetime('now','-7 days') GROUP BY companion_id`
    ).all<{ companion_id: string; avg: number; n: number }>(),
    env.DB.prepare(
      `SELECT companion_id, COUNT(*) AS n FROM autonomy_runs
       WHERE status = 'completed' AND created_at >= datetime('now','-7 days') GROUP BY companion_id`
    ).all<{ companion_id: string; n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM companion_tensions WHERE status = 'simmering'`
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM growth_journal WHERE source = 'autonomous' AND review_status = 'pending'`
    ).first<{ n: number }>(),
  ]);

  const lines: string[] = [];
  lines.push(`Guardian weekly read -- ${new Date().toISOString().slice(0, 10)}.`);
  const fr = weekFlags.results ?? [];
  if (fr.length === 0) {
    lines.push("No flags raised this week. The organs are feeding each other.");
  } else {
    lines.push(`${fr.length} flag${fr.length === 1 ? "" : "s"} this week (${live?.n ?? 0} still live):`);
    for (const f of fr.slice(0, 10)) lines.push(`- [${f.severity}] ${f.summary}`);
  }
  const voice = (voiceRows.results ?? []).map(v => `${v.companion_id} ${v.avg} (${v.n})`).join(", ");
  lines.push(`Voice averages (7d): ${voice || "no scored replies"}.`);
  const runs = (runRows.results ?? []).map(r => `${r.companion_id} ${r.n}`).join(", ");
  lines.push(`Completed autonomous runs (7d): ${runs || "none"}.`);
  lines.push(`Tension pool: ${tensions?.n ?? 0} simmering. Ratification queue: ${pendingRows?.n ?? 0} pending.`);

  const id = `cj_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'guardian', ?, ?)`
  ).bind(id, lines.join("\n").slice(0, 4000), JSON.stringify(["guardian", "letter_to_raziel"])).run();
  return id;
}

// GET /mind/guardian/flags?status=live&companion_id=cypher&limit=20
export async function getGuardianFlags(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "live";
  const companion = url.searchParams.get("companion_id");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (statusParam === "live") {
    conditions.push("status IN ('open','surfaced','acknowledged')");
  } else if (["open", "surfaced", "acknowledged", "resolved"].includes(statusParam)) {
    conditions.push("status = ?");
    bindings.push(statusParam);
  }
  if (companion && (COMPANIONS as readonly string[]).includes(companion)) {
    conditions.push("(companion_id = ? OR companion_id IS NULL)");
    bindings.push(companion);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM guardian_flags${where}
       ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`
    ).bind(...bindings, limit).all();
    return json({ flags: rows.results ?? [] });
  } catch (err) {
    console.error("[guardian] flags read error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/guardian/flags/:id   body: { status: 'acknowledged'|'resolved' }
export async function patchGuardianFlag(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { status?: string };
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const status = body.status ?? "";
  if (!["acknowledged", "resolved"].includes(status)) {
    return json({ error: "status must be 'acknowledged' or 'resolved'" }, 400);
  }

  try {
    const res = await env.DB.prepare(
      `UPDATE guardian_flags SET status = ?,
        resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END
       WHERE id = ? AND status != 'resolved'`
    ).bind(status, status, id).run();
    if (!res.meta.changes) return json({ error: "Flag not found or already resolved" }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error("[guardian] flag patch error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
