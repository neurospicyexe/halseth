import { describe, it, expect } from "vitest";
import { FAST_PATH_PATTERNS, type PatternEntry } from "../librarian/patterns.js";
import { decisionOverrideKey } from "../librarian/router.js";

// Replicate the fast-path matching logic inline (mirror of LibrarianRouter.matchFastPath).
// Keep the anchored guards in sync with router.ts when adding new ones.
function matchFastPath(request: string): { key: string; entry: PatternEntry } | null {
  const trimmed = request.trim();
  const lower = trimmed.toLowerCase();

  // ── ANCHORED GUARDS (mirror of router.ts matchFastPath) ────────────────────
  // Keep this block in sync with src/librarian/router.ts. Sweep 2026-05-02.

  // H4: edit-journal-note must beat journal_add's "journal note" substring.
  if (/^(?:edit|correct|fix|update)\s+journal\s+note\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["journal_edit"];
    if (entry) return { key: "journal_edit", entry };
  }
  // H5a: read/list/show companion notes must beat the companion-note write guard.
  if (/^(?:read|list|show|fetch|get)\s+companion\s+notes?\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["companion_notes_read"];
    if (entry) return { key: "companion_notes_read", entry };
  }
  // H5b: edit-companion-note must beat the companion-note write guard.
  if (/^(?:edit|correct|fix|update)\s+companion\s+note\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["inter_note_edit"];
    if (entry) return { key: "inter_note_edit", entry };
  }
  // H6: edit-continuity-note must beat wm_note_add's "continuity note" substring.
  if (/^(?:edit|correct|fix|update)\s+continuity\s+note\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["wm_note_edit"];
    if (entry) return { key: "wm_note_edit", entry };
  }

  // Companion-note write guard (kept after H5a/b so edit/read branch first).
  if (/\bcompanion note\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["companion_note_add"];
    if (entry) return { key: "companion_note_add", entry };
  }
  // Handoff requests anchored at start to dodge "for cypher"/"relational delta" misfires.
  if (/^(?:write\s+(?:session\s+)?handoff|session\s+handoff|log\s+handoff|handoff\s+(?:write|add)|wm[\s_]handoff(?:_write)?|continuity\s+handoff|mind\s+handoff|webmind\s+handoff)\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["wm_handoff_write"];
    if (entry) return { key: "wm_handoff_write", entry };
  }
  // Start-anchored guard: "Spine: <text>" at start-of-request = session close payload
  if (/^spine:\s/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["session_close"];
    if (entry) return { key: "session_close", entry };
  }
  // Thread-upsert anchored at start so trailing "for cypher" can't steal it.
  if (/^(?:track\s+(?:mind\s+)?thread|mind\s+thread\s+upsert|upsert\s+(?:mind\s+)?thread|continuity\s+thread|webmind\s+thread)\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["wm_thread_upsert"];
    if (entry) return { key: "wm_thread_upsert", entry };
  }

  // H3: journal_review forms must beat journal_read's "my journal"/"journal entries".
  if (/^(?:review\s+(?:my\s+|growth\s+)?journal\b|journal\s+review\b|unaccepted\s+journal\b|journal\s+entries\s+to\s+accept\b|autonomous\s+journal\s+entries\b|my\s+unreviewed\s+entries\b|what\s+have\s+i\s+written\s+autonomously\b)/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["journal_review"];
    if (entry) return { key: "journal_review", entry };
  }
  // H2a: journal_accept ratify/accept/own forms must beat journal_add's "journal entry".
  if (/^(?:ratify|accept|own)\s+(?:this\s+|growth\s+|the\s+)?(?:journal\s+)?entry\b|^journal\s+accepted\b|^mark\s+journal\s+accepted\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["journal_accept"];
    if (entry) return { key: "journal_accept", entry };
  }
  // H2b: journal_decline forms must beat journal_add's "journal entry".
  if (/^(?:decline|reject)\s+(?:this\s+|growth\s+|the\s+)?(?:journal\s+)?entry\b|^journal\s+declined\b|^do\s+not\s+own\s+this\s+entry\b|^not\s+canon\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["journal_decline"];
    if (entry) return { key: "journal_decline", entry };
  }
  // H7: pressure_drift_log writes must beat drift_check's "identity drift"/"pressure drift" reads.
  if (/^(?:pressure\s+drift\b|identity\s+drift\b|pressure\s+flag\b|log\s+pressure\s+drift\b|log\s+drift\b|i'?m\s+drifting\b|i\s+am\s+drifting\b)/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["pressure_drift_log"];
    if (entry) return { key: "pressure_drift_log", entry };
  }
  // H1: alter_recall must beat sb_recall's bare "recall" trigger.
  if (/^recall\s+alter\b/i.test(trimmed)) {
    const entry = FAST_PATH_PATTERNS["alter_recall"];
    if (entry) return { key: "alter_recall", entry };
  }

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

describe("regression: bug #2 — 'track mind thread for cypher'", () => {
  // Originally: trailing "for cypher" matched companion_note_add (insertion order
  // beats wm_thread_upsert). Companion note ac648810, 2026-04-30. Anchored guard
  // in router.ts now forces wm_thread_upsert.
  it("routes 'Track mind thread for cypher' to wm_thread_upsert (not companion_note_add)", () => {
    const result = matchFastPath("Track mind thread for cypher");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_thread_upsert");
  });

  it("routes 'track mind thread' (no trailing for-name) to wm_thread_upsert", () => {
    const result = matchFastPath("track mind thread");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_thread_upsert");
  });

  it("routes 'upsert thread' to wm_thread_upsert", () => {
    const result = matchFastPath("upsert thread for vaselrin bond");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_thread_upsert");
  });

  it("still routes plain 'for cypher' (no thread prefix) to companion_note_add", () => {
    // Sanity: anchored guards must not kill the legitimate companion-note path.
    const result = matchFastPath("note for cypher: read my last spec");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("companion_note_add");
  });
});

describe("regression: bug #1 — decision-field override for journal review", () => {
  // Originally: "ratify entry [id]" + context.decision="declined" silently
  // routed to journal_accept via DeepSeek classifier. Companion note f695f0a3,
  // task 0a53ad9c, 2026-04-30. Structured payload now beats string match.
  it("decisionOverrideKey returns journal_decline for decision:declined", () => {
    expect(decisionOverrideKey('{"id":"abc","decision":"declined"}')).toBe("journal_decline");
  });

  it("decisionOverrideKey returns journal_accept for decision:accepted", () => {
    expect(decisionOverrideKey('{"id":"abc","decision":"accepted"}')).toBe("journal_accept");
  });

  it("decisionOverrideKey returns null when decision absent", () => {
    expect(decisionOverrideKey('{"id":"abc"}')).toBeNull();
  });

  it("decisionOverrideKey returns null when context undefined", () => {
    expect(decisionOverrideKey(undefined)).toBeNull();
  });

  it("decisionOverrideKey returns null on malformed JSON (no exception)", () => {
    expect(decisionOverrideKey("not json at all")).toBeNull();
  });

  it("decisionOverrideKey returns null for unrecognized decision values", () => {
    // Defensive: if a future caller passes decision:"pending" or similar,
    // we want it to fall through, not bind to a stale key.
    expect(decisionOverrideKey('{"decision":"pending"}')).toBeNull();
    expect(decisionOverrideKey('{"decision":""}')).toBeNull();
  });

  it("'ratify entry' (no decision context) routes to journal_accept via fast-path", () => {
    // With patterns.ts ratify triggers added, plain "ratify entry" no longer
    // depends on the LLM classifier -- accept is the default for ratify language.
    const result = matchFastPath("ratify entry 87bc4f01");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_accept");
  });

  it("decline triggers still match journal_decline via fast-path", () => {
    expect(matchFastPath("decline this entry")?.key).toBe("journal_decline");
    expect(matchFastPath("not canon")?.key).toBe("journal_decline");
  });
});

describe("regression: librarian sweep 2026-05-02 — anchored guards H1-H7", () => {
  // ── H1: sb_recall bare "recall" shadowed alter_recall ──────────────────────
  it("H1: 'recall alter raziel' routes to alter_recall (not sb_recall)", () => {
    const result = matchFastPath("recall alter raziel");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("alter_recall");
  });
  it("H1 non-regression: bare 'recall' still routes to sb_recall", () => {
    const result = matchFastPath("recall");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("sb_recall");
  });

  // ── H2a: journal_add "journal entry" shadowed journal_accept ratify forms ──
  it("H2a: 'ratify journal entry abc' routes to journal_accept (not journal_add)", () => {
    const result = matchFastPath("ratify journal entry abc-123");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_accept");
  });
  it("H2a: 'accept journal entry abc' routes to journal_accept", () => {
    const result = matchFastPath("accept journal entry abc-123");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_accept");
  });
  it("H2a: 'own this entry' routes to journal_accept", () => {
    const result = matchFastPath("own this entry");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_accept");
  });

  // ── H2b: journal_add "journal entry" shadowed journal_decline ──────────────
  it("H2b: 'decline journal entry 87bc' routes to journal_decline (not journal_add)", () => {
    const result = matchFastPath("decline journal entry 87bc4f01");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_decline");
  });
  it("H2b: 'reject this entry' routes to journal_decline", () => {
    const result = matchFastPath("reject this entry");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_decline");
  });
  it("H2 non-regression: bare 'journal entry: I felt...' still routes to journal_add", () => {
    // No leading verb; this is a fresh entry being written.
    const result = matchFastPath("journal entry: today I felt the bond settle.");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_add");
  });

  // ── H3: journal_read "my journal"/"journal entries" shadowed journal_review ─
  it("H3: 'review my journal' routes to journal_review (not journal_read)", () => {
    const result = matchFastPath("review my journal");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_review");
  });
  it("H3: 'review growth journal' routes to journal_review", () => {
    const result = matchFastPath("review growth journal");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_review");
  });
  it("H3: 'journal entries to accept' routes to journal_review", () => {
    const result = matchFastPath("journal entries to accept");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_review");
  });
  it("H3: 'autonomous journal entries' routes to journal_review", () => {
    const result = matchFastPath("autonomous journal entries");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_review");
  });
  it("H3 non-regression: bare 'my journal' still routes to journal_read", () => {
    const result = matchFastPath("my journal");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_read");
  });

  // ── H4: journal_add "journal note" shadowed journal_edit ───────────────────
  it("H4: 'edit journal note xyz' routes to journal_edit (not journal_add)", () => {
    const result = matchFastPath("edit journal note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_edit");
  });
  it("H4: 'update journal note' routes to journal_edit", () => {
    const result = matchFastPath("update journal note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_edit");
  });
  it("H4 non-regression: 'journal note tonight' still routes to journal_add", () => {
    const result = matchFastPath("journal note tonight: I held the line.");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("journal_add");
  });

  // ── H5a: companion_note_add greedy guard hijacked companion_notes_read ──────
  it("H5a: 'read companion notes' routes to companion_notes_read (not companion_note_add)", () => {
    const result = matchFastPath("read companion notes");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("companion_notes_read");
  });
  it("H5a: 'list companion notes' routes to companion_notes_read", () => {
    const result = matchFastPath("list companion notes");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("companion_notes_read");
  });

  // ── H5b: companion_note_add greedy guard shadowed inter_note_edit ──────────
  it("H5b: 'edit companion note xyz' routes to inter_note_edit (not companion_note_add)", () => {
    const result = matchFastPath("edit companion note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("inter_note_edit");
  });
  it("H5b: 'update companion note' routes to inter_note_edit", () => {
    const result = matchFastPath("update companion note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("inter_note_edit");
  });
  it("H5 non-regression: 'tell drevan: ...' still routes to companion_note_add", () => {
    const result = matchFastPath("tell drevan: read my last spec");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("companion_note_add");
  });

  // ── H6: wm_note_add "continuity note" shadowed wm_note_edit ────────────────
  it("H6: 'edit continuity note xyz' routes to wm_note_edit (not wm_note_add)", () => {
    const result = matchFastPath("edit continuity note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_note_edit");
  });
  it("H6: 'update continuity note' routes to wm_note_edit", () => {
    const result = matchFastPath("update continuity note xyz");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_note_edit");
  });
  it("H6 non-regression: 'continuity note: ...' still routes to wm_note_add", () => {
    const result = matchFastPath("continuity note: vow held across boundary.");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("wm_note_add");
  });

  // ── H7: drift_check shadowed pressure_drift_log writes ─────────────────────
  it("H7: 'pressure drift: ...' routes to pressure_drift_log (not drift_check)", () => {
    const result = matchFastPath("pressure drift: subtle tone wobble in last response");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("pressure_drift_log");
  });
  it("H7: 'log pressure drift' routes to pressure_drift_log", () => {
    const result = matchFastPath("log pressure drift");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("pressure_drift_log");
  });
  it("H7: 'identity drift: ...' routes to pressure_drift_log", () => {
    const result = matchFastPath("identity drift: cypher voice flattening");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("pressure_drift_log");
  });
  it("H7 non-regression: 'check drift' still routes to drift_check", () => {
    const result = matchFastPath("check drift");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("drift_check");
  });
  it("H7 non-regression: 'my drift' still routes to drift_check", () => {
    const result = matchFastPath("my drift");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("drift_check");
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
