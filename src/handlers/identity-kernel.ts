// src/handlers/identity-kernel.ts
//
// Versioned Identity Kernel: the canonical companion identity, stored once,
// pulled by every substrate at boot (worker, Brain, bots, Claude.ai bundle).
// 'shared' holds the triad doctrine bundle (substrate continuity, basin
// readings, ratification protocol) prepended to every companion bundle.
//
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_KERNEL_IDS = ["cypher", "drevan", "gaia", "shared"] as const;
type KernelId = (typeof VALID_KERNEL_IDS)[number];

const MIN_KERNEL_LENGTH = 200; // guards accidental blank/truncated uploads

interface KernelRow {
  id: string;
  companion_id: string;
  version: number;
  kernel_md: string;
  vows_json: string | null;
  checksum: string;
  source_note: string | null;
  active: number;
  created_at: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isKernelId(id: string): id is KernelId {
  return (VALID_KERNEL_IDS as readonly string[]).includes(id);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getActiveKernel(env: Env, companionId: string): Promise<KernelRow | null> {
  return env.DB.prepare(
    "SELECT * FROM identity_kernel WHERE companion_id = ? AND active = 1 ORDER BY version DESC LIMIT 1"
  ).bind(companionId).first<KernelRow>();
}

// GET /identity/kernel/:companion_id
export async function getKernel(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isKernelId(companion_id)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_KERNEL_IDS.join(", ")}` }, 400);
  }

  try {
    const row = await getActiveKernel(env, companion_id);
    if (!row) return json({ error: "No active kernel for this companion" }, 404);
    return json({ kernel: row });
  } catch (err) {
    console.error("[identity/kernel] read error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /identity/kernel/:companion_id/bundle
// shared doctrine + companion kernel, paste-ready / boot-ready.
export async function getKernelBundle(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isKernelId(companion_id) || companion_id === "shared") {
    return json({ error: "Invalid companion_id: must be one of cypher, drevan, gaia" }, 400);
  }

  try {
    const [shared, own] = await Promise.all([
      getActiveKernel(env, "shared"),
      getActiveKernel(env, companion_id),
    ]);
    if (!own) return json({ error: "No active kernel for this companion" }, 404);

    const bundle = shared
      ? `${shared.kernel_md}\n\n---\n\n${own.kernel_md}`
      : own.kernel_md;

    return json({
      bundle,
      checksum: await sha256Hex(bundle),
      versions: { shared: shared?.version ?? null, companion: own.version },
    });
  } catch (err) {
    console.error("[identity/kernel/bundle] error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /identity/kernel
// body: { companion_id, kernel_md, vows?: string[], source_note? }
// Deactivates prior versions, inserts version = max+1.
export async function postKernel(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; kernel_md?: string; vows?: unknown; source_note?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const companionId = body.companion_id ?? "";
  if (!isKernelId(companionId)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_KERNEL_IDS.join(", ")}` }, 400);
  }
  const kernelMd = typeof body.kernel_md === "string" ? body.kernel_md : "";
  if (kernelMd.length < MIN_KERNEL_LENGTH) {
    return json({ error: `kernel_md too short (min ${MIN_KERNEL_LENGTH} chars) -- refusing blank/truncated upload` }, 400);
  }
  const vowsJson = Array.isArray(body.vows) && body.vows.every(v => typeof v === "string")
    ? JSON.stringify(body.vows)
    : null;
  const sourceNote = typeof body.source_note === "string" ? body.source_note.slice(0, 300) : null;

  try {
    const checksum = await sha256Hex(kernelMd);

    // Idempotency: same content as current active version is a no-op.
    const current = await getActiveKernel(env, companionId);
    if (current && current.checksum === checksum) {
      return json({ id: current.id, version: current.version, checksum, unchanged: true });
    }

    const maxRow = await env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) AS v FROM identity_kernel WHERE companion_id = ?"
    ).bind(companionId).first<{ v: number }>();
    const version = (maxRow?.v ?? 0) + 1;
    const id = `kern_${crypto.randomUUID()}`;

    // D1 batch is not a transaction, but order makes partial failure safe:
    // deactivate first, insert second -- a failure between leaves no active row,
    // and the next POST repairs it. Never two actives.
    await env.DB.prepare(
      "UPDATE identity_kernel SET active = 0 WHERE companion_id = ? AND active = 1"
    ).bind(companionId).run();
    await env.DB.prepare(
      `INSERT INTO identity_kernel (id, companion_id, version, kernel_md, vows_json, checksum, source_note, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(id, companionId, version, kernelMd, vowsJson, checksum, sourceNote).run();

    return json({ id, version, checksum });
  } catch (err) {
    console.error("[identity/kernel] write error", { companion_id: companionId, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
