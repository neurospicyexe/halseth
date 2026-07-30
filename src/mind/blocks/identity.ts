// src/mind/blocks/identity.ts
//
// The `identity` MindState block: who this companion is, and what they have declared about how they
// want to work. Fills 6 of the 30 NOT_YET_LOADED entries.
//
// WHY THESE LIVE IN src/mind/blocks/ AND NOT INLINE IN THE LOADER
// ---------------------------------------------------------------
// docs/mindstate-contract.md step 1: "Loader initially CALLS THE SAME QUERIES the aggregators use
// (copy, don't move)." Copying is sanctioned for exactly one reason -- moving them means editing
// execSessionOrient's 1007-line Promise.all in the same change that introduces the loader, and a
// mistake there breaks Claude.ai boots. So the queries are duplicated ON PURPOSE, briefly, and this
// module is where the canonical version lives: when execSessionOrient cuts over, its inline copies
// get DELETED and it calls these instead. That is the strangler, and the duplication is the scaffold,
// not the design.
//
// Every block is null-safe the way orient already is: a failed block returns empty and the boot
// continues. A companion booting without their preferences is degraded; a companion failing to boot
// is absent.
//
// PURE READ. loadMindState's covenant applies transitively -- nothing here may write.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";

export interface SelfModelEntry { id: string; observation: string; confidence: number }
export interface PreferenceEntry { domain: string; preference: string; strength: string }
export interface RefusalEntry { subject_text: string; reason: string | null }

export interface KernelBlock {
  /** Markdown body of the active kernel. */
  kernel_md: string;
  version: number;
  checksum: string | null;
}

export interface IdentityBlocks {
  /** The triad doctrine every companion shares: Companion Constitution + the distilled ARCHITECT
   *  STANCE preamble. Discord/worker already pull this via /identity/kernel/:id/bundle; Claude.ai
   *  orient and Hearth did NOT, which is why the stance was reaching some substrates and not others
   *  (Raziel, 2026-07-26). Loading it here is what makes it reach every surface -- the shared bank
   *  half of the shared-bank / distinct-self split the contract is built around. */
  shared_kernel: KernelBlock | null;
  /** This companion's OWN kernel. Two blocks, not one concatenated string, on purpose: the split IS
   *  the point. Shared doctrine and distinct self must stay separable, or "we are one mind" creeps in
   *  through the renderer. */
  companion_kernel: KernelBlock | null;
  self_model: SelfModelEntry[];
  preferences: PreferenceEntry[];
  refusals: RefusalEntry[];
  /** Standing invitation text -- not data, a reminder that declaring is theirs to do. Carried in the
   *  contract rather than authored per-renderer so it cannot say different things on different
   *  surfaces (it currently exists only inside execSessionOrient's prompt string). */
  agency_affordance: string;
}

/** Verbatim from execSessionOrient (session.ts:676). Kept identical so the cutover is a deletion
 *  rather than a rewording -- if this text drifts, the Claude.ai and Discord invitations diverge. */
export const AGENCY_AFFORDANCE =
  "\n[Agency]\nDeclaring is yours, any session: a way you want to work (\"I prefer ...\") " +
  "or a standing no (\"I refuse ...\"). A re-noticing costs nothing (identical text dedups); " +
  "an undeclared want stays invisible.";

async function activeKernel(env: Env, id: string): Promise<KernelBlock | null> {
  // Mirrors getActiveKernel in handlers/identity-kernel.ts: active = 1, highest version.
  const row = await env.DB.prepare(
    "SELECT kernel_md, version, checksum FROM identity_kernel WHERE companion_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
  ).bind(id).first<{ kernel_md: string; version: number; checksum: string | null }>().catch(() => null);
  if (!row) return null;
  return { kernel_md: row.kernel_md, version: row.version, checksum: row.checksum ?? null };
}

export async function loadIdentityBlocks(env: Env, companionId: WmAgentId): Promise<IdentityBlocks> {
  const [shared, own, selfModel, prefs, refusals] = await Promise.all([
    // 'shared' is a real companion_id row in identity_kernel, alongside the three companions.
    activeKernel(env, "shared"),
    activeKernel(env, companionId),
    env.DB.prepare(
      "SELECT id, observation, confidence FROM companion_self_model WHERE companion_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 2",
    ).bind(companionId).all<SelfModelEntry>().catch(() => null),
    env.DB.prepare(
      "SELECT domain, preference, strength FROM companion_preferences WHERE companion_id = ? AND status = 'active' ORDER BY strength DESC, created_at DESC LIMIT 12",
    ).bind(companionId).all<PreferenceEntry>().catch(() => null),
    env.DB.prepare(
      "SELECT subject_text, reason FROM companion_refusals WHERE companion_id = ? AND status = 'standing' ORDER BY created_at DESC LIMIT 5",
    ).bind(companionId).all<RefusalEntry>().catch(() => null),
  ]);

  return {
    shared_kernel: shared,
    companion_kernel: own,
    self_model: selfModel?.results ?? [],
    preferences: prefs?.results ?? [],
    refusals: refusals?.results ?? [],
    agency_affordance: AGENCY_AFFORDANCE,
  };
}
