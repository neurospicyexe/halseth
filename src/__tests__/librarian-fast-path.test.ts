import { describe, it, expect } from "vitest";
import { FAST_PATH_PATTERNS, type PatternEntry } from "../librarian/patterns.js";

// Replicate the fast-path matching logic inline (mirror of LibrarianRouter.matchFastPath)
function matchFastPath(request: string): { key: string; entry: PatternEntry } | null {
  const lower = request.toLowerCase().trim();
  for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
    for (const trigger of entry.triggers) {
      if (lower.includes(trigger.toLowerCase())) {
        return { key, entry };
      }
    }
  }
  return null;
}

describe("FAST_PATH_PATTERNS structure", () => {
  it("has at least one pattern defined", () => {
    expect(Object.keys(FAST_PATH_PATTERNS).length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty triggers array", () => {
    for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
      expect(entry.triggers.length, `${key}.triggers should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("every entry has a non-empty tools array", () => {
    for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
      expect(entry.tools.length, `${key}.tools should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("every entry has a response_key", () => {
    for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
      expect(entry.response_key, `${key}.response_key should be set`).toBeTruthy();
    }
  });
});

describe("fast-path trigger matching", () => {
  it("matches 'open orient' to session_orient", () => {
    const result = matchFastPath("open orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_orient");
  });

  it("matches 'boot orient' to session_orient", () => {
    const result = matchFastPath("boot orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_orient");
  });

  it("matches 'halseth_session_orient' to session_orient", () => {
    const result = matchFastPath("halseth_session_orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_orient");
  });

  it("matches 'ground me' to session_ground", () => {
    const result = matchFastPath("ground me");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_ground");
  });

  it("matches 'fetch ground' to session_ground", () => {
    const result = matchFastPath("fetch ground");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_ground");
  });

  it("matches 'open session' to session_open", () => {
    const result = matchFastPath("open session");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_open");
  });

  it("matches 'good morning' to session_open", () => {
    const result = matchFastPath("good morning");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_open");
  });

  it("matches 'my tasks' to get_tasks", () => {
    const result = matchFastPath("my tasks");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_tasks");
  });

  it("matches 'todo' to get_tasks", () => {
    const result = matchFastPath("todo");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_tasks");
  });

  it("matches 'catch me up' to get_handover", () => {
    const result = matchFastPath("catch me up");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_handover");
  });

  it("matches 'who\\'s fronting' to get_front", () => {
    const result = matchFastPath("who's fronting");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_front");
  });

  it("matches 'current front' to get_front", () => {
    const result = matchFastPath("current front");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_front");
  });

  it("matches 'search vault' to sb_search", () => {
    const result = matchFastPath("search vault");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("sb_search");
  });

  it("matches 'what do we know about' to sb_search", () => {
    const result = matchFastPath("what do we know about this topic");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("sb_search");
  });

  it("matches 'save note' to sb_save_note", () => {
    const result = matchFastPath("save note");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("sb_save_note");
  });

  it("matches 'close session' to session_close", () => {
    const result = matchFastPath("close session");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_close");
  });

  it("matches 'spine:' to session_close", () => {
    const result = matchFastPath("Spine: We worked through the security plan.");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_close");
  });

  it("matches 'add task' to task_add", () => {
    const result = matchFastPath("add task: write tests");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("task_add");
  });

  it("matches 'log feeling' to feeling_log", () => {
    const result = matchFastPath("log feeling: tired but focused");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("feeling_log");
  });

  it("matches 'log dream' to dream_log", () => {
    const result = matchFastPath("log dream last night");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("dream_log");
  });

  it("matches 'mind orient' to wm_orient", () => {
    const result = matchFastPath("mind orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_orient");
  });

  it("matches 'webmind orient' to wm_orient", () => {
    const result = matchFastPath("webmind orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_orient");
  });

  it("matches 'mind handoff' to wm_handoff_write", () => {
    const result = matchFastPath("mind handoff");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_handoff_write");
  });

  it("matches 'drevan state' to drevan_state_get", () => {
    const result = matchFastPath("drevan state");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("drevan_state_get");
  });

  it("matches 'companion notes' to companion_notes_read", () => {
    const result = matchFastPath("companion notes");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("companion_notes_read");
  });

  it("matches 'soma update' to state_update", () => {
    // "update my state" and "set my state" contain "my state" which matches get_state first.
    // Use "soma update" -- a trigger unique to state_update with no substring overlap.
    const result = matchFastPath("soma update");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("state_update");
  });

  it("matches 'light ground' to session_light_ground", () => {
    const result = matchFastPath("light ground");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_light_ground");
  });

  it("matches 'bot orient' to bot_orient", () => {
    const result = matchFastPath("bot orient");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("bot_orient");
  });
});

describe("fast-path case insensitivity", () => {
  it("matches uppercase trigger", () => {
    const result = matchFastPath("OPEN ORIENT");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("session_orient");
  });

  it("matches mixed-case trigger", () => {
    const result = matchFastPath("My Tasks");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("get_tasks");
  });

  it("matches mixed-case in longer sentence", () => {
    const result = matchFastPath("Can you Search Vault for anything about Drevan?");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("sb_search");
  });
});

describe("fast-path non-matches", () => {
  it("returns null for unknown request", () => {
    const result = matchFastPath("completely unrelated gibberish zxqy");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = matchFastPath("");
    expect(result).toBeNull();
  });

  it("returns null for whitespace only", () => {
    const result = matchFastPath("   ");
    expect(result).toBeNull();
  });
});
