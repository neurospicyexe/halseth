// src/__tests__/conclusions-worldview.test.ts
//
// Tests for worldview field validation (belief_type, confidence) in postConclusion handler.
// Validation fires before any DB access, so 400-path tests need no D1 stub.
// 201-path tests use a minimal stub that records the INSERT call.

import { describe, it, expect } from "vitest";
import { postConclusion } from "../handlers/conclusions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("https://test.local/companion-conclusions", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Minimal env that passes auth and satisfies the happy-path DB calls. */
function makeEnv(capturedInsert?: { values: unknown[] }): any {
  const stubStatement = {
    bind: (...args: unknown[]) => {
      if (capturedInsert) capturedInsert.values = args;
      return stubStatement;
    },
    run: async () => ({ meta: { changes: 1 } }),
    all: async () => ({ results: [] }),
  };
  return {
    ADMIN_SECRET: "test-secret",
    DB: {
      prepare: () => stubStatement,
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
  };
}

const BASE_BODY = {
  companion_id: "cypher",
  conclusion_text: "the architecture holds",
};

// ---------------------------------------------------------------------------
// belief_type validation
// ---------------------------------------------------------------------------

describe("postConclusion -- belief_type validation", () => {
  it("returns 400 for an unrecognised belief_type", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: "invalid_type" }), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("belief_type");
  });

  it("returns 400 for a numeric belief_type", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: 42 }), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("belief_type");
  });

  it("accepts belief_type 'self'", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: "self" }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("accepts belief_type 'observational'", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: "observational" }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("accepts belief_type 'relational'", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: "relational" }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("accepts belief_type 'systemic'", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, belief_type: "systemic" }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("applies default belief_type 'self' when field is absent", async () => {
    const captured: { values: unknown[] } = { values: [] };
    await postConclusion(makeRequest(BASE_BODY), makeEnv(captured));
    // belief_type is the 4th positional bind arg (id, companion_id, conclusion_text, belief_type, ...)
    // Confirm "self" appears somewhere in the bound values.
    expect(captured.values).toContain("self");
  });
});

// ---------------------------------------------------------------------------
// confidence validation
// ---------------------------------------------------------------------------

describe("postConclusion -- confidence validation", () => {
  it("returns 400 for confidence > 1.0", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: 1.5 }), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("confidence");
  });

  it("returns 400 for confidence < 0.0", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: -0.1 }), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("confidence");
  });

  it("returns 400 for confidence as a string", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: "high" }), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("confidence");
  });

  it("accepts confidence 0.0 (lower boundary)", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: 0.0 }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("accepts confidence 1.0 (upper boundary)", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: 1.0 }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("accepts confidence 0.85 (mid-range)", async () => {
    const res = await postConclusion(makeRequest({ ...BASE_BODY, confidence: 0.85 }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("applies default confidence 0.7 when field is absent", async () => {
    const captured: { values: unknown[] } = { values: [] };
    await postConclusion(makeRequest(BASE_BODY), makeEnv(captured));
    expect(captured.values).toContain(0.7);
  });
});

// ---------------------------------------------------------------------------
// Combined worldview fields
// ---------------------------------------------------------------------------

describe("postConclusion -- valid worldview fields accepted together", () => {
  it("accepts both belief_type and confidence when both are valid", async () => {
    const res = await postConclusion(
      makeRequest({ ...BASE_BODY, belief_type: "observational", confidence: 0.85 }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(typeof body.id).toBe("string");
  });
});
