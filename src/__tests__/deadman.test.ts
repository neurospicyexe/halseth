// Off-VPS dead-man's switch: one alert per outage, one recovery, claim-based idempotency,
// fail-soft, and the structural rule that the detector rides native cron only.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDeadmanCheck, recordKickHeartbeat } from "../deadman.js";

type Row = { last_seen_at: number; alert_state: string; alerted_at: number | null };

function makeEnv(row: Row | null, extra: Record<string, string> = {}) {
  const state = { row };
  const env: any = {
    DEADMAN_TELEGRAM_BOT_TOKEN: "tok", DEADMAN_TELEGRAM_CHAT_ID: "42", ...extra,
    DB: {
      prepare: (sql: string) => ({
        bind: (...b: any[]) => ({
          first: async () => (state.row ? { ...state.row } : null),
          run: async () => {
            if (sql.startsWith("INSERT")) { state.row = { last_seen_at: b[1], alert_state: state.row?.alert_state ?? "ok", alerted_at: state.row?.alerted_at ?? null }; return { meta: { changes: 1 } }; }
            const m = sql.match(/alert_state = '(\w+)'.*AND alert_state = '(\w+)'/);
            if (m && state.row && state.row.alert_state === m[2]) {
              state.row.alert_state = m[1]!;
              state.row.alerted_at = m[1] === "alerting" ? b[0] : null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        }),
      }),
    },
  };
  return { env, state };
}
const okFetch = () => { const calls: any[] = []; const f: any = async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }; return { f, calls }; };
const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe("runDeadmanCheck", () => {
  it("is disabled without both secrets", async () => {
    const { env } = makeEnv({ last_seen_at: NOW - 999 * MIN, alert_state: "ok", alerted_at: null }, { DEADMAN_TELEGRAM_CHAT_ID: "" });
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW, f)).toBe("disabled");
    expect(calls).toHaveLength(0);
  });
  it("stays quiet before the first heartbeat ever lands", async () => {
    const { env } = makeEnv(null);
    expect(await runDeadmanCheck(env, NOW, okFetch().f)).toBe("no-heartbeat");
  });
  it("fresh heartbeat: no alert", async () => {
    const { env } = makeEnv({ last_seen_at: NOW - 2 * MIN, alert_state: "ok", alerted_at: null });
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW, f)).toBe("ok");
    expect(calls).toHaveLength(0);
  });
  it("stale: alerts exactly once across repeated ticks", async () => {
    const { env, state } = makeEnv({ last_seen_at: NOW - 45 * MIN, alert_state: "ok", alerted_at: null });
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW, f)).toBe("alerted");
    expect(await runDeadmanCheck(env, NOW + MIN, f)).toBe("still-alerting");
    expect(await runDeadmanCheck(env, NOW + 2 * MIN, f)).toBe("still-alerting");
    expect(calls).toHaveLength(1);
    expect(calls[0].chat_id).toBe("42");
    expect(calls[0].text).toContain("VPS SILENT");
    expect(state.row!.alert_state).toBe("alerting");
  });
  it("below the threshold does not alert; custom threshold honoured", async () => {
    const a = makeEnv({ last_seen_at: NOW - 20 * MIN, alert_state: "ok", alerted_at: null });
    expect(await runDeadmanCheck(a.env, NOW, okFetch().f)).toBe("ok");
    const b = makeEnv({ last_seen_at: NOW - 20 * MIN, alert_state: "ok", alerted_at: null }, { DEADMAN_STALE_MINUTES: "10" });
    expect(await runDeadmanCheck(b.env, NOW, okFetch().f)).toBe("alerted");
  });
  it("a failed send rolls the claim back so the next tick retries", async () => {
    const { env, state } = makeEnv({ last_seen_at: NOW - 45 * MIN, alert_state: "ok", alerted_at: null });
    const bad: any = async () => ({ ok: false, status: 500 });
    expect(await runDeadmanCheck(env, NOW, bad)).toBe("alert-failed");
    expect(state.row!.alert_state).toBe("ok");
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW + MIN, f)).toBe("alerted");
    expect(calls).toHaveLength(1);
  });
  it("a thrown fetch is also a rollback, never an exception", async () => {
    const { env, state } = makeEnv({ last_seen_at: NOW - 45 * MIN, alert_state: "ok", alerted_at: null });
    const boom: any = async () => { throw new Error("net"); };
    expect(await runDeadmanCheck(env, NOW, boom)).toBe("alert-failed");
    expect(state.row!.alert_state).toBe("ok");
  });
  it("recovery: one message when the heartbeat returns, then silent", async () => {
    const { env, state } = makeEnv({ last_seen_at: NOW - 1 * MIN, alert_state: "alerting", alerted_at: NOW - 50 * MIN });
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW, f)).toBe("recovered");
    expect(await runDeadmanCheck(env, NOW + MIN, f)).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("VPS BACK");
    expect(calls[0].text).toContain("50m");
    expect(state.row!.alert_state).toBe("ok");
  });
  it("hysteresis: a stale-ish heartbeat during an outage is not a recovery", async () => {
    const { env } = makeEnv({ last_seen_at: NOW - 10 * MIN, alert_state: "alerting", alerted_at: NOW - 50 * MIN });
    const { f, calls } = okFetch();
    expect(await runDeadmanCheck(env, NOW, f)).toBe("still-alerting");
    expect(calls).toHaveLength(0);
  });
  it("a missing table / DB error never throws", async () => {
    const env: any = { DEADMAN_TELEGRAM_BOT_TOKEN: "t", DEADMAN_TELEGRAM_CHAT_ID: "1", DB: { prepare: () => { throw new Error("no such table"); } } };
    await expect(runDeadmanCheck(env, NOW, okFetch().f)).resolves.toBe("ok");
  });
});

describe("recordKickHeartbeat", () => {
  it("upserts the kick timestamp and swallows errors", async () => {
    const { env, state } = makeEnv(null);
    await recordKickHeartbeat(env, NOW);
    expect(state.row!.last_seen_at).toBe(NOW);
    await expect(recordKickHeartbeat({ DB: { prepare: () => { throw new Error("x"); } } } as any, NOW)).resolves.toBeUndefined();
  });
});

describe("wiring (the failure domain is the whole point)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
  it("the detector is called from scheduled() and NOT from runScheduledWork", () => {
    const rsw = src.slice(src.indexOf("export async function runScheduledWork"), src.indexOf("export default {"));
    expect(rsw).not.toContain("runDeadmanCheck");
    const sched = src.slice(src.indexOf("async scheduled("));
    expect(sched).toContain("runDeadmanCheck(env)");
  });
  it("only the run-scheduled door stamps the heartbeat", () => {
    expect(src.match(/recordKickHeartbeat\(env\)/g)).toHaveLength(1);
    const door = src.slice(src.indexOf('"/admin/run-scheduled"'), src.indexOf('"/admin/edges"'));
    expect(door).toContain("recordKickHeartbeat(env)");
  });
});
