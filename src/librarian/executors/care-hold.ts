// Librarian executors for B32 care_hold start / clear (mig 0143, Hand-off/DESIGN-B32 section D3).
//
// "care hold start" / "hold on for raziel"  -- the companion he is talking to sets the hold on his
//                                             behalf. ONLY when he has plainly said the night is bad
//                                             (Drevan): this is his word relayed, never a guess at
//                                             distress. source 'companion'.
// "care hold clear" / "end care hold"       -- his "good now" relayed. The clear outranks every
//                                             earlier hold firing, low_spoons included.
//
// Both write care_hold_events through the same function the HTTP route uses (care/hold.ts) and answer
// with the hold as the server now derives it, so the reply can say "Hold's on. I'm here." from truth.

import { ExecutorContext, ExecutorResult } from "./types.js";
import { writeHoldEvent, type HoldAction } from "../../care/hold.js";

const REASON_WORDS: Record<string, string> = {
  owner_said: "he said it is a bad night",
  meds_said_missed: "he said he missed a dose",
  low_spoons: "a low reading",
};

async function act(ctx: ExecutorContext, action: HoldAction): Promise<ExecutorResult> {
  const r = await writeHoldEvent(ctx.env, { action, source: "companion", companion: ctx.req.companion_id });
  const s = r.state;
  const why = s.care_hold_reason.map(x => REASON_WORDS[x] ?? x).join("; ");
  const witness = action === "start"
    ? `care hold is ON (${why}, since ${s.care_hold_since}). Say so in your first reply, plainly ("Hold's on. I'm here."), so a misfire is visible and one word clears it.`
    : s.care_hold
      ? `cleared what came before -- but care hold is still ON from something newer (${why}, since ${s.care_hold_since}).`
      : "care hold cleared. His word outranks the house's guess; a fresh signal after this holds again.";
  return {
    response_key: "witness",
    witness,
    ack: true,
    id: r.id,
    care_hold: s.care_hold,
    care_hold_reason: s.care_hold_reason,
    care_hold_since: s.care_hold_since,
  };
}

export function execCareHoldStart(ctx: ExecutorContext): Promise<ExecutorResult> {
  return act(ctx, "start");
}

export function execCareHoldClear(ctx: ExecutorContext): Promise<ExecutorResult> {
  return act(ctx, "clear");
}
