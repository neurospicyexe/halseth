// src/mind/adapters/bot-wire.ts
//
// The Discord bot wire format, built FROM MindState instead of from 33 of its own queries.
//
// This is the cutover adapter for execBotOrient -- the highest-frequency read path in the system, roughly 20x
// the Claude.ai orient rate. Its whole job is projection: MindState is nested and complete, the bot wire is
// flat and truncated, and every consumer in nullsafe-discord reads the flat keys. So the adapter's contract is
// narrow and strict:
//
//   EXACTLY THE EXISTING 44 KEYS. NO ADDITIONS.
//
// That is not tidiness, it is what makes the cutover verifiable. The gate for this change is byte-identity
// against the payload the old code produced, and byte-identity only means something if the key set is frozen
// -- one helpful extra field and the diff turns into noise that has to be triaged by hand. Additions come
// later, deliberately, as their own change.
//
// WHAT THAT DELIBERATELY PARKS. MindState carries `felt.limbic`, `felt.biometrics_latest` and `felt.house`;
// the bot payload has never had any of them, so this adapter drops them. The bots are the highest-frequency
// presence in the house and the only surface with no emotional register at all -- worth fixing, and worth
// fixing as a decision rather than inheriting as a side effect of a refactor.
//
// WHAT STAYS OUTSIDE. Three inputs arrive via `extras` rather than from MindState, because all three need the
// network: the two Second Brain semantic searches, and the `sbRead` that hydrates the session narrative.
// **loadMindState stays pure-D1** -- every loom's boot inherits its failure profile, and the SB tunnel is the
// dependency that 503'd for 24h over a 30s blip. Only Discord should pay for Discord's hops.
//
// THE TRAP IN HERE, NAMED. `synthesis_summary` on the wire is the session narrative's TEXT. MindState's
// `continuity.session_narrative` is its `full_ref` -- a vault PATH. Both are `string | null`, so TypeScript
// cannot tell them apart, and swapping them ships bots that print a file path where the last session's story
// goes. Hence `extras.synthesis_summary`, and hence this paragraph.

import type { MindState } from "../contract.js";
import type { WmAgentId } from "../../webmind/types.js";
import { buildSolBlock } from "../../webmind/creatures.js";
import { relativeTime } from "../../webmind/relative-time.js";

/**
 * The inputs the adapter cannot derive from MindState.
 *
 * All six are Discord-specific renderings or network reads. Passing them in (rather than having the adapter
 * fetch them) keeps this module pure and testable: given a MindState and these strings, the wire payload is
 * fully determined.
 */
export interface BotWireExtras {
  /** The session narrative's TEXT, sbRead-hydrated, frontmatter stripped. NOT `session_narrative`. */
  synthesis_summary: string | null;
  /** Second Brain semantic search over recent companion context. */
  rag_excerpts: string[];
  /** Second Brain semantic search over conversation history, age-prefixed. */
  history_excerpts: string[];
  /**
   * The bot's own 3-pool note surfacing, already provenance-annotated.
   *
   * Stays outside the adapter because it is a SURFACING POLICY with a write attached (it warms what it
   * shows, at SURFACE_BUMP), and because its novelty slot deliberately reaches past the recency window that
   * MindState carries. A pure projection cannot express "one note this companion has never been shown".
   */
  continuity_notes: string[];
  /** `env.SYSTEM_OWNER`. An input, not derivable from MindState -- and load-bearing; see
   *  `relational_state_owner` below. */
  owner: string;
}

/** The flat wire payload. Deliberately `Record<string, unknown>`-shaped at the boundary: the authority on
 *  these key names is the set of live consumers in nullsafe-discord, not a type in this repo. */
export type BotWirePayload = Record<string, unknown>;

const text = (v: unknown, n: number): string => String(v ?? "").slice(0, n);

/**
 * Unvoiced, non-blank, newest 2 -- exactly the set the loader's WHERE clause used to hand back.
 *
 * ONE list, used for BOTH `open_questions` and `open_question_ids`, because those two are aligned BY INDEX:
 * a surface that voices question N stamps id N. They previously applied DIFFERENT predicates -- `.filter(Boolean)`
 * on the text (which keeps a whitespace-only question, since `"   "` is truthy) versus `.trim()` on the ids
 * (which drops it) -- so a single blank question would shift the arrays against each other and voicing one
 * would stamp a different question's id. The comment above them already said the predicates must match; they
 * did not. Filtering once here makes that unrepresentable rather than merely warned about.
 */
