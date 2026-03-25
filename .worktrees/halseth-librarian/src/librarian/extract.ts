/**
 * Extraction helpers for Librarian natural language parsing.
 * Used to pull member names and description updates from companion requests.
 */

/**
 * Extract a member name from a request string given a trigger phrase.
 * - Strips the trigger from the start of the request
 * - Removes trailing possessive "'s" if present
 * - Returns null if the result is empty
 * - Preserves original casing of the remainder
 *
 * @param request The full request string
 * @param trigger The lowercase trigger phrase to strip (e.g., "tell me about ")
 * @returns The extracted name, or null if empty
 */
export function extractMemberName(request: string, trigger: string): string | null {
  // Strip the trigger from the start of the original request (preserves casing)
  const remainder = request.slice(trigger.length).trim();

  // If empty, return null
  if (!remainder) {
    return null;
  }

  // Strip trailing "'s" if present
  const cleaned = remainder.endsWith("'s") ? remainder.slice(0, -2) : remainder;

  // Return null if result is empty, otherwise return the cleaned string
  return cleaned || null;
}

/**
 * Extract a member description update from a request string.
 * Matches pattern: "NAME description to NEW_TEXT"
 *
 * @param request The full request string
 * @returns Object with { member, description }, or null if pattern doesn't match
 */
export function extractDescriptionUpdate(
  request: string
): { member: string; description: string } | null {
  // Match: (optional name with optional 's) + description + to + rest
  const match = request.match(/([\w']+?)(?:'s)?\s+description\s+to\s+(.+)/i);

  if (!match) {
    return null;
  }

  // Group 1 = member name (strip trailing "'s" if present)
  let member = match[1];
  if (member.endsWith("'s")) {
    member = member.slice(0, -2);
  }

  // Group 2 = description text
  const description = match[2];

  return { member, description };
}
