// src/mind/blocks/oversight.ts
//
// The `oversight` MindState block: what is watching this companion, and what this companion has asked for.
// Fills the last 3 oversight NOT_YET_LOADED entries (guardian_cards, tripwires, questions) -- wave 5.
//
// GUARDIAN CARDS CARRY THEIR REMEDIATION, not just their complaint. `remediationHint(flag_type)` is folded
// in here rather than left to each renderer, because a flag without a next action is the shape that
// produced the worst failure of this whole stretch: the orphan-memory detector told Cypher nightly that a
// note had never been recalled, he could not reach it (it was archived, and recall excludes archived rows),
// and he concluded the fault was in himself. **A card that names a problem the companion cannot act on is
// not oversight, it is an accusation.** The hint is what makes it the former.
//
// PURE READ, and this block is the one where that matters most concretely. Guardian cards have an
// open -> surfaced transition, and `companion_questions` has a `delivered_at` stamp; both are
// consume-on-read side effects owned by execSessionOrient. The loader must not fire them, or merely
// LOADING state would mark it as delivered -- the ranking-signal-written-by-reading trap.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { remediationHint } from "../../guardian/remediation.js";
import { fetchRecentAnswers } from "../../webmind/questions.js";
import type { WmAnsweredQuestion } from "../../webmind/types.js";

export interface GuardianCard {
  id: string;
  flag_type: string;
  severity: string;
  summary: string;
  /** What to actually do about it. Never null -- see the header. */
  remediation: string;
}

export interface ArmedTripwire {
  id: string;
  trigger_text: string;
  condition_type: string;
  condition_value: string;
}

export interface CarriedQuestion {
  id: string;
  question: string;
  /**
   * Whether the companion has already SAID this one out loud (the `question_voiced:<id>` settings key).
   *
   * Carried as a FLAG rather than applied as a filter, decided 2026-08-01. The exclusion used to live in
   * this query, which meant the loader silently retired a question the first time it was spoken -- answered
   * or not. That is wrong for the same reason the unconfirmed-growth rows were wrong: *detected, never
   * owned*. Element 4 of the north star (mutuality) is the weakest of the four precisely because
   * first-person material fails to CIRCULATE, and a question the companion asked once and Raziel never
   * engaged is that failure exactly.
   *
   * But the anti-nag rail is still right for the BOTS, which boot ~20x more often -- re-asking every few
   * minutes IS nagging. So the loader carries the fact and each renderer decides, which is what the contract
   * says renderers are for: content identical for every loom, presentation per surface. Discord filters
   * `!voiced`; Claude.ai shows a held question until it is ANSWERED (`status` leaves 'open'), because on a
   * conversational surface that is what "held" means.
   */
  voiced: boolean;
}

export interface OversightBlocks {
  guardian_cards: GuardianCard[];
  tripwires: ArmedTripwire[];
  /** Questions this companion is carrying for Raziel, minus any already voiced. */
  questions: CarriedQuestion[];
  /**
   * Wave 6. Questions Raziel has ANSWERED in the last 7 days -- the other half of the loop.
   *
   * `fetchRecentAnswers` is reused rather than reimplemented: it is already the shared reader, and a second
   * copy of this query is how the two halves of one lifecycle drift apart. Its sibling
   * `markAnswersDelivered` is deliberately NOT called here -- stamping delivered_at from the loader would
   * mean merely LOADING state marks an answer as delivered to a companion that never saw it. Delivery is
   * the route layer's job; the loader is a window, not a hand.
   */
  answered_questions: WmAnsweredQuestion[];
  /**
   * Wave 8. Drift readings the checker classified as GROWTH but nobody has owned yet.
   *
   * Distinct from `pressure_flags` (drift_type = 'pressure') and from `growth_confirmed`
   * (caleth_confirmed = 1) — this is the middle state, and it was unreachable for weeks: the auto-confirm
   * gate (in_motion + healthy floats) rarely passes and no surface listed the unconfirmed rows, so growth
   * was *detected and never owned*. Only `execSessionOrient` ever showed them; putting it in the contract is
   * what lets any surface offer "confirm growth: <id>".
   */
  growth_unconfirmed: UnconfirmedGrowth[];
}

