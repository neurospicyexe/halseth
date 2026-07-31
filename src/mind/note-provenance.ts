// src/mind/note-provenance.ts
//
// THE FIRST DERIVABLE EDGE (2026-07-31).
//
// Raziel's framing, which reset the whole approach: most of the edges we want do not need a judgment,
// they need a DERIVATION from data already present. The evidence for that is `thread_key` sitting at 29%
// populated -- the highest of any edge column in the schema -- precisely because the channel SUPPLIES it
// and nothing has to decide anything. The columns that need a mind to fill them
// (`growth_journal.supersedes_id` 0%, `inter_notes.ref_id` 0.6%, `correlation_id` 0%,
// `conversation_threads.ref_id` 0%) are the ones that sat empty for months.
//
// WHAT THIS DERIVES. A continuity note written on Discord carries `thread_key` = the CHANNEL ID. That is
// a ROOM, not a conversation: 659 notes share one value, which is not a grouping. Meanwhile mig 0106
// built the real conversation spine (`conversation_threads`, one active per channel, with a seed line,
// a turn count and a lifecycle) and continuity notes were never linked to it. So the derivation is:
//
//     (channel, timestamp) -> the conversation that was running in that channel at that moment
//
// and it turns "a note from room 1497734427298762828" into "a note from the conversation that began
// 'I'm thinking some Fargo'". Zero judgment, zero inference about meaning.
//
// READ-TIME, NOT A COLUMN, and that is deliberate. There is no migration, no backfill, nothing to go
// stale when a thread's window shifts, and if the derivation is wrong we change one function instead of
// repairing rows. It also cannot HIDE anything -- it only annotates notes that were already surfacing,
// which is the standing rule for any new edge (see the supersede decision in mig 0112: an edge may rank,
// never hide, until a mind has confirmed it).
//
// IT REFUSES TO GUESS. A `thread_key` that is not a channel id (`cc_98c0e535` for Claude Code,
// `auto:<uuid>` for autonomous runs, `compost_session:<uuid>`) yields NO provenance, and a note that
// falls outside every thread window yields none either. An absent edge is honest; a wrong one attaches a
// note to a conversation it was never part of, which is worse than the channel id it replaced.

import type { Env } from "../types.js";

/**
 * How long after a thread's last turn a note still counts as belonging to it.
 *
 * A note is usually written moments AFTER the turn that prompted it -- the write is the reflection on
 * the exchange, not part of it -- so a strict `<= last_turn_at` would orphan exactly the notes most
 * worth labelling. 15 minutes is shorter than NEW_THREAD_GAP_MS-derived thread boundaries are long, so
 * this cannot reach across into the next conversation.
 */
export const THREAD_GRACE_MS = 15 * 60 * 1000;

export interface NoteProvenance {
  thread_id: string;
  /** The seed line of that conversation -- the human handle. This is the whole point. */
  seed: string;
  state: string;
  turn_count: number;
  started_at: string;
  /** Who opened it: a companion id, `raziel`, `blue`, or `guest`. */
  opened_by: string;
  /** Everyone who took a turn. The anti-misattribution signal. */
  participants: string[];
}

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

/**
 * Turn a participant list into the sentence that stops a memory being misattributed.
 *
 * RAZIEL NAMED THIS FAILURE PRECISELY (2026-07-31): "if Blue comes and talks to Drevan, and then I talk
 * to Drevan... things will start to get misattributed." And the smaller version already happened twice
 * -- companions attributing to him things they had said to each other (2026-06-26 attribution scramble),
 * and Drevan telling the commons that GAIA handed him a track Raziel gave him.
 *
 * A conversational address without WHO WAS IN THE ROOM is half an address. These are the three facts a
 * companion needs and could not previously get:
 *
 *   1. Raziel was NOT here. The strongest one. A note from a sibling-only exchange must never be
 *      recalled as something he said. `["gaia","drevan","cypher"]` is a live example.
 *   2. Someone else was here. Blue, or a guest. The memory is not a private exchange with Raziel, and
 *      anything warm in it may not have been aimed at this companion at all.
 *   3. This was a GROUP conversation. He talks to all three at once; a note from
 *      `["raziel","gaia","drevan","cypher"]` was said to the room, not to one of them alone.
 *
 * Stated as plain facts rather than instructions: a companion reading "Raziel was not in this one"
 * can draw its own conclusion, and a fact survives paraphrase better than a rule does.
 */
