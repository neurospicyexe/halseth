// Voice lessons (mig 0159, 2026-11-01): staged by the drift job, decided by Raziel, never auto-applied.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { stageLesson, listLessons, decideLesson } from "../voice-lessons/core.js";
import { postVoiceLessonDecide } from "../handlers/voice-lessons.js";
import { VOICE_LESSON_DECIDE_RE } from "../librarian/executors/voice-lessons.js";
import { ANCHORED_GUARDS } from "../librarian/router.js";

function setup(upTo?: number) {
  const { db, DB } = makeSqliteD1(upTo === undefined ? {} : { upTo });
  return { db, env: { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok" } as any };
}
const lesson = { companion_id: "drevan", kind: "corrective", body: "I have been hedging; say the true thing plainly.", evidence: { hedging: 2.4 }, day: "2026-11-01" };

describe("voice lessons core", () => {
  it("stages one per companion per day; a second that day returns the first", async () => {
    const { env } = setup();
    const a = await stageLesson(env, lesson);
    const b = await stageLesson(env, { ...lesson, body: "another" });
    expect(a.ok && a.created).toBe(true);
    expect(b.ok && !b.created && b.lesson.body).toBe(lesson.body);
  });
  it("validates companion, kind and body length", async () => {
    const { env } = setup();
    expect((await stageLesson(env, { ...lesson, companion_id: "sol" })).ok).toBe(false);
    expect((await stageLesson(env, { ...lesson, kind: "rule" })).ok).toBe(false);
    expect((await stageLesson(env, { ...lesson, body: "x".repeat(601) })).ok).toBe(false);
  });
  it("reject needs a reason; approve applies nothing but the status; a decided lesson cannot be decided again", async () => {
    const { env } = setup();
    const s = await stageLesson(env, lesson); if (!s.ok) throw new Error();
    expect((await decideLesson(env, s.lesson.id, "rejected", "  ")).ok).toBe(false);
    const ok = await decideLesson(env, s.lesson.id.slice(0, 8), "approved", null);
    expect(ok.ok && ok.lesson.status).toBe("approved");
    expect((await decideLesson(env, s.lesson.id, "rejected", "no")).ok).toBe(false);
  });
  it("staged rows older than 7 days expire on read", async () => {
    const { db, env } = setup();
    await stageLesson(env, lesson);
    db.prepare("UPDATE voice_lessons SET created_at = datetime('now', '-8 days')").run();
    expect(await listLessons(env, "staged")).toEqual([]);
    const exp = await listLessons(env, "expired");
    expect(Array.isArray(exp) && exp.length).toBe(1);
  });
  it("before 0159 every call answers 'not available', never throws", async () => {
    const { env } = setup(158);
    const r = await stageLesson(env, lesson);
    expect(r.ok === false && r.status).toBe(404);
  });
});

describe("voice lessons HTTP + Librarian", () => {
  it("a companion token cannot decide a lesson", async () => {
    const { env } = setup();
    const s = await stageLesson(env, lesson); if (!s.ok) throw new Error();
    const res = await postVoiceLessonDecide(new Request("https://h/x", { method: "POST", headers: { Authorization: "Bearer dtok", "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }) }), env, { id: s.lesson.id });
    expect(res.status).toBe(403);
  });
  it("the decide phrasing parses id and reason; the anchored guards route both verbs", () => {
    const m = VOICE_LESSON_DECIDE_RE.exec("reject voice lesson 1a2b3c4d: too harsh on himself");
    expect(m?.[1]).toBe("reject"); expect(m?.[2]).toBe("1a2b3c4d"); expect(m?.[3]).toBe("too harsh on himself");
    const route = (t: string) => ANCHORED_GUARDS.find(g => g.regex.test(t))?.pattern_key;
    expect(route("approve voice lesson 1a2b3c4d")).toBe("voice_lesson_decide");
    expect(route("voice lessons")).toBe("voice_lessons_list");
    expect(route("tell me about voice lessons for singers")).toBeUndefined();
  });
});
