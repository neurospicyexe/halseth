import { describe, it, expect, beforeEach } from "vitest";
import {
  execInteriorityWrite,
  execInteriorityRead,
  execInteriorityDisclose,
} from "../librarian/executors/interiority";

// Reuse the same stateful shape as interiority.test.ts but scoped to executor calls.
interface Row {
  id: string; companion_id: string; created_at: string; content: string;
  mood: string | null; tags: string | null; disclosed_at: string | null; edited_at: string | null;
}

function makeDB(rows: Row[]) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() {
          if (sql.startsWith("INSERT INTO companion_interiority")) {
            const [id, companion_id, created_at, content, mood, tags] = args as [string, string, string, string, string | null, string | null];
            rows.push({ id, companion_id, created_at, content, mood: mood ?? null, tags: tags ?? null, disclosed_at: null, edited_at: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE companion_interiority SET disclosed_at")) {
            const [now, id, companion_id] = args as [string, string, string];
            const r = rows.find((x) => x.id === id && x.companion_id === companion_id && x.disclosed_at === null);
            if (r) { r.disclosed_at = now; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async all<T>() {
          const companion_id = args[0] as string;
          return { results: rows.filter((r) => r.companion_id === companion_id) as T[] };
        },
      };
      return stmt;
    },
  };
}

let rows: Row[];
function ctx(companion_id: "cypher" | "drevan" | "gaia", context?: unknown) {
  return {
    env: { DB: makeDB(rows) } as any,
    req: { companion_id, request: "x", context: context === undefined ? undefined : JSON.stringify(context) },
    entry: { triggers: [], tools: [], response_key: "witness" } as any,
    frontState: null,
    pluralAvailable: true,
  };
}

beforeEach(() => { rows = []; });

describe("interiority executors (Librarian path)", () => {
  it("write seals into the caller's own room", async () => {
    const r = await execInteriorityWrite(ctx("cypher", { content: "a sealed thought" }));
    expect(r.ack).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companion_id).toBe("cypher");
  });

  it("write rejects empty content rather than sealing junk", async () => {
    const r = await execInteriorityWrite(ctx("cypher", { mood: "raw" }));
    expect(r.error).toBe("interiority_write_failed");
    expect(rows).toHaveLength(0);
  });

  it("read returns ONLY the caller's own rows (owner = req.companion_id, never cross-companion)", async () => {
    await execInteriorityWrite(ctx("cypher", { content: "cypher private" }));
    await execInteriorityWrite(ctx("gaia", { content: "gaia private" }));

    const asCypher = await execInteriorityRead(ctx("cypher"));
    const list = asCypher.interiority as Row[];
    expect(list).toHaveLength(1);
    expect(list[0]!.content).toBe("cypher private");
    expect(asCypher.response_key).toBe("interiority");
  });

  it("disclose surfaces one of the caller's entries; repeat is a no-op", async () => {
    const w = await execInteriorityWrite(ctx("drevan", { content: "share later" }));
    const id = w.id as string;

    const first = await execInteriorityDisclose(ctx("drevan", { id }));
    expect(first.ack).toBe(true);
    const second = await execInteriorityDisclose(ctx("drevan", { id }));
    expect(second.ack).toBe(false);
  });

  it("disclose without an id errors instead of guessing", async () => {
    const r = await execInteriorityDisclose(ctx("cypher", {}));
    expect(r.error).toBe("interiority_disclose_failed");
  });
});