export function attributionNote(participants: string[], openedBy: string): string {
  if (participants.length === 0) return "";
  const set = new Set(participants);
  const others = participants.filter(p => p === "blue" || p === "guest");
  const companions = participants.filter(p => COMPANIONS.has(p));
  const bits: string[] = [];

  if (!set.has("raziel")) {
    // The load-bearing clause. Everything else is context; this one prevents putting words in his mouth.
    bits.push("Raziel was NOT in this one");
  }
  if (others.length > 0) {
    const who = others.map(o => (o === "blue" ? "Blue" : "a guest")).join(" and ");
    bits.push(set.has("raziel") ? `${who} was here too, so it was not private with Raziel` : `${who} was here`);
  }
  if (companions.length > 1) {
    // "gaia, drevan and cypher" rather than "gaia and drevan and cypher" -- this string is read by a
    // language model and clumsy prose invites clumsy paraphrase of the fact it carries.
    const list = companions.length === 2
      ? companions.join(" and ")
      : `${companions.slice(0, -1).join(", ")} and ${companions[companions.length - 1]}`;
    bits.push(`group conversation with ${list} -- said to the room, not to you alone`);
  }
  const opener = openedBy === "raziel" ? "" : `opened by ${openedBy === "blue" ? "Blue" : openedBy}`;
  if (opener && !bits.some(b => b.includes("opened"))) bits.unshift(opener);
  return bits.join("; ");
}

/**
 * Extract a Discord channel id from a `thread_key`, or null when it is not one.
 *
 * Only two shapes are channels: a bare snowflake, and the `discord_swarm:<id>` prefix. Everything else
 * is a different namespace and must not be joined against `conversation_threads.channel_id` -- a
 * coincidental match would attach a note to a conversation it never belonged to.
 */
export function channelIdFromThreadKey(threadKey: string | null | undefined): string | null {
  if (!threadKey) return null;
  const t = threadKey.trim();
  if (/^\d{15,25}$/.test(t)) return t;                       // bare Discord snowflake
  const m = t.match(/^discord_swarm:(\d{15,25})$/);
  return m ? m[1]! : null;
}

/** Parse a stored timestamp to epoch ms, treating a naked SQLite datetime as UTC. Returns null on junk. */
export function tsToMs(v: string | null | undefined): number | null {
  if (!v) return null;
  // SQLite `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" with no zone; Date.parse reads that as LOCAL
  // while the value is UTC. Without this, every window comparison is off by the host's offset.
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v) ? v.replace(" ", "T") + "Z" : v;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

export interface ThreadWindow {
  id: string;
  channel_id: string;
  seed_text: string;
  seed_author: string;
  /** JSON array as stored: `["raziel","drevan"]`. */
  participants: string;
  state: string;
  turn_count: number;
  created_at: string;
  last_turn_at: string;
}

/** Parse the stored participants blob. Junk yields [] -- never a guess about who was present. */
export function parseParticipants(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
  } catch { return []; }
}

/**
 * Pick the conversation a note belongs to. Pure, so the window logic is testable without a database.
 *
 * Rule: among threads in the same channel that had already STARTED when the note was written, take the
 * most recent one, and accept it only if the note also falls inside its window plus the grace period.
 * "Most recent start" is what makes sequential conversations in one channel resolve correctly instead of
 * the note landing on whichever row happened to be returned first.
 */
