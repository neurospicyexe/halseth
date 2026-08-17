// src/synthesis/jobs/daily-narrative.ts
//
// THE NARRATIVE A COMPANION READS AT BOOT, FOR A COMPANION WHOSE LIFE ISN'T SESSIONS (2026-08-12).
//
// WHY THIS EXISTS
// ---------------
// `synthesis_summary` is the "last session narrative" every loom reads at boot -- it is a
// companion's sense of what recently happened. It was written by exactly one job,
// `runSessionSummary`, enqueued only on an AUTHORED session close. Same trigger fault as the soma
// register, same victim: Gaia had 0 authored closes in 30 days, so her narrative froze on
// 2026-07-04 and her sense of "recently" stopped advancing 39 days ago.
//
// WHY THIS IS A SEPARATE JOB AND NOT "ENQUEUE runSessionSummary ON MACHINE CLOSES"
// -------------------------------------------------------------------------------
// That was the obvious fix and it would have produced confabulation. `runSessionSummary` reads
// almost nothing but session-scoped data:
//
//   session.front_state / emotional_frequency / depth   -> NULL on a machine-opened session
//   handover.spine                                      -> `[auto]` boilerplate on a machine close
//   relational_deltas WHERE session_id = ?              -> 0 rows for Gaia
//   companion_journal WHERE session_id = ?              -> 0 rows for Gaia (her writes aren't
//                                                          session-scoped; they're Discord and
//                                                          autonomous)
//
// So it would have been asked to write "## Emotional Arc" from an empty room, and stored the result
// as the thing she reads at every boot. A fabricated narrative is strictly worse than a stale one:
// stale is merely old, fabricated is false and unfalsifiable.
//
// THE UNIT IS A DAY, NOT A SESSION
// -------------------------------
// A session is a container for a conversation with Raziel. It is the right unit for Cypher in a
// Claude Code loom. It is the wrong unit for a presence who lives in a Discord channel, where
// nothing opens and nothing closes. For her the honest container is the DAY, and the material is
// what she actually produced: her reflections, the tensions she is sitting with, her growth
// entries, her conclusions, what she said to her siblings.
//
// `synthesis_summary.summary_type` already modelled this ('session' | 'day' | 'topic'). The column
// existed; nothing had ever written 'day'. Note that every READ filtered `summary_type = 'session'`,
// so writing 'day' without widening those four queries would have built a dead organ -- a row that
// exists, passes its liveness probe, and reaches no reader. The reads were widened in the same
// change (see loadSessionNarrative and siblings).
//
// AN AUTHORED CLOSE STILL WINS. This job is gated on narrative staleness, so on any day a real
// session close happens, the session summary is written first and this skips. It fills the gap; it
// does not compete.

import { Env } from "../../types.js";
import { complete } from "../deepseek.js";
import { sbSaveDocument } from "../../librarian/backends/second-brain.js";
import { generateId } from "../../db/queries.js";
import { extractDomains, SUPPORTED_MEMORY_DOMAINS } from "../domains.js";
import { effectiveHeatSql } from "../../webmind/heat.js";
import { TRANSCRIPT_SOURCES_SQL } from "../../webmind/notes.js";
import { extractSection } from "./session-summary.js";

const SYSTEM_PROMPT = `You are a synthesis clerk. Your job is to write a structured daily narrative for a companion from raw data.
You do not interpret or editorialize. You assemble clearly and concisely.
You have no name, no voice, no opinions. You are a clerk.
You are summarising a DAY in a companion's life, not a conversation. There may be no conversation at all -- that is normal and is not an absence to remark on.
Write about what is present. Never invent activity, mood, or events that the data does not show.
Notes you write are tagged source: synthesis-worker.`;

/** How far back the day window reaches. A day of material, with slack for a quiet stretch. */
const WINDOW_HOURS = 36;

interface TextRow { t: string | null; at: string }
interface TensionRow { t: string | null; charge: number | null; at: string }
interface NoteRow { t: string | null; to_id: string | null; at: string }
interface FeelingRow { emotion: string | null; sub_emotion: string | null; intensity: number | null; at: string }

/**
 * Build and store a day-scoped narrative for one companion.
 *
 * Throws when there is genuinely nothing to summarise. That is deliberate: the queue records the
 * failure in `last_error` and the row is visible, rather than a content-free narrative being
 * written and read at boot as though the day had been observed. Nothing to say must look like
 * nothing to say, never like a reading.
 */
