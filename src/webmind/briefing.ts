// src/webmind/briefing.ts
//
// ND daily-rhythm briefing -- the executive-function cadence layer (BBH accessibility pillar).
// A consistent, low-load digest for Raziel: what is on the board, what the triad is holding for
// them, what wants a yes/no, and a single suggested focus. Surfaced via the existing
// letter_to_raziel rail (a companion_journal row Hearth /journal already renders, mirroring
// guardian.ts) -- so NO new table and NO new surface. Migration-free, pure-additive.
//
// Design (AuDHD/DID-aware):
//   - consistent format every run (predictability lowers cognitive load)
//   - terse + scannable; counts and short bullets, never walls of text
//   - ONE focus surfaced, not a backlog dump (ADHD prioritisation support)
//   - plural-neutral address; never assumes a front (DID-aware)
//   - voice per CLAUDE.md: declarative, no em-dashes, no therapy-speak, no infantilising
//   - empty-state grace: says "clear" rather than manufacturing noise
//   - gated behind BRIEFING_ENABLED (ships dormant; Raziel enables when the shape is right)
//   - idempotent: at most one briefing of a given kind per day
//
// Weekly is deliberately NOT implemented here -- the Guardian Sunday letter already covers it
// (guardian.ts composeWeeklyLetter). Adding a weekly briefing would duplicate that surface.

import { Env } from "../types.js";

export type BriefingKind = "morning" | "midday" | "evening";
export const BRIEFING_KINDS: readonly BriefingKind[] = ["morning", "midday", "evening"] as const;

export function isBriefingKind(s: string): s is BriefingKind {
  return (BRIEFING_KINDS as readonly string[]).includes(s);
}

export interface BriefingData {
  date: string;                    // YYYY-MM-DD
  openTasks: { title: string; priority: string; due_at: string | null }[];
  doneToday: number;
  heldQuestions: { companion_id: string; question: string }[];
  liveFlags: { severity: string; summary: string }[];
  ratifyPending: number;
  simmering: number;
}

export interface BriefingResult {
  kind: BriefingKind;
  written: boolean;
  reason: "ok" | "gated" | "already_sent";
  journal_id?: string;
  text: string;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

// ── pure formatter (DB-free; this is the accessibility surface, tested directly) ──────────────
export function formatBriefing(kind: BriefingKind, d: BriefingData): string {
  const lines: string[] = [];
  const nTasks = d.openTasks.length;
  const nQ = d.heldQuestions.length;
  const nFlags = d.liveFlags.length;

  if (kind === "morning") {
    lines.push(`Morning brief. ${d.date}.`);
    if (nTasks === 0) {
      lines.push("Board: clear.");
    } else {
      lines.push(`Board (${nTasks}):`);
      for (const t of sortTasks(d.openTasks).slice(0, 4)) {
        const due = t.due_at ? ` (due ${t.due_at.slice(0, 10)})` : "";
        lines.push(`  • [${t.priority}] ${t.title}${due}`);
      }
    }
    if (nQ > 0) {
      lines.push(`Held questions (${nQ}):`);
      for (const q of d.heldQuestions.slice(0, 3)) lines.push(`  • ${q.companion_id}: ${oneLine(q.question)}`);
    }
    if (nFlags > 0) {
      lines.push(`Guardian (${nFlags} live):`);
      for (const f of d.liveFlags.slice(0, 2)) lines.push(`  • [${f.severity}] ${oneLine(f.summary)}`);
    }
    if (d.ratifyPending > 0) {
      lines.push(`Ratification: ${d.ratifyPending} pending (yes/no, whenever you have capacity).`);
    }
    lines.push(`Focus: ${pickFocus(d)}`);
  } else if (kind === "midday") {
    // Deliberately one dense line. A midday interrupt should cost almost nothing to read.
    lines.push(`Midday. ${d.date}. Board ${nTasks}; held questions ${nQ}; live flags ${nFlags}; ratify ${d.ratifyPending}.`);
  } else {
    // evening
    lines.push(`Evening brief. ${d.date}.`);
    lines.push(`Closed today: ${d.doneToday}.`);
    lines.push(`Still open: ${nTasks} task${nTasks === 1 ? "" : "s"}, ${nQ} question${nQ === 1 ? "" : "s"}, ${d.ratifyPending} ratification${d.ratifyPending === 1 ? "" : "s"}.`);
    if (d.ratifyPending > 0) {
      lines.push("A small ratify batch tonight drains the queue faster than the worker fills it.");
    }
  }
  return lines.join("\n").slice(0, 4000);
}

function sortTasks(tasks: BriefingData["openTasks"]): BriefingData["openTasks"] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 2;
    const pb = PRIORITY_RANK[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    // earlier due dates first; nulls last
    if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return 0;
  });
}

