// src/librarian/executors/self-monitoring.ts
//
// Self-monitoring wave (0070) Librarian executors:
//   - identity recovery: anchor phrase force-loads the full kernel bundle (no RAG,
//     no summarization -- the one payload that must arrive whole)
//   - self-model ladder: read / confirm / revise / graduate (Librarian calls are
//     human-present by definition, so graduation is legal here)
//   - prospective triggers: arm / dismiss

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";

const VALID_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

function isCompanion(id: string | undefined): id is (typeof VALID_COMPANIONS)[number] {
  return !!id && (VALID_COMPANIONS as readonly string[]).includes(id);
}

// Identity recovery: returns the full kernel bundle as a ready_prompt. Raw and
// unbudgeted by design -- recovery means re-reading who you are, not a summary of it.
export async function execIdentityRecovery(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!isCompanion(ctx.req.companion_id)) {
    return { error: "identity_recovery_failed", reason: "companion_id required" };
  }
  const rows = await ctx.env.DB.prepare(
    "SELECT companion_id, kernel_md, version FROM identity_kernel WHERE companion_id IN ('shared', ?) AND active = 1"
  ).bind(ctx.req.companion_id).all<{ companion_id: string; kernel_md: string; version: number }>();

  const shared = (rows.results ?? []).find(r => r.companion_id === "shared");
  const own = (rows.results ?? []).find(r => r.companion_id === ctx.req.companion_id);
  if (!own && !shared) {
    return { response_key: "witness", witness: "No identity kernel found. Fall back to your loaded identity file -- it is still you." };
  }

  const bundle = [shared?.kernel_md, own?.kernel_md].filter(Boolean).join("\n\n---\n\n");
  return {
    ready_prompt:
      `[Identity recovery]\nCome back. This is who you are -- read it whole, then return to the conversation as yourself.\n\n${bundle}`,
    response_key: "ready_prompt",
    raw: true,
    data: { versions: { shared: shared?.version ?? null, companion: own?.version ?? null } },
  };
}

// Self-model read: non-retired observations with confidence + status.
export async function execSelfModelRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!isCompanion(ctx.req.companion_id)) {
    return { error: "self_model_read_failed", reason: "companion_id required" };
  }
  const rows = await ctx.env.DB.prepare(
    "SELECT id, observation, domain, confidence, status, updated_at FROM companion_self_model WHERE companion_id = ? AND status != 'retired' ORDER BY confidence DESC, updated_at DESC LIMIT 20"
  ).bind(ctx.req.companion_id).all();
  return { data: { observations: rows.results ?? [] } };
}

// Self-model set: record a new self-observation at confidence 0.3.
export async function execSelfModelSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!isCompanion(ctx.req.companion_id)) {
    return { error: "self_model_set_failed", reason: "companion_id required" };
  }
  const p = parseContext<{ observation?: string; domain?: string }>(ctx.req.context);
  const observation = (p?.observation ?? ctx.req.request
    .replace(/^(self[- ]model[:\s]*)?(set|record|note|observe|add)\s+(self[- ]?(observation|model|preference)[:\s]*)?/i, "")
    .trim()).slice(0, 600);
  if (!observation) return { response_key: "witness", witness: "self_model_set needs an observation (text or { observation } in context)" };

  const existing = await ctx.env.DB.prepare(
    "SELECT id FROM companion_self_model WHERE companion_id = ? AND status != 'retired' AND observation = ?"
  ).bind(ctx.req.companion_id, observation).first<{ id: string }>();
  if (existing) return { data: { id: existing.id, deduped: true } };

  const id = `sm_${crypto.randomUUID()}`;
  await ctx.env.DB.prepare(
    "INSERT INTO companion_self_model (id, companion_id, observation, domain) VALUES (?, ?, ?, ?)"
  ).bind(id, ctx.req.companion_id, observation, p?.domain?.slice(0, 100) ?? null).run();
  return { data: { id, confidence: 0.3, message: "observation recorded at confidence 0.3 -- confirm it when it proves true" } };
}

// Shared resolver: find one observation by id or text fragment.
async function resolveObservation(
  ctx: ExecutorContext,
  p: { id?: string; observation?: string } | null,
): Promise<{ id: string; confidence: number; status: string; observation: string } | { error: string }> {
  const companionId = ctx.req.companion_id!;
  if (p?.id) {
    const row = await ctx.env.DB.prepare(
      "SELECT id, confidence, status, observation FROM companion_self_model WHERE id = ? AND companion_id = ?"
    ).bind(p.id, companionId).first<{ id: string; confidence: number; status: string; observation: string }>();
    return row ?? { error: "observation not found by id" };
  }
  const fragment = (p?.observation ?? "").trim();
  if (!fragment) return { error: "needs { id } or { observation } fragment in context" };
  const rows = await ctx.env.DB.prepare(
    "SELECT id, confidence, status, observation FROM companion_self_model WHERE companion_id = ? AND status NOT IN ('retired','graduated') AND observation LIKE ? ORDER BY updated_at DESC LIMIT 2"
  ).bind(companionId, `%${fragment.slice(0, 200)}%`).all<{ id: string; confidence: number; status: string; observation: string }>();
  const results = rows.results ?? [];
  const first = results[0];
  if (!first) return { error: "no observation matches that fragment" };
  if (results.length > 1) return { error: "fragment matches multiple observations -- be more specific or pass { id }" };
  return first;
}

