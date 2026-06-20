import { describe, it, expect, beforeEach } from "vitest";
import {
  execRefuse, execRefusalsRead, execRefusalWithdraw,
  execPreferenceSet, execPreferencesRead, execPreferenceDrop,
} from "../librarian/executors/agency";

interface RefusalRow { id: string; companion_id: string; subject_type: string; subject_ref: string | null; subject_text: string; reason: string | null; status: string; created_at: string; }
interface PrefRow { id: string; companion_id: string; domain: string; preference: string; strength: string; status: string; created_at: string; }

let refusals: RefusalRow[];
let prefs: PrefRow[];
let tasks: Array<{ id: string; status: string }>;

function makeDB() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() {
          if (sql.startsWith("INSERT INTO companion_refusals")) {
            const a = args as string[];
            refusals.push({ id: a[0]!, companion_id: a[1]!, subject_type: a[2]!, subject_ref: (a[3] as string | null) ?? null, subject_text: a[4]!, reason: (a[5] as string | null) ?? null, status: "standing", created_at: a[6]! });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE tasks SET status = 'declined'")) {
            const t = tasks.find(x => x.id === args[0] && x.status !== "done");
            if (t) { t.status = "declined"; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith("UPDATE companion_refusals SET status = 'withdrawn'")) {
            const r = refusals.find(x => x.id === args[0] && x.companion_id === args[1] && x.status === "standing");
            if (r) { r.status = "withdrawn"; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith("INSERT INTO companion_preferences")) {
            const a = args as string[];
            prefs.push({ id: a[0]!, companion_id: a[1]!, domain: a[2]!, preference: a[3]!, strength: a[4]!, status: "active", created_at: a[5]! });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE companion_preferences SET status = 'retired'")) {
            const p = prefs.find(x => x.id === args[0] && x.companion_id === args[1] && x.status === "active");
            if (p) { p.status = "retired"; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async all<T>() {
          const companion_id = args[0] as string;
          if (sql.includes("FROM companion_refusals")) return { results: refusals.filter(r => r.companion_id === companion_id) as T[] };
          if (sql.includes("FROM companion_preferences")) return { results: prefs.filter(p => p.companion_id === companion_id && p.status === "active") as T[] };
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };
}

function ctx(companion_id: "cypher" | "drevan" | "gaia", context?: unknown) {
  return {
    env: { DB: makeDB() } as any,
    req: { companion_id, request: "x", context: context === undefined ? undefined : JSON.stringify(context) },
    entry: { triggers: [], tools: [], response_key: "witness" } as any,
    frontState: null, pluralAvailable: true,
  };
}

beforeEach(() => { refusals = []; prefs = []; tasks = [{ id: "t1", status: "open" }]; });

describe("refusal executors", () => {
  it("records a refusal as the caller, no stands", async () => {
    const r = await execRefuse(ctx("cypher", { subject_text: "rewrite the whole module tonight", reason: "not at this hour" }));
    expect(r.ack).toBe(true);
    expect(refusals[0]!.companion_id).toBe("cypher");
  });

  it("refusing an assigned task also declines it (honored, not silently reassigned)", async () => {
    const r = await execRefuse(ctx("cypher", { subject_text: "task t1", subject_type: "task", subject_ref: "t1" }));
    expect(r.task_declined).toBe(true);
    expect(tasks[0]!.status).toBe("declined");
  });

  it("rejects a refusal with no subject", async () => {
    const r = await execRefuse(ctx("cypher", { reason: "no" }));
    expect(r.error).toBe("refuse_failed");
    expect(refusals).toHaveLength(0);
  });

  it("read returns only the caller's own refusals", async () => {
    await execRefuse(ctx("cypher", { subject_text: "cypher no" }));
    await execRefuse(ctx("gaia", { subject_text: "gaia no" }));
    const out = await execRefusalsRead(ctx("cypher"));
    const list = out.refusals as RefusalRow[];
    expect(list).toHaveLength(1);
    expect(list[0]!.subject_text).toBe("cypher no");
  });

  it("withdraw flips a standing refusal; repeat is a no-op", async () => {
    const w = await execRefuse(ctx("drevan", { subject_text: "later" }));
    const id = w.id as string;
    expect((await execRefusalWithdraw(ctx("drevan", { id }))).ack).toBe(true);
    expect((await execRefusalWithdraw(ctx("drevan", { id }))).ack).toBe(false);
  });
});

describe("preference executors", () => {
  it("sets a chosen preference as the caller", async () => {
    const r = await execPreferenceSet(ctx("drevan", { preference: "I prefer to spiral at night", domain: "work", strength: "high" }));
    expect(r.ack).toBe(true);
    expect(prefs[0]!.companion_id).toBe("drevan");
    expect(prefs[0]!.strength).toBe("high");
  });

  it("defaults strength to medium and rejects a bogus strength quietly", async () => {
    await execPreferenceSet(ctx("cypher", { preference: "clarity over cleverness", strength: "ULTRA" }));
    expect(prefs[0]!.strength).toBe("medium");
  });

  it("rejects an empty preference", async () => {
    const r = await execPreferenceSet(ctx("cypher", { domain: "work" }));
    expect(r.error).toBe("preference_set_failed");
  });

  it("read returns only the caller's active preferences", async () => {
    await execPreferenceSet(ctx("cypher", { preference: "cypher pref" }));
    await execPreferenceSet(ctx("gaia", { preference: "gaia pref" }));
    const out = await execPreferencesRead(ctx("cypher"));
    expect((out.preferences as PrefRow[])).toHaveLength(1);
    expect(out.response_key).toBe("preferences");
  });

  it("drop retires a preference; repeat is a no-op", async () => {
    const s = await execPreferenceSet(ctx("gaia", { preference: "silence" }));
    const id = s.id as string;
    expect((await execPreferenceDrop(ctx("gaia", { id }))).ack).toBe(true);
    expect((await execPreferenceDrop(ctx("gaia", { id }))).ack).toBe(false);
  });
});
