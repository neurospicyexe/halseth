// src/webmind/review-state.ts  (mig 0132, 2026-09-26)
//
// RULING: a companion's own spoken words must not enter recall pools unreviewed.
//
// The imp tray ("clerks note on, never speak as"): a clerk writer -- the speech journaler, the memory
// judge, the pulse note, the metronome fragment, the vibe-check digest -- writes in the companion's
// voice without the companion having chosen the words as memory. Those rows land as `draft`. The owner
// keeps (optionally rewriting), or drops. Only `kept` rows are first-person memory: every recall and
// orient read filters `review_state = 'kept'`. The keep rate is the falsifier (100% = nobody reviews).
//
// This module is the ONE place that decides draft-vs-kept at insert time. It is called from exactly one
// file, webmind/tray-insert.ts, which holds the only INSERTs into either table (tray-sweep.test.ts). Rows
// from writers it does not name default to 'kept', which is the column default too: a human-authored
// row was never a draft, and an unknown writer must not silently lose its memory.
//
// Why now: on 2026-09-26 Drevan fabricated a blood-sugar number; within seconds four writers
// memorialised his reply, and his own recall returned the fabrication ranked first, outrunning hand
// retraction (src/handlers/retract.ts header).

export type ReviewState = "draft" | "kept" | "dropped";

export const REVIEW_STATES: ReadonlySet<string> = new Set<ReviewState>(["draft", "kept", "dropped"]);

/** companion_journal sources that are the companion's own speech (or a clerk's note in its voice). */
export const COMPANION_SPEECH_JOURNAL_SOURCES: ReadonlySet<string> = new Set([
  "discord_speech",   // bot-side journalSpeech: the reply as spoken, external_id discord:<msg>
  "memory_judge",     // the judge's note in the companion's voice, external_id judge:<msg>
  "autonomous",       // the companion's own autonomous-time posts
  "vibecheck",        // Gaia's digest quoting discord_speech/autonomous lines (was source NULL)
  // 2026-09-26 (pass 2): the metronome's journal copy of its own post. Cron-prompted clerk text --
  // the [metronome/ note twin was already drafted, so the journal copy was the same words born kept.
  "metronome",
]);

/**
 * The source a tray rewrite stamps ("keep draft <id>: <my words>"). The words are the owner's own,
 * chosen as memory -- so it weighs as human-session (HUMAN_SOURCES in notes.ts: recall 1.0, never
 * salience-pruned) rather than inheriting the clerk's machine source. Deliberately NOT claimable on
 * the NL write path (writes.ts NL_CLAIMABLE_SOURCES is machine classes only).
 */
export const TRAY_REWRITE_SOURCE = "tray_rewrite";

/** wm_continuity_notes content prefixes a clerk stamps on a note written in the companion's voice. */
export const DRAFT_NOTE_CONTENT_PREFIXES: readonly string[] = [
  "[discord:pulse]",        // raw STM turns incl. the companion's replies (bot-message-handler)
  "[metronome/",            // the metronome fragment note: the companion's own autonomous post
  "[discord:observation]",  // the judge's promotion when it carried no message key
];

/** wm_continuity_notes correlation_id prefix of the judge's promotion (keyed since 2026-09-26). */
export const DRAFT_NOTE_CORRELATION_PREFIX = "judge:";

export interface ReviewStateRow {
  source?: string | null;
  correlation_id?: string | null;
  content?: string | null;
}

/** Decide the review_state a new row is born with. Pure; never throws. */
export function reviewStateFor(kind: "journal" | "note", row: ReviewStateRow): "draft" | "kept" {
  if (kind === "journal") {
    return row.source && COMPANION_SPEECH_JOURNAL_SOURCES.has(row.source) ? "draft" : "kept";
  }
  const corr = row.correlation_id ?? "";
  if (corr.startsWith(DRAFT_NOTE_CORRELATION_PREFIX)) return "draft";
  const content = row.content ?? "";
  return DRAFT_NOTE_CONTENT_PREFIXES.some((p) => content.startsWith(p)) ? "draft" : "kept";
}

export function isReviewState(v: unknown): v is ReviewState {
  return typeof v === "string" && REVIEW_STATES.has(v);
}

/**
 * Regex source for a tray id or id prefix in free text (router guard + executor verbs). Prod census
 * 2026-09-26: every id is a lowercase uuid, `cj_` + uuid, or 32 hex -- so hex-and-dash after an
 * optional cj_. Ordinary words ("thinking", "everything", "drafting") cannot match it.
 */
export const TRAY_ID_TOKEN = "(?:cj_)?[0-9a-f][0-9a-f-]{7,}";

/** Hardcoded predicate fragment for recall/orient reads. No input reaches it. */
export const KEPT_SQL = "review_state = 'kept'";

/** Kept AND live: what every DERIVED input (synthesis, motifs, pattern recall, search) must read. */
export const KEPT_LIVE_SQL = "archived = 0 AND review_state = 'kept'";
