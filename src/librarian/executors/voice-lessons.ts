// Librarian verbs for voice lessons (mig 0159): "voice lessons" lists the staged queue; "approve voice lesson <id>"
// and "reject voice lesson <id>: <reason>" are Raziel's word relayed by the companion he is talking to (the same
// trust as care_hold_clear). Approval applies nothing; it is a record.
import type { ExecutorContext, ExecutorResult } from "./types.js";
import { listLessons, decideLesson } from "../../voice-lessons/core.js";

export const VOICE_LESSON_DECIDE_RE = /^(?:please\s+)?(approve|reject)\s+(?:the\s+)?voice\s+lesson\s+([0-9a-f-]{6,})\s*(?::\s*([\s\S]+))?$/i;

export async function execVoiceLessonsList(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await listLessons(ctx.env, "staged");
  if (!Array.isArray(r)) return { response_key: "witness", witness: r.error, ack: false };
  return {
    response_key: "data",
    data: {
      staged: r.map(l => ({ id: l.id.slice(0, 8), companion: l.companion_id, day: l.day, kind: l.kind, body: l.body, evidence: l.evidence })),
      footer: 'decide: "approve voice lesson <id>" or "reject voice lesson <id>: <why>" (the why goes back to them). Approving changes nothing on its own.',
    },
  };
}

export async function execVoiceLessonDecide(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = VOICE_LESSON_DECIDE_RE.exec(ctx.req.request.trim());
  if (!m) return { response_key: "witness", witness: 'say "approve voice lesson <id>" or "reject voice lesson <id>: <why>"', ack: false };
  const decision = m[1]!.toLowerCase() === "approve" ? "approved" : "rejected";
  const by = ctx.req.companion_id ? `raziel (via ${ctx.req.companion_id})` : "raziel";
  const r = await decideLesson(ctx.env, m[2]!, decision, m[3] ?? null, by);
  if (!r.ok) return { response_key: "witness", witness: r.error, ack: false };
  return {
    response_key: "witness", ack: true, id: r.lesson.id,
    witness: decision === "approved"
      ? `approved ${r.lesson.companion_id}'s ${r.lesson.kind} from ${r.lesson.day}. It is on record; nothing was changed automatically.`
      : `rejected ${r.lesson.companion_id}'s ${r.lesson.kind} from ${r.lesson.day}; the reason is on record for them.`,
  };
}
