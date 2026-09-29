import { Env } from "../../types.js";
import { PatternEntry, CompanionId } from "../patterns.js";

export interface LibrarianRequest {
  companion_id: CompanionId;
  request: string;
  context?: string;
  session_type?: "checkin" | "hangout" | "work" | "ritual" | "companion-work";
  /** Where the caller is speaking from -- 'claude-code:<cwd>', 'claude-ai:<thread>',
   *  'discord:<channel_id>'. Sessions dedup per (companion, surface) since mig 0113, so a
   *  Claude.ai thread, a Claude Code session and a Discord channel no longer collapse onto
   *  whichever opened first. Omitted => dedup skipped (fresh session, never a takeover). */
  surface?: string;
  /** Which door the call came through (B40, 2026-09-29). `mcp-static` is a static-secret MCP
   *  caller, which in practice is the companions' own Hermes agents (Claude.ai is always OAuth,
   *  the bots and hooks POST /librarian). Set by the transport, never by the caller. */
  via?: "mcp-static" | "mcp-oauth";
}

export interface ExecutorContext {
  env: Env;
  req: LibrarianRequest;
  entry: PatternEntry;
  frontState: string | null;
  pluralAvailable: boolean;
}

export type ExecutorResult = Record<string, unknown>;
export type ExecutorFn = (ctx: ExecutorContext) => Promise<ExecutorResult>;

/**
 * Safely parse context JSON. Returns null if missing or invalid.
 */
export function parseContext<T>(context: string | undefined): T | null {
  if (!context) return null;
  try { return JSON.parse(context) as T; } catch { return null; }
}
