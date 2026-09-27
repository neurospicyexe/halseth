// src/lib/upload-ticket.ts
//
// Short-lived upload tickets for the Library (2026-09-27). Hearth's library upload used to
// ride a Vercel function, and Vercel caps a function's request body at ~4.5 MB (not
// raisable), so any real book died before Halseth saw it. Now Hearth asks Halseth for a
// ticket (admin-gated, server to server) and the browser PUTs the file straight here with
// the ticket as its only credential. The browser never holds a Halseth secret.
//
//   ticket = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, UPLOAD_TICKET_SECRET))
//   payload = { exp: epoch seconds, max_bytes, nonce }
//
// Signed with its own secret, NOT ADMIN_SECRET: a leaked ticket key must not also be the
// admin key. No secret configured = every mint and every verify fails closed.
//
// Single use: the nonce is burned in LIBRARIAN_KV on first use. KV is eventually
// consistent, so two PUTs with the same ticket racing through different colos inside a
// few seconds could both pass. Accepted: the ticket still expires in 10 minutes and only
// grants a book write, which the 409 duplicate check then sees.

import type { Env } from "../types.js";
import { safeEqual } from "./auth.js";

export const TICKET_TTL_SECONDS = 600;
// Cloudflare refuses request bodies over 100 MB before the Worker runs; stay under it.
export const TICKET_MAX_BYTES = 100_000_000;
const NONCE_PREFIX = "upload-ticket:used:";

export interface TicketPayload {
  exp: number;
  max_bytes: number;
  nonce: string;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

export async function mintUploadTicket(
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ ticket: string; payload: TicketPayload } | null> {
  if (!env.UPLOAD_TICKET_SECRET) return null;
  const payload: TicketPayload = {
    exp: Math.floor(nowMs / 1000) + TICKET_TTL_SECONDS,
    max_bytes: TICKET_MAX_BYTES,
    nonce: crypto.randomUUID(),
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return { ticket: `${body}.${await sign(env.UPLOAD_TICKET_SECRET, body)}`, payload };
}

export type TicketCheck =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: "not_configured" | "missing" | "malformed" | "bad_signature" | "expired" | "used" };

// Signature and expiry only; burning the nonce is a separate step so a request that is
// refused for another reason (413, bad origin) does not spend the ticket.
export async function verifyUploadTicket(
  env: Env,
  ticket: string | null,
  nowMs: number = Date.now(),
): Promise<TicketCheck> {
  if (!env.UPLOAD_TICKET_SECRET) return { ok: false, reason: "not_configured" };
  if (!ticket) return { ok: false, reason: "missing" };
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  if (!safeEqual(sig, await sign(env.UPLOAD_TICKET_SECRET, body))) {
    return { ok: false, reason: "bad_signature" };
  }
  const raw = fromB64url(body);
  if (!raw) return { ok: false, reason: "malformed" };
  let payload: TicketPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as TicketPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.max_bytes) || typeof payload.nonce !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(nowMs / 1000) >= payload.exp) return { ok: false, reason: "expired" };
  if (await env.LIBRARIAN_KV.get(NONCE_PREFIX + payload.nonce)) return { ok: false, reason: "used" };
  return { ok: true, payload };
}

export async function burnUploadTicket(env: Env, payload: TicketPayload): Promise<void> {
  // KV's minimum TTL is 60s; outlive the ticket itself so a burned nonce can't come back.
  await env.LIBRARIAN_KV.put(NONCE_PREFIX + payload.nonce, "1", {
    expirationTtl: TICKET_TTL_SECONDS + 120,
  });
}