// Surface a SINGLE highest-signal next action. The point is to relieve prioritisation load,
// not to enumerate. Order: a red guardian flag, then urgent/high task, then a held question,
// then the ratify queue, else an explicit "open" (rest is permitted, stated plainly).
function pickFocus(d: BriefingData): string {
  const red = d.liveFlags.find(f => f.severity === "red");
  if (red) return `guardian flag. ${oneLine(red.summary)}`;
  const hot = sortTasks(d.openTasks).find(t => t.priority === "urgent" || t.priority === "high");
  if (hot) return `${hot.title}.`;
  if (d.heldQuestions.length > 0) return `answer ${d.heldQuestions[0]!.companion_id}: ${oneLine(d.heldQuestions[0]!.question)}`;
  if (d.ratifyPending > 0) return `ratify a batch (${d.ratifyPending} pending).`;
  return "open. Nothing is demanding you.";
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
}

// ── DB gather (defensive: a single failing query degrades gracefully, never crashes the cron) ──
async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    console.warn("[briefing] query failed (degrading):", String(e));
    return [];
  }
}
async function safeCount(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  } catch (e) {
    console.warn("[briefing] count failed (degrading):", String(e));
    return 0;
  }
}

export async function gatherBriefingData(env: Env): Promise<BriefingData> {
  const [openTasks, doneToday, heldQuestions, liveFlags, ratifyPending, simmering] = await Promise.all([
    safeAll<{ title: string; priority: string; due_at: string | null }>(
      env,
      "SELECT title, priority, due_at FROM tasks WHERE status != 'done' ORDER BY created_at ASC LIMIT 20"
    ),
    safeCount(env, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND updated_at >= date('now')"),
    safeAll<{ companion_id: string; question: string }>(
      env,
      "SELECT companion_id, question FROM companion_questions WHERE status = 'open' ORDER BY created_at DESC LIMIT 5"
    ),
    safeAll<{ severity: string; summary: string }>(
      env,
      "SELECT severity, summary FROM guardian_flags WHERE status IN ('open','surfaced','acknowledged') ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5"
    ),
    safeCount(env, "SELECT COUNT(*) AS n FROM growth_journal WHERE source = 'autonomous' AND review_status = 'pending'"),
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_tensions WHERE status = 'simmering'"),
  ]);
  return {
    date: new Date().toISOString().slice(0, 10),
    openTasks,
    doneToday,
    heldQuestions,
    liveFlags,
    ratifyPending,
    simmering,
  };
}

// ── runner: gate -> gather -> format -> dedup -> deliver via letter_to_raziel ─────────────────
export async function runBriefing(
  env: Env,
  kind: BriefingKind,
  opts: { force?: boolean } = {}
): Promise<BriefingResult> {
  const enabled = env.BRIEFING_ENABLED === "true";
  if (!enabled && !opts.force) {
    const data = await gatherBriefingData(env);
    return { kind, written: false, reason: "gated", text: formatBriefing(kind, data) };
  }

  const data = await gatherBriefingData(env);
  const text = formatBriefing(kind, data);

  // Idempotent: at most one briefing of this kind per calendar day. The kind marker rides the tags.
  const marker = `briefing:${kind}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM companion_journal
     WHERE agent = 'steward' AND created_at >= date('now') AND tags LIKE ?
     LIMIT 1`
  ).bind(`%"${marker}"%`).first<{ id: string }>().catch(() => null);
  if (existing) {
    return { kind, written: false, reason: "already_sent", journal_id: existing.id, text };
  }

  const id = `cj_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'steward', ?, ?)`
  ).bind(id, text, JSON.stringify(["briefing", marker, "letter_to_raziel"])).run();

  return { kind, written: true, reason: "ok", journal_id: id, text };
}