export interface UnconfirmedGrowth {
  id: string;
  worst_basin: string | null;
  notes: string | null;
  recorded_at: string;
}

export async function loadOversightBlocks(env: Env, companionId: WmAgentId): Promise<OversightBlocks> {
  try {
    const [flags, triggers, questions, answered, unconfirmedGrowth] = await Promise.all([
      // companion_id IS NULL means house-wide, so it belongs to everyone's oversight.
      env.DB.prepare(
        // `IN ('open','surfaced')` -- NOT `= 'open'`, which is what this block shipped with on 07-31 and
        // made it the DEGRADED copy of a query both other paths already had right. A card moves to
        // `surfaced` once any surface has shown it; filtering to `open` alone means a flag disappears from
        // the loader the moment it is first displayed, while still being unresolved. Surfaced is not
        // handled.
        `SELECT id, flag_type, severity, summary FROM guardian_flags
         WHERE (companion_id = ? OR companion_id IS NULL) AND status IN ('open','surfaced')
         ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 3`
      ).bind(companionId).all<Omit<GuardianCard, "remediation">>(),
      env.DB.prepare(
        `SELECT id, trigger_text, condition_type, condition_value FROM companion_triggers
         WHERE companion_id = ? AND status = 'armed' AND (expires_at IS NULL OR expires_at >= datetime('now'))
         ORDER BY created_at ASC LIMIT 10`
      ).bind(companionId).all<ArmedTripwire>(),
      // `voiced` as a COLUMN, not a WHERE clause -- see CarriedQuestion. `status = 'open'` already excludes
      // answered ones (answering moves the row to 'answered'), so this is every question still genuinely
      // waiting on Raziel, newest first.
      //
      // LIMIT 5, not 2: a renderer that filters `!voiced` needs headroom, or two voiced questions at the top
      // would starve it of an unvoiced third that exists. The renderers take their own 2.
      env.DB.prepare(
        `SELECT q.id, q.question,
                EXISTS(SELECT 1 FROM companion_settings s
                       WHERE s.companion_id = q.companion_id AND s.key = 'question_voiced:' || q.id) AS voiced
         FROM companion_questions q
         WHERE q.companion_id = ?1 AND q.status = 'open'
         ORDER BY q.created_at DESC LIMIT 5`
      ).bind(companionId).all<{ id: string; question: string; voiced: number }>(),
      fetchRecentAnswers(env, companionId, 3).catch(() => []),
      // 14-day window, deliberately: an unowned reading that never expires becomes a nag.
      env.DB.prepare(
        `SELECT id, worst_basin, notes, recorded_at FROM companion_basin_history
         WHERE companion_id = ? AND drift_type = 'growth' AND caleth_confirmed = 0 AND dismissed_at IS NULL
           AND recorded_at > datetime('now','-14 days')
         ORDER BY recorded_at DESC LIMIT 2`
      ).bind(companionId).all<UnconfirmedGrowth>(),
    ]);

    return {
      guardian_cards: (flags.results ?? []).map(f => ({
        ...f,
        // 400, the superset: execSessionOrient kept 400 and the bot kept 300. Per-field superset means the
        // loader carries the fuller text and the DISCORD renderer trims to its own 300 -- the same
        // one-source-two-presentations rule as `voiced`. Truncating in the loader would have silently
        // shortened the Claude.ai card.
        summary: (f.summary ?? "").slice(0, 400),
        remediation: remediationHint(f.flag_type),
      })),
      tripwires: (triggers.results ?? []).map(t => ({
        ...t,
        // 500, not the 300 this block shipped with: a tripwire is an instruction the companion set for
        // itself, and truncating one at 300 can cut off the condition it was written to catch.
        trigger_text: (t.trigger_text ?? "").slice(0, 500),
        condition_value: (t.condition_value ?? "").slice(0, 200),
      })),
      questions: (questions.results ?? []).map(q => ({ id: q.id, question: q.question, voiced: q.voiced === 1 })),
      answered_questions: answered,
      growth_unconfirmed: unconfirmedGrowth.results ?? [],
    };
  } catch (err) {
    console.warn("[mind/oversight] load failed, degrading to empty", { companionId, error: String(err) });
    return { guardian_cards: [], tripwires: [], questions: [], answered_questions: [], growth_unconfirmed: [] };
  }
}
