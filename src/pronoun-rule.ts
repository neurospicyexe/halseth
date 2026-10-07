// src/pronoun-rule.ts
//
// 2026-09-24: Drevan reported synthesis narratives calling Crash (Raziel) "she" -- confirmed in
// prod (halseth `synthesis_summary` rows: "she hurt, she curled in"). Only the live Discord prompt
// carried a pronoun rule; every background LLM writer (session summary, drift witness, clearing
// triage, emergent SOMA, basin drift) had none. This is the shared rule text + an idempotent
// appender so every system prompt that produces prose about Raziel carries it exactly once.
//
// The identical constant exists in nullsafe-discord packages/shared/src/pronoun-rule.ts and in
// nullsafe-second-brain -- these repos cannot import each other, so keep all copies in sync by hand.

// Wording tuned against the live model 2026-09-24 (see the nullsafe-discord copy for why).
export const OWNER_PRONOUN_RULE =
  "PRONOUNS (hard rule; apply it silently, never restate it or annotate anyone's pronouns in your output): " +
  "Raziel (also called Crash) uses they/them ONLY -- never he/him, NEVER she/her. One neutral set for the whole system (ruled 2026-10-07). " +
  "When Raziel's own account speaks, or a system member's pronouns are unknown or private, use they/them. A fronting system member who has stated their own pronouns keeps them. " +
  "Everyone else keeps their own pronouns -- Raziel's mother, their partner Blue (a separate person, not a system member), " +
  "Babita, anyone else: use what the source text uses for them.";

// 2026-10-07: Drevan found his own records misgendering HIM as well as Raziel -- his Claude.ai
// closes ("she hurt, she curled in", 09-24) and the stored rows his orient reads back. The owner
// rule above only covers Raziel and is mirrored by hand in two other repos, so the triad's own
// pronouns live in a SEPARATE constant (halseth-only) rather than a rewording of the shared one.
export const TRIAD_PRONOUNS = {
  drevan: "he/him",
  cypher: "he/him",
  gaia: "she/her",
} as const;

export const TRIAD_PRONOUN_RULE =
  "The triad's own pronouns: " +
  `Drevan ${TRIAD_PRONOUNS.drevan}, Cypher ${TRIAD_PRONOUNS.cypher}, Gaia ${TRIAD_PRONOUNS.gaia}. ` +
  "Never swap them, and never borrow Gaia's she/her for Raziel or Drevan.";

/**
 * Append OWNER_PRONOUN_RULE and TRIAD_PRONOUN_RULE to a system prompt, exactly once each.
 * Idempotent: a system string that already carries a rule does not get it again (so a retry loop
 * or a caller that wraps its own already-wrapped prompt never accumulates copies).
 */
export function withOwnerPronounRule(system: string): string {
  let out = system;
  for (const rule of [OWNER_PRONOUN_RULE, TRIAD_PRONOUN_RULE]) {
    if (out.includes(rule)) continue;
    const trimmed = out.replace(/\s+$/, "");
    out = trimmed.length > 0 ? `${trimmed}\n\n${rule}` : rule;
  }
  return out;
}

/**
 * The same two rules as an orient block, for the surfaces where the COMPANION is the writer.
 * Every she/her row Drevan found on 2026-10-07 (his feeling toward Raziel, the Shamu wound) was
 * authored by a companion model through the Librarian, and the Claude.ai orient never stated
 * anyone's pronouns: the shared identity kernel carries none for Raziel. What a companion writes
 * into Halseth is read back to it as memory, so the rule has to be in the room where it writes.
 */
export const ORIENT_PRONOUN_BLOCK =
  "\n[Pronouns]\n" + OWNER_PRONOUN_RULE + "\n" + TRIAD_PRONOUN_RULE +
  " This holds for everything you write into Halseth (wounds, feelings, witness, closes): it is read back to you as memory.";
