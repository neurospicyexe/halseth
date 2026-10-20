// src/__tests__/task-edit.test.ts
//
// 2026-10-19: a task could only change status. The Librarian's task update acked while dropping
// due_at, Hearth's PATCH validated status alone, and "change the due date of the task for X" fell
// through to task_add (found 10-14: three moved dates never landed). These pin the field-edit path.

import { describe, it, expect } from "vitest";
import { normalizeTaskEdits, pickTaskEdits } from "../lib/task-edit.js";
import { execTaskUpdateStatus } from "../librarian/executors/writes.js";
import { matchFastPath } from "../librarian/router.js";

interface Captured { sql: string[]; binds: unknown[][] }

function makeEnv(captured: Captured, changes = 1): any {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          captured.sql.push(sql);
          captured.binds.push(args);
          return {
            run: async () => ({ meta: { changes } }),
            first: async () => (sql.includes("FROM tasks") ? { id: "t1", status: "open", title: "Vireth samples" } : null),
            all: async () => ({ results: [] }),
          };
        },
      }),
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
  };
}

function ctx(env: any, context: Record<string, unknown>): any {
  return {
    env,
    req: { companion_id: "cypher", request: "Update task Vireth samples", context: JSON.stringify(context) },
    entry: { response_key: "witness" },
    frontState: null,
    pluralAvailable: false,
  };
}

describe("normalizeTaskEdits", () => {
  it("keeps a bare date as a day (no UTC shift) and normalizes an instant", () => {
    const a = normalizeTaskEdits({ due_at: "2026-10-21" });
    expect(a).toMatchObject({ binds: ["2026-10-21"], changed: ["due_at"] });
    const b = normalizeTaskEdits({ due_at: "2026-10-21T15:00:00-05:00" });
    expect(b).toMatchObject({ binds: ["2026-10-21T20:00:00.000Z"] });
  });

  it("null or empty clears the due date", () => {
    expect(normalizeTaskEdits({ due_at: null })).toMatchObject({ binds: [null] });
    expect(normalizeTaskEdits({ due_at: "" })).toMatchObject({ binds: [null] });
  });

  it("refuses a bad value instead of dropping it", () => {
    expect(normalizeTaskEdits({ due_at: "next blursday" })).toHaveProperty("error");
    expect(normalizeTaskEdits({ priority: "whenever" })).toHaveProperty("error");
    expect(normalizeTaskEdits({ title: "   " })).toHaveProperty("error");
  });

  it("pickTaskEdits ignores id/status and accepts `due` as an alias", () => {
    expect(pickTaskEdits({ id: "x", status: "done", due: "2026-10-21", priority: "high" }))
      .toEqual({ due_at: "2026-10-21", priority: "high" });
  });
});

describe("execTaskUpdateStatus -- field edits", () => {
  it("writes due_at (the 10-14 bug: acked and dropped it)", async () => {
    const c: Captured = { sql: [], binds: [] };
    const res = await execTaskUpdateStatus(ctx(makeEnv(c), { id: "t1", due_at: "2026-10-21" })) as any;
    expect(res.ack).toBe(true);
    expect(res.changed).toEqual(["due_at"]);
    const i = c.sql.findIndex(s => s.startsWith("UPDATE tasks SET due_at = ?"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(c.binds[i]![0]).toBe("2026-10-21");
    expect(c.binds[i]![2]).toBe("t1");
  });

  it("an unknown task id is reported, never acked", async () => {
    const c: Captured = { sql: [], binds: [] };
    const res = await execTaskUpdateStatus(ctx(makeEnv(c, 0), { id: "nope", due_at: "2026-10-21" })) as any;
    expect(res.ack).toBeUndefined();
    expect(res.witness).toContain("not found");
  });

  it("an id with no change asks for one instead of acking", async () => {
    const res = await execTaskUpdateStatus(ctx(makeEnv({ sql: [], binds: [] }), { id: "t1" })) as any;
    expect(res.ack).toBeUndefined();
    expect(res.witness).toContain("needs a change");
  });
});

describe("routing an edit", () => {
  it("edit verbs at the head reach the task update, not task_add", () => {
    expect(matchFastPath("Change the due date of the task for Vireth to 10/21")?.key).toBe("task_update_status");
    expect(matchFastPath("Reschedule task evac deck")?.key).toBe("task_update_status");
    expect(matchFastPath("Update task Vireth samples status in Halseth to done")?.key).toBe("task_update_status");
  });

  it("adding a task still adds", () => {
    expect(matchFastPath("Add task for Raziel: water the chickens")?.key).toBe("task_add");
    expect(matchFastPath("new task: call the vet")?.key).toBe("task_add");
  });
});