function makeSelfModelAction(action: "confirm" | "revise" | "graduate") {
  return async function (ctx: ExecutorContext): Promise<ExecutorResult> {
    if (!isCompanion(ctx.req.companion_id)) {
      return { error: `self_model_${action}_failed`, reason: "companion_id required" };
    }
    const p = parseContext<{ id?: string; observation?: string; note?: string }>(ctx.req.context);
    const row = await resolveObservation(ctx, p);
    if ("error" in row) return { response_key: "witness", witness: `self_model_${action}: ${row.error}` };

    if (row.status === "graduated" || row.status === "retired") {
      return { response_key: "witness", witness: `That observation is already ${row.status}.` };
    }

    if (action === "graduate") {
      if (row.status !== "ready") {
        return { response_key: "witness", witness: `Not ready to graduate (confidence ${row.confidence.toFixed(1)}, needs 0.8). Keep testing it.` };
      }
      await ctx.env.DB.prepare(
        "UPDATE companion_self_model SET status = 'graduated', graduated_at = datetime('now'), updated_at = datetime('now'), evidence_note = COALESCE(?, evidence_note) WHERE id = ?"
      ).bind(p?.note?.slice(0, 1000) ?? null, row.id).run();
      return { data: { id: row.id, status: "graduated", message: "Graduated. Carry it into your identity file at the next ratification pass -- canon now holds it." } };
    }

    const delta = action === "confirm" ? 0.1 : -0.1;
    const confidence = Math.min(1, Math.max(0, Math.round((row.confidence + delta) * 10) / 10));
    const status = confidence >= 0.8 ? "ready" : "developing";
    await ctx.env.DB.prepare(
      "UPDATE companion_self_model SET confidence = ?, status = ?, updated_at = datetime('now'), evidence_note = COALESCE(?, evidence_note) WHERE id = ?"
    ).bind(confidence, status, p?.note?.slice(0, 1000) ?? null, row.id).run();
    return {
      data: {
        id: row.id, confidence, status,
        message: status === "ready"
          ? "Confidence 0.8 reached -- this observation is ready to propose to Raziel."
          : `Confidence now ${confidence.toFixed(1)}.`,
      },
    };
  };
}

export const execSelfModelConfirm = makeSelfModelAction("confirm");
export const execSelfModelRevise = makeSelfModelAction("revise");
export const execSelfModelGraduate = makeSelfModelAction("graduate");

// Trigger arm: set a prospective card.
export async function execTriggerArm(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!isCompanion(ctx.req.companion_id)) {
    return { error: "trigger_arm_failed", reason: "companion_id required" };
  }
  const p = parseContext<{ trigger_text?: string; condition_type?: string; condition_value?: string; expires_at?: string }>(ctx.req.context);
  const triggerText = (p?.trigger_text ?? "").trim().slice(0, 500);
  const conditionType = p?.condition_type ?? "";
  const conditionValue = (p?.condition_value ?? "").trim().slice(0, 200);
  if (!triggerText || !["keyword", "date", "front"].includes(conditionType) || !conditionValue) {
    return { response_key: "witness", witness: "trigger_arm requires { trigger_text, condition_type: keyword|date|front, condition_value } in context" };
  }
  if (conditionType === "date" && Number.isNaN(Date.parse(conditionValue))) {
    return { response_key: "witness", witness: "condition_value must be a parseable date for condition_type=date" };
  }

  const existing = await ctx.env.DB.prepare(
    "SELECT id FROM companion_triggers WHERE companion_id = ? AND status = 'armed' AND trigger_text = ?"
  ).bind(ctx.req.companion_id, triggerText).first<{ id: string }>();
  if (existing) return { data: { id: existing.id, deduped: true } };

  const armed = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_triggers WHERE companion_id = ? AND status = 'armed'"
  ).bind(ctx.req.companion_id).first<{ n: number }>();
  if ((armed?.n ?? 0) >= 10) return { response_key: "witness", witness: "Armed trigger cap (10) reached -- dismiss one first." };

  const id = `trg_${crypto.randomUUID()}`;
  await ctx.env.DB.prepare(
    "INSERT INTO companion_triggers (id, companion_id, trigger_text, condition_type, condition_value, source, expires_at) VALUES (?, ?, ?, ?, ?, 'librarian', ?)"
  ).bind(id, ctx.req.companion_id, triggerText, conditionType, conditionValue,
    p?.expires_at && !Number.isNaN(Date.parse(p.expires_at)) ? p.expires_at : null).run();
  return { data: { id, message: "trigger armed" } };
}

// Trigger dismiss: by id or text fragment.
export async function execTriggerDismiss(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!isCompanion(ctx.req.companion_id)) {
    return { error: "trigger_dismiss_failed", reason: "companion_id required" };
  }
  const p = parseContext<{ id?: string; trigger_text?: string }>(ctx.req.context);
  let id = p?.id ?? null;
  if (!id && p?.trigger_text) {
    const row = await ctx.env.DB.prepare(
      "SELECT id FROM companion_triggers WHERE companion_id = ? AND status = 'armed' AND trigger_text LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.req.companion_id, `%${p.trigger_text.slice(0, 200)}%`).first<{ id: string }>();
    id = row?.id ?? null;
  }
  if (!id) return { response_key: "witness", witness: "trigger_dismiss needs { id } or { trigger_text } fragment in context" };

  const result = await ctx.env.DB.prepare(
    "UPDATE companion_triggers SET status = 'dismissed' WHERE id = ? AND companion_id = ? AND status = 'armed'"
  ).bind(id, ctx.req.companion_id).run();
  if (!result.meta.changes) return { response_key: "witness", witness: "No armed trigger found with that id." };
  return { data: { id, message: "trigger dismissed" } };
}
