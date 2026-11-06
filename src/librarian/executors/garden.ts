// Librarian executors for Gaia's garden (mig 0171; logic in webmind/garden.ts).
//
//   plant the witness | plant <id-prefix> | plant "opening words"   Gaia only
//   pull <planting id-prefix>                                        Gaia only
//   my garden                                                        Gaia only (ids, kinds, status, dates; no text)
//   garden yes|no <planting id-prefix>                               ONLY the sibling a one-sibling note waits on
//
// The caller is ALWAYS ctx.req.companion_id, never text. Nothing here sends a note.

import { ExecutorContext, ExecutorResult } from "./types.js";
import {
  parsePlantVerb, parsePullVerb, parseConsentVerb, plantRef, pullPlanting, answerConsent, listGarden,
  GARDEN_COMPANION, PLANT_TEACH, type GardenResult,
} from "../../webmind/garden.js";

function out(r: GardenResult): ExecutorResult {
  if (!r.ok) {
    const cands = r.candidates?.length ? ` Candidates: ${r.candidates.join("; ")}.` : "";
    return { response_key: "witness", witness: `${r.message}${cands}`, ack: false, refused: true, code: r.code, ...(r.candidates ? { candidates: r.candidates } : {}) };
  }
  return { response_key: "witness", ack: true, id: r.id, kind: r.kind, outcome: r.outcome, witness: r.message, ...(r.sibling ? { sibling: r.sibling } : {}) };
}
const bad = (witness: string): ExecutorResult => ({ response_key: "witness", witness, ack: false, refused: true, code: "bad_input" });

export async function execGardenPlant(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parsePlantVerb(ctx.req.request);
  if (!p) return bad(`say: ${PLANT_TEACH}, or: plant the witness`);
  return out(await plantRef(ctx.env, { caller: ctx.req.companion_id, ref: p }));
}

export async function execGardenPull(ctx: ExecutorContext): Promise<ExecutorResult> {
  const id = parsePullVerb(ctx.req.request);
  if (!id) return bad("say: pull <planting id-prefix>");
  return out(await pullPlanting(ctx.env, { caller: ctx.req.companion_id, id }));
}

export async function execGardenConsent(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseConsentVerb(ctx.req.request);
  if (!p) return bad("say: garden yes <planting id-prefix> or garden no <planting id-prefix>");
  return out(await answerConsent(ctx.env, { caller: ctx.req.companion_id, id: p.id, answer: p.answer }));
}

export async function execGardenRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (ctx.req.companion_id !== GARDEN_COMPANION) {
    return { response_key: "witness", witness: "the garden is Gaia's.", ack: false, refused: true, code: "gaia_only" };
  }
  const lines = await listGarden(ctx.env);
  return { response_key: "data", data: { plantings: lines, footer: `plant: "${PLANT_TEACH}", plant the witness, pull <id>` } };
}
