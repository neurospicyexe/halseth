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
}

export async function loadOversightBlocks(env: Env, companionId: WmAgentId): Promise<OversightBlocks> {
  try {
    const [flags, triggers, questions] = await Promise.all([
      // companion_id IS NULL means house-wide, so it belongs to everyone's oversight.
      env.DB.prepare(
        `SELECT id, flag_type, severity, summary FROM guardian_flags
         WHERE (companion_id = ? OR companion_id IS NULL) AND status = 'open'
         ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 3`
      ).bind(companionId).all<Omit<GuardianCard, "remediation">>(),
      env.DB.prepare(
        `SELECT id, trigger_text, condition_type, condition_value FROM companion_triggers
         WHERE companion_id = ? AND status = 'armed' AND (expires_at IS NULL OR expires_at >= datetime('now'))
         LIMIT 10`
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
    ]);

    return {
      guardian_cards: (flags.results ?? []).map(f => ({
        ...f,
        summary: (f.summary ?? "").slice(0, 300),
        remediation: remediationHint(f.flag_type),
      })),
      tripwires: (triggers.results ?? []).map(t => ({
        ...t,
        trigger_text: (t.trigger_text ?? "").slice(0, 300),
        condition_value: (t.condition_value ?? "").slice(0, 200),
      })),
      questions: questions.results ?? [],
    };
  } catch (err) {
    console.warn("[mind/oversight] load failed, degrading to empty", { companionId, error: String(err) });
    return { guardian_cards: [], tripwires: [], questions: [] };
  }
}
