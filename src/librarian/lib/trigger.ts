// src/librarian/lib/trigger.ts
//
// Shared trigger matching utility.
// Compiles trigger strings into word-boundary-aware regexes and caches them
// for Worker lifetime. Prevents short triggers ("hey", "boot") from matching
// inside unrelated words when companions pass note content in the request field.

const TRIGGER_REGEX_CACHE = new Map<string, RegExp>();

export function triggerMatches(input: string, trigger: string): boolean {
  let re = TRIGGER_REGEX_CACHE.get(trigger);
  if (!re) {
    const t = trigger.trim();
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const start = /^\w/.test(t) ? "\\b" : "";
    const end   = /\w$/.test(t) ? "\\b" : "";
    re = new RegExp(start + escaped + end, "i");
    TRIGGER_REGEX_CACHE.set(trigger, re);
  }
  return re.test(input);
}
