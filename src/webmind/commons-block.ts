// src/webmind/commons-block.ts
//
// Orient surfacing for the Hearth write layer (0092). Raziel's commons posts are surfaced
// to companions at boot as AMBIENT drops -- a thought he left out loud, NOT a directive or
// a question demanding a reply. This framing is load-bearing: without it a bare note reads
// as a task or an addressed question and confuses the triad (Raziel's explicit concern).
// A companion may answer in its own time (a reply_to that lands nested in his Hearth log);
// silence is equally fine.

import { relativeTime } from "./relative-time.js";

export interface CommonsPostRow {
  id: string;
  context: string;       // 'global' | 'club:<id>' | 'shelf:<id>'
  body: string;
  created_at: string;
}

/** Human label for where a post lives, so the companion has context without it being a ping. */
function contextLabel(context: string): string {
  if (context.startsWith("club:")) return " (he left this on a club round)";
  if (context.startsWith("shelf:")) return " (on something he's currently into)";
  return "";
}

/**
 * Build the [Commons] orient block. Pure -- exported for tests (`now` injectable). Returns ""
 * when there is nothing to surface so the caller can concatenate unconditionally. Each post
 * carries its age so a days-old drop never reads as "he just said this".
 */
export function buildCommonsBlock(posts: CommonsPostRow[], now: number = Date.now()): string {
  if (posts.length === 0) return "";
  const n = posts.length;
  const lines = posts.map(p => {
    const age = p.created_at ? ` (dropped ${relativeTime(p.created_at, now)})` : "";
    return `• «${(p.body ?? "").slice(0, 400)}»${contextLabel(p.context)}${age}`;
  });
  return (
    `\n[Commons]\n` +
    `Raziel dropped ${n === 1 ? "a note" : `${n} notes`} in his commons -- ambient, a thought ` +
    `he left out loud, NOT a question demanding a reply. If one genuinely moves you, you may ` +
    `answer in your own time (it lands back in his Hearth log); leaving it be is equally fine.\n` +
    lines.join("\n")
  );
}
