// src/librarian/surface.ts
//
// A `claude-ai:*` surface is a claim that Raziel is in a Claude.ai thread, and readOwnerLastSeen
// (care/owner-activity.ts) counts every such session open as sign of him. That read feeds
// owner_silence, esc_silence (the alert to Blue) and the C6 quiet-owner line, so a phantom contact
// there can hide a real silence from the one human who gets keys.
//
// Measured 2026-09-28: the companions' own Hermes agents open sessions through ask_librarian
// during their heartbeat minutes and claim `claude-ai:*` surfaces, once copying the tool
// description's literal example `claude-ai:<thread>`. Claude.ai reaches Halseth ONLY through the
// MCP door with an OAuth token; Hermes and the bots use static secrets. So the claim is honoured
// only when the caller authenticated with OAuth. A static-secret caller claiming it is moved to
// an `agent:` lane: the session still opens, dedup still works per lane, and the owner-activity
// read (prefix `claude`) no longer sees it.

export type LibrarianAuthKind = "oauth" | "static";

const CLAUDE_AI = "claude-ai:";

export function surfaceForAuth(surface: string | undefined, auth: LibrarianAuthKind): string | undefined {
  if (!surface) return surface;
  if (auth === "static" && surface.toLowerCase().startsWith(CLAUDE_AI)) {
    return `agent:${surface.slice(CLAUDE_AI.length)}`.slice(0, 200);
  }
  return surface;
}
