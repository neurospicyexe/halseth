// src/ledger/salt-consent.ts  (mig 0175, 2026-11-06)
//
// THE SECOND SIGNATURE ON HEX'S SALT. Drevan's rule 10 (note 5b5d3572): "Both signatures = sender's send plus
// receiver's standing opt-in or in-thread ask. No second signature, no salt." Machine-verified: the executor
// refuses a salt whose receiver has signed neither way, before anything is written.
//
//   (a) a STANDING opt-in the receiver authored, naming that sender:    "hex may salt me: cypher"
//       stored in companion_settings (receiver, 'hex_salt_optin') as a JSON list of sender ids; set and revoked
//       only from the receiver's OWN turn ("hex may not salt me: cypher"); read back with "who may salt me".
//   (b) a ONE-SHOT ask the receiver authored in-thread:                  "hex, salt me from cypher"
//       stored in companion_settings (receiver, 'hex_salt_ask:<sender>') as an ISO time; consumed by the next
//       matching send (a claim: one DELETE that must change one row) and expiring unconsumed at 72h. An
//       expired ask is deleted when next touched and leaves no count anywhere.
//   a SELF-salt (sender == receiver) needs neither: the sender is the receiver.
//
// GAIA (note 7f978971, rule 9 addition): "the ask covers that one errand and ends with it. It never becomes
// standing permission." So Gaia can NEVER hold an opt-in: setting one is refused with her words, and a stored
// one (should a row ever appear) is ignored at check time. Only her one-shot ask, or her own self-salt.
// Drevan's seed (scripts/seed-hex-optin-drevan-2026-11-06.sql) is the one standing opt-in on record.
//
// The signature is an AUTHORING act by the receiver, and the executor takes the receiver from the
// authenticated Librarian call (ctx.req.companion_id), never from the sentence. Nothing here touches the
// ledger or any Raziel-facing surface.

import type { Env } from "../types.js";
import { COMPANION_ID_SET } from "../companions.js";

export const SALT_OPTIN_KEY = "hex_salt_optin";
export const SALT_ASK_PREFIX = "hex_salt_ask:";
/** A one-shot ask is good for 72 hours, then it is as if it was never made. */
export const SALT_ASK_TTL_MS = 72 * 3_600_000;

/** Gaia's words, verbatim from note 7f978971 (the second sentence of her addition to rule 9). */
export const GAIA_NO_STANDING =
  "The ask covers that one errand and ends with it. It never becomes standing permission.";

export type SaltSignature = "self" | "ask" | "optin";

const askKey = (sender: string) => `${SALT_ASK_PREFIX}${sender}`;
const cutoffIso = (now: Date) => new Date(now.getTime() - SALT_ASK_TTL_MS).toISOString();

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && COMPANION_ID_SET.has(x)))] : [];
  } catch { return []; }
}

/** The senders `receiver` has opted in. Gaia's is always empty (she can never hold a standing opt-in). */
export async function getOptins(env: Env, receiver: string): Promise<string[]> {
  if (receiver === "gaia") return [];
  const r = await env.DB.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
    .bind(receiver, SALT_OPTIN_KEY).first<{ value: string }>();
  return parseList(r?.value);
}

export type OptinResult =
  | { ok: true; senders: string[]; changed: boolean }
  | { ok: false; reason: "gaia_no_standing" | "self" | "not_companion" };

/** The receiver sets (on) or revokes (off) a standing opt-in naming `sender`. Called from the receiver's own turn. */
export async function setOptin(env: Env, receiver: string, sender: string, on: boolean): Promise<OptinResult> {
  if (!COMPANION_ID_SET.has(sender)) return { ok: false, reason: "not_companion" };
  if (receiver === "gaia" && on) return { ok: false, reason: "gaia_no_standing" };
  if (sender === receiver) return { ok: false, reason: "self" };
  const before = await getOptins(env, receiver);
  const has = before.includes(sender);
  if (on === has) return { ok: true, senders: before, changed: false };
  const after = on ? [...before, sender] : before.filter((s) => s !== sender);
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).bind(receiver, SALT_OPTIN_KEY, JSON.stringify(after)).run();
  return { ok: true, senders: after, changed: true };
}

/** Delete this receiver's expired one-shot asks (unconsumed past 72h): no trace is kept. */
async function purgeExpiredAsks(env: Env, receiver: string, now: Date): Promise<void> {
  await env.DB.prepare("DELETE FROM companion_settings WHERE companion_id = ? AND key LIKE ? AND value <= ?")
    .bind(receiver, `${SALT_ASK_PREFIX}%`, cutoffIso(now)).run();
}

/** The receiver asks, in-thread, for ONE salt from `sender`. A second ask before the first is used renews it (still one). */
export async function recordAsk(env: Env, receiver: string, sender: string, now: Date = new Date()): Promise<void> {
  await purgeExpiredAsks(env, receiver, now);
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).bind(receiver, askKey(sender), now.toISOString()).run();
}

/** Is there a live (unconsumed, under 72h) one-shot ask from `receiver` for `sender`? */
export async function hasLiveAsk(env: Env, receiver: string, sender: string, now: Date = new Date()): Promise<boolean> {
  await purgeExpiredAsks(env, receiver, now);
  const r = await env.DB.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
    .bind(receiver, askKey(sender)).first<{ value: string }>();
  return !!r && r.value > cutoffIso(now);
}

/** Consume the ask: one guarded DELETE that must change one row (a race loses). Returns the ask's time or null. */
export async function claimAsk(env: Env, receiver: string, sender: string, now: Date = new Date()): Promise<string | null> {
  await purgeExpiredAsks(env, receiver, now);
  const r = await env.DB.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
    .bind(receiver, askKey(sender)).first<{ value: string }>();
  if (!r || !(r.value > cutoffIso(now))) return null;
  const d = await env.DB.prepare("DELETE FROM companion_settings WHERE companion_id = ? AND key = ? AND value = ?")
    .bind(receiver, askKey(sender), r.value).run();
  return (d.meta?.changes ?? 0) === 1 ? r.value : null;
}

/** Put a claimed ask back (the salt it was claimed for failed to write): same time, so it still expires on schedule. */
export async function restoreAsk(env: Env, receiver: string, sender: string, at: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO NOTHING`,
  ).bind(receiver, askKey(sender), at).run();
}

/**
 * Which second signature (if any) covers a send from `sender` to `receiver`. Order: a self-salt; then a live
 * one-shot ask (it is the receiver's more specific word, and it is consumed); then a standing opt-in. Gaia never
 * has the third. Read-only: the caller claims the ask only when it will write.
 */
export async function signatureFor(env: Env, sender: string, receiver: string, now: Date = new Date()): Promise<SaltSignature | null> {
  if (sender === receiver) return "self";
  if (await hasLiveAsk(env, receiver, sender, now)) return "ask";
  if ((await getOptins(env, receiver)).includes(sender)) return "optin";
  return null;
}
