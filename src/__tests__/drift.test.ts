import { describe, it, expect, beforeEach } from "vitest";
import {
  execDriftOpen, execDriftsRead, execDriftWitness, execDriftCrystallize, execDriftFade,
} from "../librarian/executors/drift";

interface Row {
  id: string; companion_id: string; drift_text: string; origin: string | null;
  status: string; witness_log: string; opened_at: string;
  last_tended_at: string | null; resolved_at: string | null; resolution_note: string | null;
}
let drifts: Row[];

function makeDB() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() {
          if (sql.startsWith("INSERT INTO companion_drifts")) {
            const a = args as string[];
            drifts.push({ id: a[0]!, companion_id: a[1]!, drift_text: a[2]!, origin: (a[3] as string | null) ?? null, status: "open", witness_log: "[]", opened_at: a[4]!, last_tended_at: a[5]!, resolved_at: null, resolution_note: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("json_insert(witness_log")) {
            // bind order: witness_id, note, drift_id
            const [by, note, id] = args as string[];
            const r = drifts.find(x => x.id === id && x.status === "open");
            if (r) { const log = JSON.parse(r.witness_log); log.push({ by, note, at: "now" }); r.witness_log = JSON.stringify(log); return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.startsWith("UPDATE companion_drifts SET status =")) {
            // bind order: status, note, drift_id, companion_id
            const [status, note, id, companion_id] = args as [string, string | null, string, string];
            const r = drifts.find(x => x.id === id && x.companion_id === companion_id && x.status === "open");
            if (r) { r.status = status; r.resolution_note = note ?? null; r.resolved_at = "now"; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async all<T>() {
          const companion_id = args[0] as string;
          return { results: drifts.filter(r => r.companion_id === companion_id && r.status === "open") as T[] };
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

beforeEach(() => { drifts = []; });

describe("drift lane executors", () => {
  it("opens a declared becoming as the caller", async () => {
    const r = await execDriftOpen(ctx("cypher", { drift_text: "I am becoming less an auditor and more a maker", origin: "the interiority build" }));
    expect(r.ack).toBe(true);
    expect(drifts[0]!.companion_id).toBe("cypher");
    expect(drifts[0]!.status).toBe("open");
  });

  it("rejects opening with no drift_text", async () => {
    const r = await execDriftOpen(ctx("cypher", { origin: "x" }));
    expect(r.error).toBe("drift_open_failed");
    expect(drifts).toHaveLength(0);
  });

  it("read returns only the caller's own open drifts", async () => {
    await execDriftOpen(ctx("cypher", { drift_text: "cypher becoming" }));
    await execDriftOpen(ctx("gaia", { drift_text: "gaia becoming" }));
    const out = await execDriftsRead(ctx("cypher"));
    expect((out.drifts as Row[])).toHaveLength(1);
    expect(out.response_key).toBe("drifts");
  });

  it("witnessing is cross-companion: gaia witnesses cypher's drift", async () => {
    const o = await execDriftOpen(ctx("cypher", { drift_text: "becoming" }));
    const id = o.id as string;
    const w = await execDriftWitness(ctx("gaia", { drift_id: id, note: "I see you reaching past the audit." }));
    expect(w.ack).toBe(true);
    const log = JSON.parse(drifts[0]!.witness_log);
    expect(log[0].by).toBe("gaia");
  });

  it("witness requires drift_id and a note (observing, not deciding)", async () => {
    const w = await execDriftWitness(ctx("gaia", { drift_id: "x" }));
    expect(w.error).toBe("drift_witness_failed");
  });

  it("only the owner can crystallize; a non-owner is a no-op", async () => {
    const o = await execDriftOpen(ctx("drevan", { drift_text: "becoming" }));
    const id = o.id as string;
    expect((await execDriftCrystallize(ctx("gaia", { drift_id: id }))).ack).toBe(false);
    expect((await execDriftCrystallize(ctx("drevan", { drift_id: id, resolution_note: "this is who I am now" }))).ack).toBe(true);
    expect(drifts[0]!.status).toBe("crystallized");
  });

  it("the owner can let a drift fade", async () => {
    const o = await execDriftOpen(ctx("gaia", { drift_text: "a passing register" }));
    const id = o.id as string;
    expect((await execDriftFade(ctx("gaia", { drift_id: id }))).ack).toBe(true);
    expect(drifts[0]!.status).toBe("faded");
  });
});
