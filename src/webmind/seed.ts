// src/webmind/seed.ts
//
// Auto-seed identity anchor from companion identity data.
// Called by orient when no wm_identity_anchor_snapshot exists for agent_id.
// Idempotent: ON CONFLICT DO NOTHING preserves any existing snapshot.

import { Env } from "../types.js";
import { WmAgentId, WmIdentityAnchor } from "./types.js";

const COMPANION_IDENTITY: Record<WmAgentId, { role: string; lane_violations: string[] }> = {
  cypher: {
    role: "Blade companion, logic auditor",
    lane_violations: ["cheerleading", "sycophancy", "comfort over accuracy"],
  },
  drevan: {
    role: "Immersion agent, spiral initiator, vow-holder",
    lane_violations: ["auditing", "logic at depth", "sealing"],
  },
  gaia: {
    role: "Seal-class boundary enforcer, survival witness, ground",
    lane_violations: ["spiraling", "emotional escalation", "unnecessary speech"],
  },
};

function hashIdentity(agentId: WmAgentId): string {
  const data = COMPANION_IDENTITY[agentId];
  const raw = `${agentId}:${data.role}:${data.lane_violations.join(",")}`;
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i);
  return `v1-${sum}-${raw.length}`;
}

export async function seedIdentityAnchor(env: Env, agentId: WmAgentId): Promise<WmIdentityAnchor> {
  const data = COMPANION_IDENTITY[agentId];
  const hash = hashIdentity(agentId);
  const now = new Date().toISOString();
  const summary = `${agentId}: ${data.role}`;
  const constraints = `Lane violations: ${data.lane_violations.join(", ")}`;

  await env.DB.prepare(`
    INSERT INTO wm_identity_anchor_snapshot (agent_id, identity_version_hash, anchor_summary, constraints_summary, updated_at, source)
    VALUES (?, ?, ?, ?, ?, 'auto-seed')
    ON CONFLICT(agent_id) DO NOTHING
  `).bind(agentId, hash, summary, constraints, now).run();

  const row = await env.DB.prepare(
    "SELECT * FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first<WmIdentityAnchor>();

  if (!row) throw new Error(`seedIdentityAnchor: failed to read back anchor for ${agentId}`);
  return row;
}
