import { Env } from "../../types.js";
import { PatternEntry, CompanionId } from "../patterns.js";

export interface LibrarianRequest {
  companion_id: CompanionId;
  request: string;
  context?: string;
  session_type?: "checkin" | "hangout" | "work" | "ritual" | "companion-work";
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
