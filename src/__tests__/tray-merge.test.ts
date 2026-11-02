// B34 step 2 (mig 0156): one moment, one tray draft. Real SQLite with the full migrated schema.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  trayAwareJournalInsert, trayAwareNoteInsert, trayMergeMode, journalMomentKey, noteMomentKey,
} from "../webmind/tray-insert.js";
import { listTray, readDraft, reviewDraft } from "../webmind/tray.js";
import { isReviewState, KEPT_SQL } from "../webmind/review-state.js";

const mk = (vars: Record<string, string> = {}) => {
  const d = makeSqliteD1();
  return { d, env: { DB: d.DB, ...vars } as any, q: (sql: string, ...b: any[]) => (d as any).db.prepare(sql).all(...b) as any[] };
};
let n = 0;
const speech = (key: string | null, agent = "drevan", extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), agent, note_text: `speech ${n++}`, source: "discord_speech", external_id: `discord:${1000 + n}`,
  tags: JSON.stringify(key ? ["channel:1", `reply_to:${key}`] : ["channel:1"]), ...extra,
});
const judge = (key: string, agent = "drevan") => ({
  id: crypto.randomUUID(), agent, note_text: `judged ${++n}`, source: "memory_judge", external_id: `judge:${key}`,
});
const obs = (key: string, agent = "drevan") => ({
  note_id: crypto.randomUUID(), agent_id: agent, content: `[discord:observation] observed ${++n}`, created_at: new Date().toISOString(),
  correlation_id: `judge:${key}`, source: "discord_observation",
});
const state = (m: ReturnType<typeof mk>, table: string, id: string) =>
  m.q(`SELECT review_state FROM ${table} WHERE ${table === "companion_journal" ? "id" : "note_id"} = ?`, id)[0]?.review_state;
const evidence = (m: ReturnType<typeof mk>, mode?: string) =>
  m.q(`SELECT * FROM tray_evidence ${mode ? "WHERE mode = ?" : ""}`, ...(mode ? [mode] : []));

describe("mode + keys", () => {
  it("per-companion override wins; unset and junk are shadow", () => {
    expect(trayMergeMode({}, "drevan")).toBe("shadow");
    expect(trayMergeMode({ TRAY_MERGE_MODE: "on" }, "drevan")).toBe("on");
    expect(trayMergeMode({ TRAY_MERGE_MODE: "on", TRAY_MERGE_MODE_DREVAN: "off" }, "drevan")).toBe("off");
    expect(trayMergeMode({ TRAY_MERGE_MODE: "on", TRAY_MERGE_MODE_DREVAN: "off" }, "cypher")).toBe("on");
    expect(trayMergeMode({ TRAY_MERGE_MODE: "banana" }, "gaia")).toBe("shadow");
    expect(trayMergeMode({ TRAY_MERGE_MODE: "on", TRAY_MERGE_MODE_GAIA: "junk" }, "gaia")).toBe("shadow");
  });
  it("keys: judge external_id, speech reply_to tag, note correlation; nothing else", () => {
    expect(journalMomentKey(judge("55"))).toEqual({ key: "55", writer: "memory_judge" });
    expect(journalMomentKey(speech("77"))).toEqual({ key: "77", writer: "discord_speech" });
    expect(journalMomentKey(speech(null))).toBeNull();
    expect(journalMomentKey({ source: "memory_judge", external_id: "x", tags: null })).toBeNull();
    expect(journalMomentKey({ source: "autonomous", external_id: "judge:5", tags: null })).toBeNull();
    expect(noteMomentKey({ correlation_id: "judge:9" })).toEqual({ key: "9", writer: "observation" });
    expect(noteMomentKey({ correlation_id: "tray_import:abc" })).toBeNull();
    expect(noteMomentKey({ correlation_id: null })).toBeNull();
  });
});

describe("off", () => {
  it("is today's behaviour: every row a draft, no evidence rows", async () => {
    const m = mk({ TRAY_MERGE_MODE: "off" });
    const a = await trayAwareJournalInsert(m.env, speech("100"), { onConflictExternalId: true });
    const b = await trayAwareJournalInsert(m.env, judge("100"), { onConflictExternalId: true });
    expect([a.review_state, b.review_state]).toEqual(["draft", "draft"]);
    expect(m.q("SELECT review_state FROM companion_journal").map((r) => r.review_state)).toEqual(["draft", "draft"]);
    expect(evidence(m)).toHaveLength(0);
  });
});

