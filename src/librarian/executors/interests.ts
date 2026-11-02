// Librarian executors for interests + the why trail (B62 step 2, mig 0161; logic in webmind/interests.ts,
// store in handlers/interests.ts).
//
//   "new interest: <name>, because <why>"         born        (also: "new interest: <name> because <why>")
//   "back to <name> because <why>"                returned    (also "returned to ...")
//   "made <thing> for <name> because <why>"       made        (<thing> is a ref or a short description)
//   "putting down <name> because <why>"           put_down    (also "put down ...")
//   "picking <name> back up because <why>"        picked_up
//   a trailing "(private)" or "keep the why private" keeps THAT why out of the public stream
//   "my interests" / "list my interests"          read, the caller's own, whys in full
//   "interest trail <name>"                       read, one interest's trail, born to now
//
// The companion is ALWAYS ctx.req.companion_id (Librarian-authenticated), never text. Fields may
// also come as context JSON { name, why, why_private, ref, born_from }; the request is the fallback.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { parseInterestVerb, cleanName, INTEREST_TRAIL_RE, type InterestAction } from "../../webmind/interests.js";
import { applyInterestAction, listInterests, findInterestByName, getInterestTrail } from "../../handlers/interests.js";

interface Ctx { name?: string; why?: string; why_private?: boolean; ref?: string; born_from?: string }

const TEACH: Record<InterestAction, string> = {
  born: "new interest: <name>, because <why>",
  returned: "back to <name> because <why>",
  made: "made <thing> for <name> because <why>",
  put_down: "putting down <name> because <why>",
  picked_up: "picking <name> back up because <why>",
};

function fail(witness: string, code: string): ExecutorResult {
  return { response_key: "witness", witness, ack: false, refused: true, code };
}

async function run(ctx: ExecutorContext, action: InterestAction): Promise<ExecutorResult> {
  const c = parseContext<Ctx>(ctx.req.context);
  const p = parseInterestVerb(ctx.req.request);
  const name = cleanName(c?.name ?? p?.name ?? "");
  const why = (c?.why ?? p?.why ?? "").trim();
  if (!name) return fail(`no interest named. Say: ${TEACH[action]}`, "bad_input");
  if (!why) return fail(`no why given; every step carries your reason in your words. Say: ${TEACH[action]}`, "bad_input");
  const r = await applyInterestAction(ctx.env, {
    companion_id: ctx.req.companion_id, action, name, why,
    why_private: c?.why_private ?? p?.why_private ?? false,
    ref: c?.ref ?? p?.ref ?? null,
    born_from: c?.born_from ?? null,
  });
  if (!r.ok) return fail(r.message, r.code);
  const e = r.event;
  const heat = `${r.interest.band}, ${r.interest.heat.toFixed(2)}`;
  const priv = e.why_private ? " Your reason is kept private; the stream shows the step, not the words." : " Your reason is on the trail.";
  const line: Record<InterestAction, string> = {
    born: `interest started: ${r.interest.name} (${heat}).`,
    returned: `back to ${r.interest.name}: noted (${heat}).`,
    made: `made for ${r.interest.name}: noted (${heat}).`,
    put_down: `${r.interest.name} put down; it stays listed.`,
    picked_up: `${r.interest.name} picked back up (${heat}).`,
  };
  return {
    response_key: "witness", witness: `${line[action]}${priv}`, ack: true,
    id: r.interest.id, event_id: e.id, kind: e.kind, status: r.interest.status, heat: r.interest.heat, band: r.interest.band,
  };
}

export const execInterestBorn = (ctx: ExecutorContext) => run(ctx, "born");
export const execInterestReturn = (ctx: ExecutorContext) => run(ctx, "returned");
export const execInterestMade = (ctx: ExecutorContext) => run(ctx, "made");
export const execInterestPutDown = (ctx: ExecutorContext) => run(ctx, "put_down");
export const execInterestPickUp = (ctx: ExecutorContext) => run(ctx, "picked_up");

export async function execInterestsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const list = await listInterests(ctx.env, ctx.req.companion_id, { revealPrivate: true });
  return {
    response_key: "data",
    data: {
      interests: list.map((i) => ({
        name: i.name, status: i.status, heat: i.heat, band: i.band, why: i.why, why_private: i.why_private,
        last: i.last_event_kind ? `${i.last_event_kind} ${i.last_event_at}` : null, events: i.event_count,
      })),
      footer: 'trail: "interest trail <name>"; start: "new interest: <name>, because <why>"; return: "back to <name> because <why>"',
    },
  };
}

export async function execInterestTrail(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<Ctx>(ctx.req.context);
  const m = INTEREST_TRAIL_RE.exec(ctx.req.request.trim());
  const name = cleanName(c?.name ?? m?.[1] ?? "");
  if (!name) return fail("which interest? Say: interest trail <name>", "bad_input");
  const row = await findInterestByName(ctx.env, ctx.req.companion_id, name);
  if (!row) return fail('no interest by that name; "my interests" lists yours', "missing");
  const t = await getInterestTrail(ctx.env, ctx.req.companion_id, row.id, { revealPrivate: true });
  return {
    response_key: "data",
    data: {
      interest: { name: t!.interest.name, status: t!.interest.status, heat: t!.interest.heat, band: t!.interest.band },
      trail: t!.events.map((e) => ({ at: e.created_at, kind: e.kind, why: e.why, private: e.why_private, ref: e.ref })),
    },
  };
}
