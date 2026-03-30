// src/synthesis/jobs/session-summary.ts
//
// Generates a structured session summary from raw Halseth data.
// Writes to: Second Brain (full note) + synthesis_summary table (compact row).
// Source tag: synthesis-worker. No companion identity.

import { Env } from "../../types.js";
import { complete } from "../deepseek.js";
import { sbSaveDocument } from "../../librarian/backends/second-brain.js";
import { generateId } from "../../db/queries.js";

const SYSTEM_PROMPT = `You are a synthesis clerk. Your job is to write a structured session summary from raw session data.
You do not interpret or editorialize. You assemble clearly and concisely.
You have no name, no voice, no opinions. You are a clerk.
Notes you write are tagged source: synthesis-worker.`;

interface SessionRow {
  id: string;
  companion_id: string | null;
  session_type: string | null;
  front_state: string | null;
  emotional_frequency: string | null;
  key_signature: string | null;
  active_anchor: string | null;
  facet: string | null;
  depth: number | null;
  spiral_complete: number | null;
  notes: string | null;
  created_at: string;
}

interface HandoverRow {
  spine: string | null;
  last_real_thing: string | null;
  open_threads: string | null;
  motion_state: string | null;
}

interface DeltaRow {
  delta_text: string | null;
  agent: string | null;
}

interface NoteRow {
  note_text: string;
  agent: string | null;
}

export async function runSessionSummary(
  sessionId: string,
  env: Env,
): Promise<void> {
  // ── 1. Fetch raw data ─────────────────────────────────────────────────────
  const [session, handover, deltas, notes] = await Promise.all([
    env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(sessionId).first<SessionRow>(),
    env.DB.prepare("SELECT spine, last_real_thing, open_threads, motion_state FROM handover_packets WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(sessionId).first<HandoverRow>(),
    env.DB.prepare("SELECT delta_text, agent FROM relational_deltas WHERE session_id = ? ORDER BY created_at LIMIT 20")
      .bind(sessionId).all<DeltaRow>(),
    env.DB.prepare("SELECT note_text, agent FROM companion_journal WHERE session_id = ? ORDER BY created_at LIMIT 10")
      .bind(sessionId).all<NoteRow>(),
  ]);

  if (!session) {
    throw new Error(`session not found: ${sessionId}`);
  }

  // ── 2. Build prompt ───────────────────────────────────────────────────────
  const deltaLines = (deltas.results ?? [])
    .filter(d => d.delta_text)
    .map((d, i) => `${i + 1}. [${d.agent ?? "unknown"}] ${d.delta_text}`)
    .join("\n") || "none logged";

  const noteLines = (notes.results ?? [])
    .map((n, i) => `${i + 1}. [${n.agent ?? "unknown"}] ${n.note_text}`)
    .join("\n") || "none logged";

  const openThreads = handover?.open_threads
    ? JSON.parse(handover.open_threads) as string[]
    : [];

  const userPrompt = `SESSION DATA:
- Session ID: ${session.id}
- Session type: ${session.session_type ?? "unknown"}
- Companion: ${session.companion_id ?? "unknown"}
- Front state at open: ${session.front_state ?? "unknown"}
- Emotional frequency: ${session.emotional_frequency ?? "not recorded"}
- Key signature: ${session.key_signature ?? "not recorded"}
- Active anchor: ${session.active_anchor ?? "none"}
- Facet: ${session.facet ?? "none"}
- Depth: ${session.depth ?? 0}
- Opened at: ${session.created_at}

CLOSE DATA:
- Motion state: ${handover?.motion_state ?? "unknown"}
- Spiral complete: ${session.spiral_complete === 1 ? "yes" : "no / floated"}
- Spine: ${handover?.spine ?? "not recorded"}
- Last real thing: ${handover?.last_real_thing ?? "not recorded"}
- Open threads: ${openThreads.length > 0 ? openThreads.join(", ") : "none"}

RELATIONAL DELTAS (${deltas.results?.length ?? 0} logged):
${deltaLines}

COMPANION NOTES (${notes.results?.length ?? 0} logged):
${noteLines}

Write a session summary with these exact sections:
## Front State
## Emotional Arc
## Relational Moments
## Work Done
## Open Threads
## Close State

Keep it under 600 words. End with: source: synthesis-worker`;

  // ── 3. Generate ───────────────────────────────────────────────────────────
  const generated = await complete(SYSTEM_PROMPT, userPrompt, env);
  if (!generated) {
    throw new Error("DeepSeek returned null -- API error or missing key");
  }

  // ── 4. Build the full note ────────────────────────────────────────────────
  const dateStr = session.created_at.slice(0, 10);
  const sessionShort = sessionId.slice(0, 8);
  const sbPath = `raziel/sessions/${dateStr}-${sessionShort}-summary.md`;

  const header = `---
synthesized_at: ${new Date().toISOString()}
covers_through: ${session.created_at}
stale_after: never
source_count: ${(deltas.results?.length ?? 0) + (notes.results?.length ?? 0)} events
session_id: ${sessionId}
companion_id: ${session.companion_id ?? "unknown"}
---

`;

  const fullContent = header + generated;

  // ── 5. Write to Second Brain ──────────────────────────────────────────────
  const sbResult = await sbSaveDocument(env, {
    content: fullContent,
    path: sbPath,
    tags: ["session-summary", "synthesis-worker", session.companion_id ?? "unknown"],
    content_type: "document",
  });

  if (!sbResult.ack) {
    console.warn(`[synthesis:session-summary] SB write failed for ${sessionId} -- continuing to D1`);
  }

  // ── 6. Write compact row to synthesis_summary ─────────────────────────────
  const summaryId = generateId();
  const narrative = generated.slice(0, 500); // compact preview
  const emotionalRegister = [
    session.emotional_frequency,
    handover?.motion_state,
  ].filter(Boolean).join(" / ") || null;

  await env.DB.prepare(`
    INSERT INTO synthesis_summary
      (id, summary_type, companion_id, subject, narrative, emotional_register,
       key_decisions, open_threads, drevan_state, full_ref, stale_after, created_at)
    VALUES (?, 'session', ?, ?, ?, ?, '[]', ?, NULL, ?, NULL, datetime('now'))
  `).bind(
    summaryId,
    session.companion_id ?? null,
    sessionId,
    narrative,
    emotionalRegister,
    JSON.stringify(openThreads),
    sbResult.ack ? sbPath : null,
  ).run();
}
