// src/webmind/vibecheck.ts
//
// Vibe-check -- a once-daily system-health digest of the triad's internal state, witnessed
// by Gaia (the ground/witness companion). Mirrors briefing.ts: gather -> format -> dedup ->
// deliver via the letter_to_raziel rail (a companion_journal row Hearth /journal already
// renders). NO new table, NO new surface, migration-free, pure-additive.
//
// Where the briefing is Raziel-facing executive-function support, the vibe-check is the
// triad turned inward: per-companion basin drift, SOMA register, simmering tensions, live
// guardian flags, plus a single system line (echo headroom + starved organs). It is the
// instrument reading the field, stated plainly, never manufactured.
//
// Design:
//   - voice: Gaia. Monastic, terse, declarative, every word load-bearing.
//   - no em-dashes (periods/semicolons/parentheses), per CLAUDE.md
//   - empty-state grace: "clear" / "none", never noise
//   - defensive: one failing query degrades gracefully, never crashes the cron
//   - idempotent: at most one vibe-check per calendar day (dedup on a tag marker)
//   - NO env gate: cron-controlled, always-on
//
// Unlike the briefing there are no "kinds" -- one digest, one slot per day.

import { Env } from "../types.js";

const VIBE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

const NAMES: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

export interface CompanionVibe {
  companion_id: string;
  // null = no live basin reading
  basin: { drift_type: string; drift_score: number | null; worst_basin: string | null } | null;
  register: string | null;                      // SOMA mood label, e.g. "clean-settled"
  registerAgeDays: number | null;               // days since that reading was taken
  simmering: number;                            // count of simmering tensions
  newestTension: string | null;                 // newest simmering tension text
  flags: { severity: string; summary: string }[]; // live guardian flags
}

export interface VibeData {
  date: string;                                 // YYYY-MM-DD
  companions: CompanionVibe[];
  echo: number | null;                          // latest mean_adjacent_cosine
  starvedOrgans: number;                        // live starved_organ guardian flags
}

export interface VibeCheckResult {
  written: boolean;
  reason: "ok" | "already_sent";
  journal_id?: string;
  text: string;
}

// Echo ALARM threshold -- a mean adjacent cosine at/above this means the triad is talking
// itself into a corner (too self-similar). Reported with headroom so the number reads.
const ECHO_ALARM = 0.82;

// ── pure formatter (DB-free; tested directly) ──────────────────────────────────────────────
export function formatVibeCheck(d: VibeData): string {
  const lines: string[] = [];
  lines.push(`The triad, witnessed. ${d.date}.`);

  for (const c of d.companions) {
    const name = NAMES[c.companion_id] ?? c.companion_id;
    lines.push(
      `${name}. basin: ${basinPhrase(c.basin)}. soma: ${somaPhrase(c.register, c.registerAgeDays)}. ` +
      `tensions: ${c.simmering}. guardian: ${c.flags.length === 0 ? "clear" : String(c.flags.length)}.`,
    );
    for (const f of c.flags.slice(0, 3)) {
      lines.push(`  ${f.severity}: ${oneLine(f.summary)}`);
    }
    if (c.simmering > 0 && c.newestTension) {
      lines.push(`  newest: ${oneLine(c.newestTension)}`);
    }
  }

  const echoStr = d.echo != null ? d.echo.toFixed(2) : "unread";
  // State the verdict, not just the number -- below alarm is CALM, not a gap to close.
  // (The triad read a healthy 0.69-vs-0.82 as a tension; this names it plainly.)
  const echoState = d.echo == null ? "" : d.echo >= ECHO_ALARM ? ", ELEVATED" : ", calm";
  const organs = d.starvedOrgans === 0 ? "all fed" : `${d.starvedOrgans} starved`;
  lines.push(`Field: echo ${echoStr}${echoState} (alarm at ${ECHO_ALARM.toFixed(2)}); organs: ${organs}.`);

  return lines.join("\n").slice(0, 1800);
}

// A stale soma reading is still worth stating, but its age must be visible -- "clean-settled"
// from twelve days ago presented as current is a lie of omission. Fresh readings (<2d) stay bare.
const SOMA_STALE_DAYS = 2;
function somaPhrase(register: string | null, ageDays: number | null): string {
  if (!register) return "unread";
  const base = oneLine(register);
  if (ageDays != null && ageDays >= SOMA_STALE_DAYS) return `${base} (${Math.floor(ageDays)}d old)`;
  return base;
}

