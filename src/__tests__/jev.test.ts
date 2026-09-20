import { describe, it, expect, vi } from "vitest";
import { validateJevInput, jevEval, JevInputError, JEV_MODEL } from "../lib/jev.js";
import { postJevEval } from "../handlers/jev.js";

const QUESTIONS = {
  worth: { type: "noul", instructions: "Worth remembering?" },
  kind: { type: "choice", instructions: "What kind?", criteria: { note: "an observation", none: "nothing" } },
  salience: { type: "score", instructions: "How salient?", criteria: ["trivial", "notable", "core"] },
} as const;

const ANSWERS = {
  worth: { type: "noul", noul: 0.81 },
  kind: { type: "choice", choice: "note", probabilities: { note: 0.7, none: 0.3 }, confidence: 0.7 },
  salience: { type: "score", score: 1.4, distribution: [0.2, 0.5, 0.3], confidence: 0.5 },
};

function fakeEnv(run: (...a: unknown[]) => Promise<unknown>) {
  return { ADMIN_SECRET: "tok", AI: { run } } as never;
}
function req(body: unknown, auth = "Bearer tok"): Request {
  return new Request("https://h.example/admin/jev", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("validateJevInput", () => {
  it("accepts the three question types", () => {
    expect(() => validateJevInput("hello", QUESTIONS)).not.toThrow();
  });
  it("rejects empty state, empty questions, bad keys, bad types", () => {
    expect(() => validateJevInput("", QUESTIONS)).toThrow(JevInputError);
    expect(() => validateJevInput("x", {})).toThrow(JevInputError);
    expect(() => validateJevInput("x", { "bad key": QUESTIONS.worth })).toThrow(/identifier/);
    expect(() => validateJevInput("x", { q: { type: "essay", instructions: "write" } })).toThrow(/noul \| choice \| score/);
  });
  it("rejects a choice with one alternative and a score with one level", () => {
    expect(() => validateJevInput("x", { q: { type: "choice", instructions: "i", criteria: { only: "one" } } })).toThrow(/>= 2/);
    expect(() => validateJevInput("x", { q: { type: "score", instructions: "i", criteria: ["one"] } })).toThrow(/>= 2/);
  });
  it("rejects noul criteria that are not { true, false }", () => {
    expect(() => validateJevInput("x", { q: { type: "noul", instructions: "i", criteria: { yes: "a", no: "b" } } })).toThrow(/true, false/);
  });
});

describe("jevEval", () => {
  it("calls the binding with the model id and passes state+questions through", async () => {
    const run = vi.fn(async (..._a: unknown[]) => ({ model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 42 } }));
    const res = await jevEval(fakeEnv(run), "state text", QUESTIONS as never, { purpose: "test" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe(JEV_MODEL);
    expect(run.mock.calls[0]![1]).toEqual({ state: "state text", questions: QUESTIONS });
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.worth).toEqual({ type: "noul", noul: 0.81 });
    expect(res.usage).toEqual({ input_tokens: 42 });
    expect(typeof res.latency_ms).toBe("number");
  });
  it("rethrows the binding's error rather than defaulting -- the caller owns the fail posture", async () => {
    const run = vi.fn(async () => { throw new Error("upstream 503"); });
    await expect(jevEval(fakeEnv(run), "s", QUESTIONS as never)).rejects.toThrow("upstream 503");
  });
  it("warns but returns when the binding answers a subset of questions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => ({ answers: { worth: ANSWERS.worth } }));
    const res = await jevEval(fakeEnv(run), "s", QUESTIONS as never);
    expect(Object.keys(res.answers)).toEqual(["worth"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing=kind,salience"));
    warn.mockRestore();
  });
});

describe("POST /admin/jev", () => {
  it("401 without the admin bearer", async () => {
    const res = await postJevEval(req({ state: "s", questions: QUESTIONS }, "Bearer nope"), fakeEnv(async () => ANSWERS));
    expect(res.status).toBe(401);
  });
  it("503 when ADMIN_SECRET is unset", async () => {
    const res = await postJevEval(req({}), { AI: { run: async () => ({}) } } as never);
    expect(res.status).toBe(503);
  });
  it("400 on non-JSON and on malformed questions, with the reason", async () => {
    const env = fakeEnv(async () => ANSWERS);
    expect((await postJevEval(req("not json"), env)).status).toBe(400);
    const bad = await postJevEval(req({ state: "s", questions: { q: { type: "essay", instructions: "x" } } }), env);
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toMatch(/noul \| choice \| score/);
  });
  it("200 with answers, latency and usage on success", async () => {
    const env = fakeEnv(async () => ({ model: "jev-1.13.0", answers: ANSWERS, usage: { input_tokens: 10 } }));
    const res = await postJevEval(req({ state: "s", questions: QUESTIONS, purpose: "unit" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string; answers: typeof ANSWERS; latency_ms: number };
    expect(body.model).toBe("jev-1.13.0");
    expect(body.answers.kind.choice).toBe("note");
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
  });
  it("502 without leaking the binding's raw error text", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = fakeEnv(async () => { throw new Error("AiError: 3040 secret internal detail"); });
    const res = await postJevEval(req({ state: "s", questions: QUESTIONS }), env);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("3040");
    expect(text).not.toContain("secret internal detail");
    err.mockRestore();
  });
  it("?debug=1 echoes the error class and a clipped message (admin-gated route, so safe)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = fakeEnv(async () => { const e = new Error("2021: Insufficient AI Gateway credits"); e.name = "AiGatewayError"; throw e; });
    const r = new Request("https://h.example/admin/jev?debug=1", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({ state: "s", questions: QUESTIONS }),
    });
    const res = await postJevEval(r, env);
    expect(res.status).toBe(502);
    const body = await res.json() as { name: string; message: string };
    expect(body.name).toBe("AiGatewayError");
    expect(body.message).toContain("2021");
    err.mockRestore();
  });
});
