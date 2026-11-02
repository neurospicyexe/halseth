// Off-VPS dead-man's switch (plan item 0.5). See migrations/0145_deadman_heartbeat.sql.
//
// The signal is the VPS kick-script's own POST to /admin/run-scheduled (every minute). The detector
// is called ONLY from the native Cloudflare `scheduled()` handler, never from runScheduledWork:
// that function is also what the kick drives, so a check riding it would die with the VPS.
// Alerting goes straight to the Telegram Bot API from the Worker; nothing here touches the VPS.
//
// One alert per outage: the ok -> alerting transition is claimed with a compare-and-set UPDATE
// (meta.changes === 1), so overlapping ticks cannot double-send. If the send fails the claim is
// rolled back and the next tick retries. Recovery is symmetric, with hysteresis (must be seen
// within RECOVER_WITHIN_MS) so a flapping box does not spam.

import type { Env } from "./types.js";

export const KICK_SOURCE = "kick";
export const DEFAULT_STALE_MINUTES = 30;
const RECOVER_WITHIN_MS = 5 * 60_000;

/** Stamp the kick heartbeat. Best effort: never breaks the run-scheduled door. */
export async function recordKickHeartbeat(env: Env, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO deadman_heartbeats (source, last_seen_at) VALUES (?, ?)
       ON CONFLICT(source) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).bind(KICK_SOURCE, now).run();
  } catch (e) {
    console.error("[deadman] heartbeat write failed:", String(e));
  }
}

async function sendTelegram(env: Env, text: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${env.DEADMAN_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.DEADMAN_TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) console.error(`[deadman] telegram send returned ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error("[deadman] telegram send failed:", String(e));
    return false;
  }
}

function fmtMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 120 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function staleThresholdMs(env: Env): number {
  const n = Number(env.DEADMAN_STALE_MINUTES);
  return (Number.isFinite(n) && n >= 5 ? n : DEFAULT_STALE_MINUTES) * 60_000;
}

export type DeadmanResult = "disabled" | "no-heartbeat" | "ok" | "alerted" | "alert-failed" | "recovered" | "recover-failed" | "still-alerting";

/** The detector. Call from the native scheduled() handler only. Never throws. */
export async function runDeadmanCheck(env: Env, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<DeadmanResult> {
  try {
    if (!env.DEADMAN_TELEGRAM_BOT_TOKEN || !env.DEADMAN_TELEGRAM_CHAT_ID) return "disabled";
    const row = await env.DB.prepare(
      "SELECT last_seen_at, alert_state, alerted_at FROM deadman_heartbeats WHERE source = ?"
    ).bind(KICK_SOURCE).first<{ last_seen_at: number; alert_state: string; alerted_at: number | null }>();
    if (!row) return "no-heartbeat";

    const age = now - row.last_seen_at;
    const stale = age >= staleThresholdMs(env);

    if (stale && row.alert_state === "ok") {
      const claim = await env.DB.prepare(
        "UPDATE deadman_heartbeats SET alert_state = 'alerting', alerted_at = ? WHERE source = ? AND alert_state = 'ok'"
      ).bind(now, KICK_SOURCE).run();
      if ((claim.meta?.changes ?? 0) !== 1) return "still-alerting"; // another tick won the claim
      const sent = await sendTelegram(env,
        `VPS SILENT: the Halseth kick has not checked in for ${fmtMinutes(age)} ` +
        `(last seen ${new Date(row.last_seen_at).toISOString()}). Bots, worker and health-check ` +
        `are unobserved. Sent by the Cloudflare-side dead-man's switch.`, fetchFn);
      if (!sent) {
        await env.DB.prepare(
          "UPDATE deadman_heartbeats SET alert_state = 'ok', alerted_at = NULL WHERE source = ? AND alert_state = 'alerting'"
        ).bind(KICK_SOURCE).run();
        return "alert-failed";
      }
      return "alerted";
    }

    if (row.alert_state === "alerting") {
      if (age >= RECOVER_WITHIN_MS) return "still-alerting";
      const claim = await env.DB.prepare(
        "UPDATE deadman_heartbeats SET alert_state = 'ok' WHERE source = ? AND alert_state = 'alerting'"
      ).bind(KICK_SOURCE).run();
      if ((claim.meta?.changes ?? 0) !== 1) return "ok";
      const outage = row.alerted_at ? fmtMinutes(now - row.alerted_at) : "unknown length";
      const sent = await sendTelegram(env,
        `VPS BACK: the Halseth kick is checking in again (alert was open ${outage}).`, fetchFn);
      if (!sent) {
        await env.DB.prepare(
          "UPDATE deadman_heartbeats SET alert_state = 'alerting' WHERE source = ? AND alert_state = 'ok'"
        ).bind(KICK_SOURCE).run();
        return "recover-failed";
      }
      return "recovered";
    }
    return "ok";
  } catch (e) {
    console.error("[deadman] check failed:", String(e));
    return "ok";
  }
}
