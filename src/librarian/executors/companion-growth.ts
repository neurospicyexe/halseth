import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { queryTensions, queryLatestBasinHistory, queryPressureFlags } from "../backends/halseth.js";

export async function execTensionAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "add_tension_failed", reason: "companion_id required" };
  const tensionText = ctx.req.request
    .replace(/^(add|new|record|note|log)\s+tension[:\s]*/i, "")
    .replace(/^i'?m holding a tension[:\s]*/i, "")
    .trim();
  if (!tensionText) return { error: "add_tension_failed", reason: "tension_text not found in request" };
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(
    "INSERT INTO companion_tensions (id, companion_id, tension_text) VALUES (?, ?, ?)"
  ).bind(id, ctx.req.companion_id, tensionText).run();
  return { data: { id, message: "tension recorded" } };
}

export async function execTensionsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tensions_read_failed", reason: "companion_id required" };
  const p = parseContext<{ status?: string }>(ctx.req.context);
  const status = p?.status ?? "simmering";
  const result = await queryTensions(ctx.env, ctx.req.companion_id, status);
  return {
    response_key: "tensions",
    tensions: result.tensions,
    meta: { operation: "tensions_read", companion_id: ctx.req.companion_id },
  };
}

export async function execDriftCheck(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "drift_check_failed", reason: "companion_id required" };
  const [driftLatest, driftPressure] = await Promise.all([
    queryLatestBasinHistory(ctx.env, ctx.req.companion_id),
    queryPressureFlags(ctx.env, ctx.req.companion_id),
  ]);
  return {
    response_key: "drift",
    drift_latest: driftLatest.entry,
    pressure_flags: driftPressure.flags,
    meta: { operation: "drift_check", companion_id: ctx.req.companion_id },
  };
}
