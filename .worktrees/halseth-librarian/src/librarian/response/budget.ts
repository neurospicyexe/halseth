// src/librarian/response/budget.ts
//
// Truncation/extraction heuristic for context budget enforcement.
// Lean phase: truncate to char limit, strip markdown.
// Phase 2 upgrade: replace truncate() with AI generation model -- same interface.
//
// Budget limits (hard):
//   ready_prompt : ~50 tokens  (~200 chars)
//   summary      : ~200 tokens (~800 chars)
//   witness      : ~10 tokens  (~40 chars)

export const BUDGET_CHARS = {
  ready_prompt: 200,
  summary: 800,
  witness: 40,
} as const;

export type ResponseKey = "ready_prompt" | "summary" | "witness";

export function truncate(text: string, key: ResponseKey): string {
  const limit = BUDGET_CHARS[key];
  // Strip markdown: remove **, ##, __, >, ` characters
  const stripped = text
    .replace(/[*#_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= limit) return stripped;
  return stripped.slice(0, limit - 1) + "…";
}

export function formatMeta(data: {
  front_state?: string | null;
  pending_notes?: unknown[];
  open_tasks?: unknown[];
}): Record<string, unknown> {
  return {
    front_state: data.front_state ?? null,
    pending_notes: data.pending_notes?.length ?? 0,
    open_tasks: data.open_tasks?.length ?? 0,
  };
}
