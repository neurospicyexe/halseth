/**
 * Roster lookup executor -- `who is <name>` for every companion surface (mig 0117).
 *
 * WHY THIS ROUTE AND NOT A NEW MCP TOOL: `/librarian/mcp` exposes exactly ONE tool,
 * `ask_librarian`, and Hermes has that MCP server enabled on all three profiles. So a fast-path
 * pattern here is reachable from Claude.ai, Claude Code, Hearth AND from a Discord reply composed by
 * the Hermes assembly -- whereas an entry in the raw `/mcp` server would reach only the first two.
 * One pattern covers more surfaces than a new tool would.
 *
 * The executor's whole job is to NOT flatten `lookupMember`'s five outcomes into "here is the
 * answer." `unavailable` in particular has to survive being read at speed mid-turn, because
 * mistaking it for `not_found` is how a real system member got called "drift" on 2026-08-12.
 */
import type { ExecutorContext, ExecutorResult } from "./types.js";
import { parseContext } from "./types.js";
import { lookupMember, renderLookup } from "../../roster/pk-roster.js";
import { triggerMatches } from "../lib/trigger.js";

/**
 * Filler that can precede or follow the name in a natural request. Stripped so
 * "who is magpie in the system?" and "who is magpie" resolve identically.
 */
const LEAD_FILLER = /^(?:the\s+)?(?:system\s+member\s+|member\s+|alter\s+|a\s+|an\s+)?/i;
const TRAIL_FILLER = /\s*(?:\b(?:in|on|from)\s+(?:the\s+)?(?:system|roster|pluralkit|pk)\b|\ba\s+(?:system\s+)?member\b|\breal\b|\ban\s+alter\b)\s*$/i;

/**
 * Pull the name out of the request. Deliberately conservative: if what is left after stripping the
 * trigger and the filler is empty or absurdly long, we say we could not read a name rather than
 * shipping a garbage query at the roster and reporting `not_found` for it.
 */
export function extractLookupName(request: string, triggers: string[], contextRaw?: string): string | null {
  const fromCtx = parseContext<{ name?: string; member?: string; query?: string }>(contextRaw);
  const explicit = (fromCtx?.name ?? fromCtx?.member ?? fromCtx?.query ?? "").trim();
  if (explicit) return explicit;

  const input = request.trim();
  // Longest matching trigger first, so "who is member" strips more than "who is".
  const matched = triggers
    .filter(t => triggerMatches(input, t))
    .sort((a, b) => b.length - a.length)[0];
  if (!matched) return null;

  const idx = input.toLowerCase().indexOf(matched.toLowerCase());
  let rest = input.slice(idx + matched.length);

  rest = rest
    .replace(/^\s*(?:is|are|was)\b/i, "")          // "who is" + "is magpie" phrasings
    .replace(/[?!.,;:]+\s*$/g, "")                  // trailing punctuation
    .replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, "")      // surrounding quotes
    .trim();
  rest = rest.replace(LEAD_FILLER, "").replace(TRAIL_FILLER, "").trim();
  rest = rest.replace(/['’]s$/i, "").trim();        // "who is magpie's" -> "magpie"

  if (!rest) return null;
  // A name, not a sentence. Anything longer is a phrasing we did not anticipate, and guessing at it
  // would produce a confident "not in the roster" about text that was never a name.
  if (rest.length > 60 || rest.split(/\s+/).length > 5) return null;
  return rest;
}

export async function execRosterWhoIs(ctx: ExecutorContext): Promise<ExecutorResult> {
  const name = extractLookupName(ctx.req.request, ctx.entry.triggers, ctx.req.context);
  if (!name) {
    return {
      response_key: "witness",
      witness:
        "couldn't read a name out of that -- try 'who is Magpie', or pass { \"name\": \"...\" } in context. " +
        "Note this is a NAME LOOKUP, not a failure to find the person.",
    };
  }

  const result = await lookupMember(ctx.env, name);

  // raw: the caller gets the discriminated result AND the sentence to read. Both, because a
  // summariser that only saw prose could turn "could not check" into "no such member".
  return {
    data: { ...result, summary: renderLookup(result) },
    meta: { operation: "roster_who_is", status: result.status, query: name },
  };
}