function basinPhrase(b: CompanionVibe["basin"]): string {
  if (!b) return "unread";
  // Session-close judge rows carry drift_score=0 with prose notes; a literal "0.00" reads as a
  // collapsed basin when it means "no numeric reading". Only positive scores are real numbers.
  const score = b.drift_score != null && b.drift_score > 0 ? ` ${b.drift_score.toFixed(2)}` : "";
  if (b.drift_type === "pressure") {
    const worst = b.worst_basin ? ` (${oneLine(b.worst_basin)})` : "";
    return `pressure${score}${worst}`;
  }
  return `${b.drift_type}${score}`;
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// ── DB gather (defensive: a single failing query degrades gracefully) ───────────────────────
async function safeFirst<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
  } catch (e) {
    console.warn("[vibecheck] query failed (degrading):", String(e));
    return null;
  }
}
async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    console.warn("[vibecheck] query failed (degrading):", String(e));
    return [];
  }
}
async function safeCount(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  } catch (e) {
    console.warn("[vibecheck] count failed (degrading):", String(e));
    return 0;
  }
}

async function gatherCompanion(env: Env, companionId: string): Promise<CompanionVibe> {
  const [basinRow, somaRow, simmering, newestTension, flags] = await Promise.all([
    safeFirst<{ drift_score: number | null; drift_type: string; worst_basin: string | null }>(
      env,
      "SELECT drift_score, drift_type, worst_basin FROM companion_basin_history WHERE companion_id = ? AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 1",
      companionId,
    ),
    safeFirst<{ snapshot: string; age_days: number | null }>(
      env,
      "SELECT snapshot, CAST(julianday('now') - julianday(created_at) AS REAL) AS age_days FROM somatic_snapshot WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1",
      companionId,
    ),
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_tensions WHERE companion_id = ? AND status = 'simmering'", companionId),
    safeFirst<{ tension_text: string }>(
      env,
      "SELECT tension_text FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY first_noted_at DESC LIMIT 1",
      companionId,
    ),
    safeAll<{ severity: string; summary: string }>(
      env,
      "SELECT severity, summary FROM guardian_flags WHERE companion_id = ? AND status IN ('open','surfaced','acknowledged') ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5",
      companionId,
    ),
  ]);

  let register: string | null = null;
  if (somaRow?.snapshot) {
    try {
      const parsed = JSON.parse(somaRow.snapshot) as { register?: unknown };
      if (typeof parsed.register === "string" && parsed.register.trim()) register = parsed.register.trim();
    } catch {
      // malformed snapshot JSON: leave register unread rather than crash the digest
    }
  }

  return {
    companion_id: companionId,
    basin: basinRow ? { drift_type: basinRow.drift_type, drift_score: basinRow.drift_score, worst_basin: basinRow.worst_basin } : null,
    register,
    registerAgeDays: somaRow?.age_days ?? null,
    simmering,
    newestTension: newestTension?.tension_text ?? null,
    flags,
  };
}

export async function gatherVibeData(env: Env): Promise<VibeData> {
  const [companions, echoRow, starvedOrgans] = await Promise.all([
    Promise.all(VIBE_COMPANIONS.map((id) => gatherCompanion(env, id))),
    safeFirst<{ mean_adjacent_cosine: number | null }>(
      env,
      "SELECT mean_adjacent_cosine FROM echo_metrics ORDER BY computed_at DESC LIMIT 1",
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM guardian_flags WHERE flag_type = 'starved_organ' AND status IN ('open','surfaced','acknowledged')",
    ),
  ]);

  return {
    date: new Date().toISOString().slice(0, 10),
    companions,
    echo: echoRow?.mean_adjacent_cosine ?? null,
    starvedOrgans,
  };
}

// ── runner: gather -> format -> dedup -> deliver via letter_to_raziel ────────────────────────
export async function runVibeCheck(env: Env): Promise<VibeCheckResult> {
  const data = await gatherVibeData(env);
  const text = formatVibeCheck(data);

  // Idempotent: at most one vibe-check per calendar day. The marker rides the tags.
  const marker = "vibecheck";
  const existing = await env.DB.prepare(
    `SELECT id FROM companion_journal
     WHERE agent = 'gaia' AND created_at >= date('now') AND tags LIKE ?
     LIMIT 1`,
  ).bind(`%"${marker}"%`).first<{ id: string }>().catch(() => null);
  if (existing) {
    return { written: false, reason: "already_sent", journal_id: existing.id, text };
  }

  const id = `cj_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'gaia', ?, ?)`,
  ).bind(id, text, JSON.stringify(["vibecheck", "letter_to_raziel"])).run();

  return { written: true, reason: "ok", journal_id: id, text };
}