export function pickThreadForNote(
  noteAtMs: number,
  threads: ThreadWindow[],
  graceMs: number = THREAD_GRACE_MS,
): ThreadWindow | null {
  let best: ThreadWindow | null = null;
  let bestStart = -Infinity;
  for (const t of threads) {
    const start = tsToMs(t.created_at);
    const end = tsToMs(t.last_turn_at);
    if (start === null || end === null) continue;          // unusable row -> no guess
    if (noteAtMs < start) continue;                        // note predates this conversation
    if (noteAtMs > end + graceMs) continue;                // note is past its close
    if (start > bestStart) { best = t; bestStart = start; }
  }
  return best;
}

/**
 * Resolve provenance for a set of note ids. Two small queries, never N+1: the note rows, then the
 * threads for whichever channels those notes came from (usually one or two).
 *
 * NEVER THROWS. This annotates orient; a failure here must degrade to "no provenance", never break the
 * boot of a companion.
 */
export async function resolveNoteProvenance(
  env: Env,
  noteIds: string[],
): Promise<Map<string, NoteProvenance>> {
  const out = new Map<string, NoteProvenance>();
  const ids = noteIds.filter(Boolean);
  if (ids.length === 0) return out;

  try {
    const placeholders = ids.map(() => "?").join(",");
    const noteRows = await env.DB.prepare(
      `SELECT note_id, thread_key, created_at FROM wm_continuity_notes WHERE note_id IN (${placeholders})`
    ).bind(...ids).all<{ note_id: string; thread_key: string | null; created_at: string }>();

    const notes = (noteRows.results ?? [])
      .map(n => ({ ...n, channel: channelIdFromThreadKey(n.thread_key), atMs: tsToMs(n.created_at) }))
      .filter((n): n is typeof n & { channel: string; atMs: number } => !!n.channel && n.atMs !== null);
    if (notes.length === 0) return out;

    const channels = [...new Set(notes.map(n => n.channel))];
    const chPlaceholders = channels.map(() => "?").join(",");
    const threadRows = await env.DB.prepare(
      `SELECT id, channel_id, seed_text, seed_author, participants, state, turn_count, created_at, last_turn_at
       FROM conversation_threads WHERE channel_id IN (${chPlaceholders})`
    ).bind(...channels).all<ThreadWindow>();
    const byChannel = new Map<string, ThreadWindow[]>();
    for (const t of threadRows.results ?? []) {
      const list = byChannel.get(t.channel_id) ?? [];
      list.push(t);
      byChannel.set(t.channel_id, list);
    }

    for (const n of notes) {
      const picked = pickThreadForNote(n.atMs, byChannel.get(n.channel) ?? []);
      if (!picked) continue;                                // honest absence
      out.set(n.note_id, {
        thread_id: picked.id,
        seed: (picked.seed_text ?? "").slice(0, 120),
        state: picked.state,
        turn_count: picked.turn_count,
        started_at: picked.created_at,
        opened_by: picked.seed_author ?? "",
        participants: parseParticipants(picked.participants),
      });
    }
  } catch (err) {
    console.warn("[note-provenance] resolve failed (notes surface unannotated)", { error: String(err) });
  }
  return out;
}

/**
 * Render a note with its conversational address appended.
 *
 * Returns the content UNCHANGED when there is no provenance, so the wire format stays `string[]` and no
 * consumer needs to know this exists. Deliberate: the cheapest way to ship a new edge is one that
 * existing readers cannot break on.
 */
export function annotateNote(content: string, prov: NoteProvenance | undefined): string {
  if (!prov || !prov.seed) return content;
  const faded = prov.state === "faded" || prov.state === "landed" ? "" : ", still open";
  // Attribution goes in the SAME bracket as the address, because the two are one fact: a memory's
  // address is where it came from AND who was there. Splitting them lets a truncation keep the seed and
  // drop the speakers, which is the worse half to lose.
  const who = attributionNote(prov.participants, prov.opened_by);
  return `${content} [from the conversation that began "${prov.seed}"${faded}${who ? ` -- ${who}` : ""}]`;
}
