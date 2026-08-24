// Question/context caps (2026-08-23).
//
// Raziel, reading /questions: "several of them are cut off and I cant get the full context of it."
// Nothing on that page truncates -- no clamp, no slice. The text was STORED clipped, silently, by
// two caps: the question at 600 chars (2 live rows sit on exactly 600) and the prompting seed
// context at 200 (23 rows, several cut mid-word). A cap you can reach without being told is
// indistinguishable from the writer trailing off mid-thought.
//
// The caps stay -- a runaway run must not write a novel into the queue -- but they are now generous
// enough that real text never reaches one, and reaching one LOGS. The upstream writer
// (nullsafe-discord phases/reflect.ts) clips to the same numbers; both sides move together or the
// raise lands on one writer and the text is re-clipped by the other.

import { describe, it, expect, vi, afterEach } from "vitest";
import { postQuestion } from "../handlers/companion-questions.js";
import type { Env } from "../types.js";

const ADMIN_SECRET = "test-admin-secret";

interface Insert { question: string; context: string | null }

function makeEnv(): { env: Env; inserts: Insert[] } {
  const inserts: Insert[] = [];
  function stmtFor(sql: string, bound: unknown[] = []): unknown {
    const stmt = {
      bind: (...args: unknown[]) => stmtFor(sql, args),
      async first() {
        if (sql.includes("COUNT(*)")) return { n: 0 };   // under the open-question cap
        return null;                                      // no dedup hit
      },
      async run() {
        if (sql.startsWith("INSERT")) {
          const [, , question, context] = bound as [string, string, string, string | null];
          inserts.push({ question, context });
        }
        return { meta: { changes: 1 } };
      },
      async all() { return { results: [] }; },
    };
    return stmt;
  }
  return { env: { DB: { prepare: (sql: string) => stmtFor(sql) }, ADMIN_SECRET } as unknown as Env, inserts };
}

function ask(env: Env, body: Record<string, unknown>): Promise<Response> {
  return postQuestion(
    new Request("https://x/mind/questions", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe("POST /mind/questions -- caps", () => {
  it("stores a 900-char question whole, which the old 600 cap cut mid-sentence", async () => {
    const { env, inserts } = makeEnv();
    const question = "q".repeat(900);
    const res = await ask(env, { companion_id: "cypher", question });
    expect(res.status).toBe(201);
    expect(inserts[0]!.question.length).toBe(900);
  });

  it("stores a 495-char context whole -- the longest seed in prod, formerly clipped to 200", async () => {
    const { env, inserts } = makeEnv();
    const context = "c".repeat(495);
    await ask(env, { companion_id: "gaia", question: "a real question here", context });
    expect(inserts[0]!.context).toBe(context);
  });

  it("still clips a runaway question, and SAYS SO -- a silent clip is the actual defect", async () => {
    const { env, inserts } = makeEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ask(env, { companion_id: "drevan", question: "q".repeat(5000) });
    expect(inserts[0]!.question.length).toBe(1200);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(" ") + JSON.stringify(warn.mock.calls[0]![1]);
    expect(line).toContain("CLIPPED");
    expect(line).toContain("5000");   // the real length has to be in the log or it proves nothing
  });

  it("warns on a clipped CONTEXT too, not just a clipped question", async () => {
    const { env, inserts } = makeEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ask(env, { companion_id: "cypher", question: "short enough", context: "c".repeat(2500) });
    expect(inserts[0]!.context!.length).toBe(1000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when nothing was clipped", async () => {
    const { env } = makeEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ask(env, { companion_id: "gaia", question: "well within the cap", context: "so is this" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a null context null rather than coercing it to an empty string", async () => {
    const { env, inserts } = makeEnv();
    await ask(env, { companion_id: "cypher", question: "no context on this one" });
    expect(inserts[0]!.context).toBeNull();
  });
});