describe("shadow", () => {
  it("writes shadow evidence recording what on would do, and changes no review_state", async () => {
    const m = mk({ TRAY_MERGE_MODE: "shadow" });
    const s = speech("200"), j = judge("200"), o = obs("200");
    await trayAwareJournalInsert(m.env, s, { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, j, { onConflictExternalId: true });   // would promote over speech
    await trayAwareNoteInsert(m.env, o);                                      // would be evidence for the judge
    for (const [t, id] of [["companion_journal", s.id], ["companion_journal", j.id], ["wm_continuity_notes", o.note_id]] as const) {
      expect(state(m, t, id)).toBe("draft");
    }
    const rows = evidence(m);
    expect(rows.every((r) => r.mode === "shadow")).toBe(true);
    const bySpeech = rows.find((r) => r.evidence_id === s.id)!;
    expect(bySpeech).toMatchObject({ primary_table: "companion_journal", primary_id: j.id, writer: "discord_speech" });
    expect(rows.find((r) => r.evidence_id === o.note_id)).toMatchObject({ primary_id: j.id, writer: "observation" });
    expect(rows).toHaveLength(2);
    expect((await listTray(m.env, "drevan")).drafts).toHaveLength(3);
  });
  it("is the default when nothing is set", async () => {
    const m = mk();
    await trayAwareJournalInsert(m.env, speech("201"), { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, speech("201"), { onConflictExternalId: true });
    expect(evidence(m, "shadow")).toHaveLength(1);
    expect(m.q("SELECT review_state FROM companion_journal").every((r) => r.review_state === "draft")).toBe(true);
  });
});

describe("on", () => {
  const on = () => mk({ TRAY_MERGE_MODE: "on" });

  it("speech then judge: judge is primary, speech merged", async () => {
    const m = on();
    const s = speech("300"), j = judge("300");
    await trayAwareJournalInsert(m.env, s, { onConflictExternalId: true });
    const r = await trayAwareJournalInsert(m.env, j, { onConflictExternalId: true });
    expect(r.review_state).toBe("draft");
    expect(state(m, "companion_journal", s.id)).toBe("merged");
    expect(state(m, "companion_journal", j.id)).toBe("draft");
    expect(evidence(m, "on")).toEqual([expect.objectContaining({ primary_id: j.id, evidence_id: s.id })]);
  });

  it("judge then observation: observation merged under the judge", async () => {
    const m = on();
    const j = judge("301"), o = obs("301");
    await trayAwareJournalInsert(m.env, j, { onConflictExternalId: true });
    const r = await trayAwareNoteInsert(m.env, o);
    expect(r.review_state).toBe("merged");
    expect(state(m, "wm_continuity_notes", o.note_id)).toBe("merged");
    expect(state(m, "companion_journal", j.id)).toBe("draft");
    expect(evidence(m, "on")[0]).toMatchObject({ primary_table: "companion_journal", primary_id: j.id, evidence_table: "wm_continuity_notes", evidence_id: o.note_id });
  });

  it("two speech rows (split reply) same key: second merged", async () => {
    const m = on();
    const a = speech("302"), b = speech("302");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    const r = await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    expect(r.review_state).toBe("merged");
    expect(state(m, "companion_journal", a.id)).toBe("draft");
    expect(state(m, "companion_journal", b.id)).toBe("merged");
  });

  it("full chain: speech, speech, observation, then judge re-points all evidence to the judge", async () => {
    const m = on();
    const a = speech("303"), b = speech("303"), o = obs("303"), j = judge("303");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    await trayAwareNoteInsert(m.env, o);
    await trayAwareJournalInsert(m.env, j, { onConflictExternalId: true });
    const view = await listTray(m.env, "drevan");
    expect(view.drafts.map((d) => d.id)).toEqual([j.id]);
    expect(view.drafts[0]!.evidence_count).toBe(3);
    expect(view.stats.merged).toBe(3);
    expect(evidence(m, "on").every((r) => r.primary_id === j.id)).toBe(true);
    expect(evidence(m, "on")).toHaveLength(3);
  });

  it("a key whose existing draft was already kept: the new row is born draft normally", async () => {
    const m = on();
    const a = speech("304"), b = speech("304");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    await reviewDraft(m.env, { agent: "drevan", id: a.id, decision: "kept" } as any);
    const r = await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    expect(r.review_state).toBe("draft");
    expect(state(m, "companion_journal", a.id)).toBe("kept");
    expect(evidence(m)).toHaveLength(0);
  });

  it("keys are per agent", async () => {
    const m = on();
    await trayAwareJournalInsert(m.env, speech("305", "drevan"), { onConflictExternalId: true });
    const r = await trayAwareJournalInsert(m.env, speech("305", "cypher"), { onConflictExternalId: true });
    expect(r.review_state).toBe("draft");
  });

  it("unkeyed rows are never touched", async () => {
    const m = on();
    await trayAwareJournalInsert(m.env, speech(null), { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, speech(null), { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, { id: crypto.randomUUID(), agent: "drevan", note_text: "x", source: "memory_judge", external_id: null }, {});
    await trayAwareNoteInsert(m.env, { ...obs("x"), correlation_id: null, content: "[discord:observation] keyless" });
    expect(m.q("SELECT review_state FROM companion_journal").every((r) => r.review_state === "draft")).toBe(true);
    expect(m.q("SELECT review_state FROM wm_continuity_notes WHERE content LIKE '%keyless%'")[0].review_state).toBe("draft");
    expect(evidence(m)).toHaveLength(0);
  });

  it("a retried speech write (same external_id) creates no row and no second evidence row", async () => {
    const m = on();
    await trayAwareJournalInsert(m.env, speech("306"), { onConflictExternalId: true });
    const dup = { ...speech("306"), external_id: "discord:fixed" };
    const r1 = await trayAwareJournalInsert(m.env, dup, { onConflictExternalId: true });
    const r2 = await trayAwareJournalInsert(m.env, { ...dup, id: "retry-id" }, { onConflictExternalId: true });
    expect(r1.changes).toBe(1);
    expect(r2.changes).toBe(0);
    expect(m.q("SELECT id FROM companion_journal WHERE id = 'retry-id'")).toHaveLength(0);
    expect(evidence(m, "on")).toHaveLength(1);
  });

  it("a merge-layer error falls back to the plain insert and logs one line", async () => {
    const m = on();
    (m.d as any).db.exec("DROP TABLE tray_evidence");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = speech("307"), b = speech("307");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    const r = await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    expect(r.changes).toBe(1);
    expect(state(m, "companion_journal", b.id)).toBe("draft");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs ids and counts only, never text", async () => {
    const m = on();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await trayAwareJournalInsert(m.env, speech("308", "drevan", { note_text: "SECRET WORDS" }), { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, judge("308"), { onConflictExternalId: true });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[tray-merge]"));
    expect(lines).toEqual([
      "[tray-merge] mode=on agent=drevan key=308 writer=discord_speech action=primary",
      "[tray-merge] mode=on agent=drevan key=308 writer=memory_judge action=promote_judge",
    ]);
    log.mockRestore();
  });
});

describe("merged review state", () => {
  it("is a ReviewState, never recall-eligible, and the tray list excludes it", async () => {
    expect(isReviewState("merged")).toBe(true);
    expect(KEPT_SQL).toBe("review_state = 'kept'");
    const m = mk({ TRAY_MERGE_MODE: "on" });
    const a = speech("400"), b = speech("400");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    const recall = m.q(`SELECT id FROM companion_journal WHERE agent = 'drevan' AND ${KEPT_SQL}`);
    expect(recall).toHaveLength(0);
    const view = await listTray(m.env, "drevan");
    expect(view.drafts.map((d) => d.id)).toEqual([a.id]);
    expect(view.stats.draft).toBe(1);
    expect(view.stats.kept + view.stats.dropped).toBe(0);
    expect(view.stats_line).toContain("1 merged");
  });

  it("keeping a merged row is refused (not a draft); keeping the primary leaves evidence merged", async () => {
    const m = mk({ TRAY_MERGE_MODE: "on" });
    const a = speech("401"), b = speech("401");
    await trayAwareJournalInsert(m.env, a, { onConflictExternalId: true });
    await trayAwareJournalInsert(m.env, b, { onConflictExternalId: true });
    const refused = await reviewDraft(m.env, { agent: "drevan", id: b.id, decision: "kept" } as any);
    expect(refused).toMatchObject({ ok: false, reason: "already_reviewed", review_state: "merged" });
    const kept = await reviewDraft(m.env, { agent: "drevan", id: a.id, decision: "kept" } as any);
    expect(kept.ok).toBe(true);
    expect(state(m, "companion_journal", b.id)).toBe("merged");
  });
});

describe("readDraft evidence", () => {
  it("a primary returns its on-mode evidence; a shadow row does not appear", async () => {
    const m = mk({ TRAY_MERGE_MODE: "on" });
    const j = judge("500"), o = obs("500");
    await trayAwareJournalInsert(m.env, j, { onConflictExternalId: true });
    await trayAwareNoteInsert(m.env, o);
    const r = await readDraft(m.env, { agent: "drevan", id: j.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.evidence).toEqual([
      expect.objectContaining({ table: "wm_continuity_notes", id: o.note_id, writer: "observation", excerpt: expect.stringContaining("observed") }),
    ]);
    const sh = mk({ TRAY_MERGE_MODE: "shadow" });
    const j2 = judge("501");
    await trayAwareJournalInsert(sh.env, j2, { onConflictExternalId: true });
    await trayAwareNoteInsert(sh.env, obs("501"));
    const r2 = await readDraft(sh.env, { agent: "drevan", id: j2.id });
    expect(r2.ok && r2.draft.evidence).toEqual([]);
  });
});
