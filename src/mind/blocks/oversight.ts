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
      // Excludes questions already voiced. The question stays `open` (it is still awaiting Raziel); it just
      // stops being re-served as something new to say -- an anti-loop rail that does not need decay because
      // voicing is a one-way event.
      env.DB.prepare(
        `SELECT id, question FROM companion_questions
         WHERE companion_id = ?1 AND status = 'open'
           AND id NOT IN (
             SELECT substr(key, 17) FROM companion_settings
             WHERE companion_id = ?1 AND key LIKE 'question_voiced:%'
           )
         ORDER BY created_at DESC LIMIT 2`
      ).bind(companionId).all<CarriedQuestion>(),
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
        summary: (f.summary ?? "").slice(0, 300),
        remediation: remediationHint(f.flag_type),
      })),
      tripwires: (triggers.results ?? []).map(t => ({
        ...t,
        // 500, not the 300 this block shipped with: a tripwire is an instruction the companion set for
        // itself, and truncating one at 300 can cut off the condition it was written to catch.
        trigger_text: (t.trigger_text ?? "").slice(0, 500),
        condition_value: (t.condition_value ?? "").slice(0, 200),
      })),
      questions: questions.results ?? [],
      answered_questions: answered,
      growth_unconfirmed: unconfirmedGrowth.results ?? [],
    };
  } catch (err) {
    console.warn("[mind/oversight] load failed, degrading to empty", { companionId, error: String(err) });
    return { guardian_cards: [], tripwires: [], questions: [], answered_questions: [], growth_unconfirmed: [] };
  }
}