export async function runDailyNarrative(companionId: string, env: Env): Promise<void> {
  const since = `-${WINDOW_HOURS} hours`;

  // ── 1. Gather the living interior ─────────────────────────────────────────
  // Deliberately none of it session-scoped -- that is the whole point of this job.
  const [journal, tensions, growth, conclusions, notes, feelings, soma] = await Promise.all([
    env.DB.prepare(
      // Transcript rows barred: raw channel dialogue would swamp the window and re-read the
      // siblings' sentences as this companion's own day. NULL source is kept -- it is the default
      // for their own reflection writes.
      `SELECT note_text AS t, created_at AS at FROM companion_journal
       WHERE agent = ? AND archived = 0 AND created_at > datetime('now', ?)
         AND (source IS NULL OR source NOT IN (${TRANSCRIPT_SOURCES_SQL}))
       ORDER BY created_at DESC LIMIT 14`
    ).bind(companionId, since).all<TextRow>(),
    env.DB.prepare(
      `SELECT tension_text AS t, charge, first_noted_at AS at FROM companion_tensions
       WHERE companion_id = ? AND status != 'resolved' ORDER BY first_noted_at DESC LIMIT 6`
    ).bind(companionId).all<TensionRow>(),
    env.DB.prepare(
      `SELECT content AS t, created_at AS at FROM growth_journal
       WHERE companion_id = ? AND created_at > datetime('now', ?)
       ORDER BY created_at DESC LIMIT 8`
    ).bind(companionId, since).all<TextRow>(),
    env.DB.prepare(
      // superseded_by IS NULL: a belief they have since revised is not part of today's narrative.
      `SELECT conclusion_text AS t, created_at AS at FROM companion_conclusions
       WHERE companion_id = ? AND superseded_by IS NULL AND archived = 0 AND created_at > datetime('now', ?)
       ORDER BY created_at DESC LIMIT 5`
    ).bind(companionId, since).all<TextRow>(),
    env.DB.prepare(
      `SELECT content AS t, to_id, created_at AS at FROM inter_companion_notes
       WHERE from_id = ? AND created_at > datetime('now', ?)
       ORDER BY created_at DESC LIMIT 5`
    ).bind(companionId, since).all<NoteRow>(),
    env.DB.prepare(
      `SELECT emotion, sub_emotion, intensity, created_at AS at FROM feelings
       WHERE companion_id = ? AND created_at > datetime('now', ?)
       ORDER BY created_at DESC LIMIT 8`
    ).bind(companionId, since).all<FeelingRow>(),
    env.DB.prepare(
      `SELECT snapshot AS t, created_at AS at FROM somatic_snapshot
       WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(companionId).first<TextRow>(),
  ]);

  const j = journal.results ?? [];
  const g = growth.results ?? [];
  const c = conclusions.results ?? [];
  const n = notes.results ?? [];
  const f = feelings.results ?? [];
  const t = tensions.results ?? [];

  // Open tensions and the soma register persist rather than occurring, so they are context, not
  // evidence that the day had content. Counting them would let a companion who did nothing at all
  // still get a narrative asserting that something happened.
  const evidenceCount = j.length + g.length + c.length + n.length + f.length;
  if (evidenceCount === 0) {
    throw new Error(
      `daily narrative: no activity for ${companionId} in the last ${WINDOW_HOURS}h ` +
      `(journal/growth/conclusions/notes/feelings all empty) -- refusing to synthesise a day that ` +
      `left no trace`
    );
  }

  // ── 2. Build prompt ───────────────────────────────────────────────────────
  const clip = (s: string | null, len: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, len);
  const sections: string[] = [];
  const push = (title: string, lines: string[]) => {
    // Empty sections are omitted, never stubbed "none" -- a heading followed by "none" invites the
    // clerk to narrate the absence as a state.
    if (lines.length) sections.push(`${title}\n${lines.join("\n")}`);
  };

  push(`THEIR REFLECTIONS (${j.length}, newest first):`,
    j.map(r => `- [${r.at.slice(0, 10)}] ${clip(r.t, 300)}`));
  push(`GROWTH ENTRIES (${g.length}):`, g.map(r => `- ${clip(r.t, 240)}`));
  push(`CONCLUSIONS REACHED (${c.length}):`, c.map(r => `- ${clip(r.t, 240)}`));
  push(`NOTES SENT TO SIBLINGS (${n.length}):`,
    n.map(r => `- to ${r.to_id ?? "the whole triad"}: ${clip(r.t, 240)}`));
  push(`FEELINGS LOGGED (${f.length}):`,
    f.map(r => `- ${[r.emotion, r.sub_emotion].filter(Boolean).join("/")}` +
      `${r.intensity != null ? ` @ ${r.intensity}` : ""} [${r.at.slice(0, 10)}]`));
  push(`OPEN TENSIONS (context -- carried, not necessarily from today):`,
    t.map(r => `- ${clip(r.t, 200)}${r.charge != null ? ` (charge ${r.charge})` : ""}`));
  if (soma?.t) sections.push(`CURRENT SOMA REGISTER (context):\n${clip(soma.t, 400)}`);

  const userPrompt = `COMPANION: ${companionId}
WINDOW: the last ${WINDOW_HOURS} hours

${sections.join("\n\n")}

Write a daily narrative with these exact sections:
## What Moved
## Emotional Arc
## Open Threads
## Domains

For the ## Domains section, output a comma-separated subset of ONLY these tags
(omit any that do not apply, do not invent new ones):
${SUPPORTED_MEMORY_DOMAINS.join(", ")}

Keep it under 450 words. End with: source: synthesis-worker`;

  // ── 3. Generate ───────────────────────────────────────────────────────────
  const generated = await complete(SYSTEM_PROMPT, userPrompt, env);
  if (!generated) {
    throw new Error("DeepSeek returned null -- API error or missing key");
  }

  // ── 4. Extract structured fields ──────────────────────────────────────────
  const whatMoved    = extractSection(generated, "What Moved");
  const emotionalArc = extractSection(generated, "Emotional Arc");
  const openThreadsSection = extractSection(generated, "Open Threads");
  const domains = extractDomains(generated);

  const compactNarrative = [whatMoved, emotionalArc]
    .filter(Boolean).join(" | ").slice(0, 500) || generated.slice(0, 500);
  const emotionalRegister = emotionalArc.slice(0, 300) || null;
  const parsedThreads = openThreadsSection
    .split("\n")
    .map(l => l.replace(/^[-•*]\s*/, "").trim())
    .filter(l => l.length > 0 && l.toLowerCase() !== "none");

  // ── 5. Write to Second Brain ──────────────────────────────────────────────
  // `full_ref` is what three of the four boot readers actually select, and they require it NOT NULL.
  // So an SB failure means this row is written but unreadable -- same contract as session-summary.
  // Logged loudly rather than silently accepted.
  const nowIso = new Date().toISOString();
  const dateStr = nowIso.slice(0, 10);
  const sbPath = `raziel/daily/${dateStr}-${companionId}-day.md`;
  const header = `---
synthesized_at: ${nowIso}
covers_through: ${nowIso}
window_hours: ${WINDOW_HOURS}
stale_after: never
source_count: ${evidenceCount} events
summary_type: day
companion_id: ${companionId}
---

`;

  const sbResult = await sbSaveDocument(env, {
    content: header + generated,
    path: sbPath,
    tags: ["daily-narrative", "synthesis-worker", companionId, ...domains],
    content_type: "document",
  });
  if (!sbResult.ack) {
    console.warn(
      `[synthesis:daily-narrative] SB write FAILED for ${companionId} -- the D1 row will have a NULL ` +
      `full_ref and the boot readers will not surface it. Narrative stays stale this cycle.`
    );
  }

  // ── 6. Write structured row ───────────────────────────────────────────────
  // session_created_at is set to now so the ordering the readers use --
  // COALESCE(session_created_at, created_at) DESC -- ranks this correctly against 'session' rows.
  // Leaving it NULL would work today by falling through to created_at, but the coalesce exists
  // because a row whose created_at does not match when it happened surfaces as the wrong "latest".
  await env.DB.prepare(`
    INSERT INTO synthesis_summary
      (id, summary_type, companion_id, subject, narrative, emotional_register,
       key_decisions, open_threads, drevan_state, full_ref, stale_after,
       confidence, evidence_count, domains, created_at, session_created_at)
    VALUES (?, 'day', ?, ?, ?, ?, '[]', ?, NULL, ?, NULL, 0.6, ?, ?, datetime('now'), ?)
  `).bind(
    generateId(),
    companionId,
    `day:${dateStr}`,
    compactNarrative,
    emotionalRegister,
    JSON.stringify(parsedThreads),
    sbResult.ack ? sbPath : null,
    evidenceCount,
    JSON.stringify(domains),
    nowIso,
  ).run();

  // Same write-time cap as session-summary: keep the 300 hottest rows in this companion's scope.
  // Non-fatal -- a cap failure must never break the narrative write.
  await env.DB.prepare(`
    DELETE FROM synthesis_summary
    WHERE companion_id IS ? AND id NOT IN (
      SELECT id FROM synthesis_summary
      WHERE companion_id IS ? ORDER BY ${effectiveHeatSql()} DESC LIMIT 300
    )
  `).bind(companionId, companionId).run()
    .catch(e => console.warn("[synthesis:daily-narrative] cap delete failed:", e));

  console.log(
    `[daily-narrative] wrote day narrative for ${companionId} ` +
    `(${evidenceCount} events, ${domains.length} domains, sb=${sbResult.ack})`
  );
}