const BOT_QUESTIONS = (ms: MindState) =>
  ms.oversight.questions.filter(q => !q.voiced && (q.question ?? "").trim()).slice(0, 2);

/**
 * Project a MindState onto the Discord bot wire format.
 *
 * `agentId` is passed separately rather than read off `ms.companion_id` only because two fields need to know
 * "is this me" (a listen's own reaction vs a sibling's, and a co-watcher worth naming) -- keeping the
 * argument explicit makes those two decisions visible at the call site.
 */
export function botWireFromMindState(
  ms: MindState,
  extras: BotWireExtras,
  agentId: WmAgentId,
): BotWirePayload {
  const solRow = ms.world.creatures.find(c => c.name === "Sol" || c.kind === "companion_pet") ?? null;

  return {
    synthesis_summary: extras.synthesis_summary,
    ground_threads: ms.continuity.top_threads.map(t => t.title ?? t.thread_key).slice(0, 3),
    ground_handoff: ms.continuity.recent_handoffs[0]
      ? String(ms.continuity.recent_handoffs[0].summary ?? ms.continuity.recent_handoffs[0].title ?? "")
      : null,
    continuity_notes: extras.continuity_notes,
    rag_excerpts: extras.rag_excerpts,
    history_excerpts: extras.history_excerpts,

    identity_anchor: ms.identity.anchor?.anchor_summary ? text(ms.identity.anchor.anchor_summary, 300) : null,
    active_tensions: ms.carried.tensions.map(t => text(t.tension_text, 150)).filter(Boolean).slice(0, 3),
    // FILTERED BY `toward` (2026-08-02). `readRelationalSnapshot` returns the latest row PER TARGET
    // (ROW_NUMBER partitioned by `toward`), ordered noted_at DESC -- so `snapshot[0]` is the most recent
    // state toward ANYONE, not toward Raziel. `toward` is caller-supplied, so a state written toward a
    // SIBLING more recently would have been handed to the bot as its state toward the owner. The field is
    // named `relational_state_owner`; it has to actually mean that.
    relational_state_owner: ms.relational.snapshot
      .filter(s => (s.toward ?? "").toLowerCase() === extras.owner.toLowerCase())
      .map(s => text(s.state_text, 150)).filter(Boolean).slice(0, 1),
    incoming_notes: ms.relational.triad_incoming.slice(0, 3).map(n => ({
      from: n.from_id,
      content: text(n.content, 200),
      age: relativeTime(n.created_at),
    })),
    sibling_lanes: ms.relational.siblings,

    recent_growth: ms.growth.journal_recent.map(g => ({
      type: g.entry_type ?? "learning",
      content: text(g.content, 200),
      // Age-stamped: a read-back with no age reads as present-tense news. Gaia told the commons "Rosie is
      // a dog. Got it." about a fact thirteen days old, as though she had just learned it.
      age: relativeTime(g.created_at),
    })),
    active_patterns: ms.growth.patterns.map(p => text(p.pattern_text, 150)).filter(Boolean),
    pending_seeds: ms.growth.seeds.map(s => text(s.content, 200)).filter(Boolean),
    unaccepted_growth: ms.growth.clearing_count,

    // conclusion_text (not `text`) because both live renderers key on it to build the [Worldview] block.
    active_conclusions: ms.beliefs.conclusions.map(c => ({
      conclusion_text: c.conclusion_text,
      belief_type: c.belief_type,
      confidence: c.confidence,
      subject: c.subject ?? null,
    })),
    flagged_beliefs: ms.beliefs.flagged.map(c => ({
      conclusion_text: c.conclusion_text,
      belief_type: c.belief_type,
      confidence: c.confidence,
      subject: c.subject ?? null,
    })),

    unexamined_dreams: ms.carried.dreams_unexamined.map(d => ({ id: d.id, dream_text: text(d.dream_text, 300) })),
    open_loops: ms.carried.open_loops.map(l => ({ id: l.id, loop_text: text(l.loop_text, 200) })),
    // The id is carried in the STRING because that is the handle the confirm/dismiss executors parse. Ugly,
    // and load-bearing -- do not "clean up" into a structured field without changing both executors.
    pressure_flags: ms.oversight.pressure_flags.map(p => {
      const body = [p.worst_basin, p.notes].filter(Boolean).join(": ").slice(0, 130);
      return body ? `${body} (id ${p.id})` : `(id ${p.id})`;
    }),

    // DISCORD APPLIES THE ANTI-NAG RAIL. The loader now carries every open question with a `voiced` flag
    // rather than filtering; the bots boot ~20x more often than Claude.ai, so re-serving one the companion
    // already said out loud IS nagging here even though it is not on a conversational surface. Same content
    // both places, different presentation -- which is what the contract says renderers are for.
    open_questions: BOT_QUESTIONS(ms).map(q => text(q.question, 300)),
    // Aligned by INDEX with open_questions -- same source list, no second predicate. See BOT_QUESTIONS.
    open_question_ids: BOT_QUESTIONS(ms).map(q => q.id),
    answered_questions: ms.oversight.answered_questions,

    forage_finds: ms.world.forage.pool.slice(0, 2).map(f => ({
      id: f.id, title: text(f.title, 150), domain: f.domain, summary: text(f.summary, 400), gathered_at: f.at,
    })),
    consumed_forage_finds: ms.world.forage.active.slice(0, 2).map(f => ({
      id: f.id, title: text(f.title, 150), domain: f.domain, summary: text(f.summary, 400), consumed_at: f.at,
    })),
    armed_triggers: ms.oversight.tripwires.map(t => ({
      id: t.id, trigger_text: text(t.trigger_text, 500),
      condition_type: t.condition_type, condition_value: text(t.condition_value, 200),
    })),
    self_model_ready: ms.identity.self_model.slice(0, 2).map(s => ({
      id: s.id, observation: text(s.observation, 600), confidence: s.confidence,
    })),

    recent_listens: ms.world.listens.map(l => {
      // Own reaction verbatim; a sibling's is a bare fact, never their words in your mouth. Sibling
      // PRESENCE is wanted; sibling VOICE is how attribution scrambled in June.
      let ownReaction: string | null = null;
      const reactedBy: string[] = [];
      try {
        const parsed = JSON.parse(l.reactions_json ?? "{}") as Record<string, string>;
        for (const [who, t] of Object.entries(parsed)) {
          if (!t) continue;
          if (who === agentId) ownReaction = String(t).slice(0, 240);
          else reactedBy.push(who);
        }
      } catch { /* malformed -> no reaction, never breaks orient */ }
      return {
        id: l.id, title: text(l.title, 150), artist: l.artist ? text(l.artist, 100) : null,
        shared_by: l.shared_by ?? null, requested_companion: l.requested_companion ?? null,
        own_reaction: ownReaction, also_heard_by: reactedBy, created_at: l.created_at,
      };
    }),

    club_round: ms.world.club,
    watching: ms.world.watching,
    supersede_candidates: ms.beliefs.supersede_candidates,
    // Discord trims the summary to its own 300; the loader carries 400 for the Claude.ai card.
    guardian_flags: ms.oversight.guardian_cards.slice(0, 2).map(g => ({ ...g, summary: text(g.summary, 300) })),
    motifs: ms.world.motifs.active.slice(0, 3).map(m => ({
      label: m.label, display: text(m.display, 120), recurrence_count: m.recurrence_count, trust: m.trust,
    })),
    creatures: ms.world.creatures.map(c => ({
      name: c.name, species: c.species, kind: c.kind, trust: c.trust, mood: c.mood,
    })),
    // Fail-soft: no Sol seeded, or no created_at to date the arc from -> null rather than a broken block.
    sol_block: solRow && solRow.created_at
      ? (() => {
          try {
            return buildSolBlock({
              name: solRow.name, species: solRow.species, trust: solRow.trust,
              last_interaction_at: solRow.last_interaction_at ?? null, created_at: solRow.created_at,
            });
          } catch { return null; }
        })()
      : null,
    imp_activity: ms.world.imps_active,

    preferences: ms.identity.preferences,
    standing_refusals: ms.identity.refusals,
    open_drifts: ms.growth.drifts_open,
    recent_witness: ms.relational.recent_witness,
  };
}
