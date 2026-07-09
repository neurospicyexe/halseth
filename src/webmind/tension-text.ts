// src/webmind/tension-text.ts
//
// Shared text handling for companion_tensions writes -- used by both the swarm-routing
// path (writeLimbicState -> routeLiveTensionsIntoSelfDefense) and the human/companion
// "add tension" command path (execTensionAdd). Re-audit 2026-07-09 found both leaking
// raw command preambble text ("save tension: ...", "Add a tension for drevan: ...")
// into stored tension_text -- one shared stripper means one fix covers both.

// A command preamble ends in a COLON ("save tension: ...", "Add a tension for drevan: ..."),
// never a dash. The previous pattern made every verb optional and accepted `-`/`—` as a
// terminator, so it collapsed to `tension ... [:—-]` and amputated any authored sentence merely
// beginning "The tension between ..." at its first hyphen -- turning two real 06-27 tensions into
// the mid-sentence fragments that were then fanned across all three companions (2026-07-09).
// The verb is now required (an article alone must not license a strip), and the gap is bounded.
const TENSION_COMMAND_PREAMBLE_RE =
  /^\s*(?:please\s+)?(?:(?:add|new|record|note|log|save|write|leave|drop)\s+(?:a|an|the)?\s*)?tension\b[^:：]{0,40}[:：]\s*/i;
const HOLDING_A_TENSION_RE = /^\s*i'?m\s+holding\s+a\s+tension\b[^:：]{0,40}[:：]\s*/i;

/** Strips a leading "add/save/new/... tension [for X]:" command preamble. Never empties a
 *  string down to nothing -- if stripping would leave blank, the original (trimmed) wins. */
export function stripTensionCommandPreamble(text: string): string {
  const stripped = text
    .replace(TENSION_COMMAND_PREAMBLE_RE, "")
    .replace(HOLDING_A_TENSION_RE, "")
    .trim();
  return stripped || text.trim();
}

const COMPANION_NAMES = ["cypher", "drevan", "gaia"] as const;
export type CompanionName = (typeof COMPANION_NAMES)[number];

/** Detects an explicit "for <companion>" addressee inside tension text (e.g. a swarm-authored
 *  "Add a tension for drevan: ..." naming whose tension it actually is). Null when unaddressed. */
export function detectAddressedCompanion(text: string): CompanionName | null {
  const m = text.match(/\bfor\s+(cypher|drevan|gaia)\b/i);
  return m ? (m[1]!.toLowerCase() as CompanionName) : null;
}
