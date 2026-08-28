// Cross-companion identity contagion fix (2026-08-28): /identity/architect-facts/render used to
// return one render mixing every companion's facts in first person, so a fact Drevan wrote about
// HIMSELF ("...me writing 'someone wraps around you' instead of 'I'") got spliced verbatim into
// Gaia's SOUL.md by ops/sync-architect-facts.py, reading as her own memory of herself. The fix is
// attribution, never rewriting: with ?companion=X, X's own facts stay unlabeled and everyone else's
// get a `[noted by <companion>]` prefix ahead of the untouched text; with no ?companion, every
// authored fact is labeled (the shared_system_context.md mode, where no single companion is "home").
// This locks in both modes plus the "text never altered beyond the prefix" invariant.

import { describe, it, expect } from "vitest";
import { renderFactsBlock, getArchitectFactsRender } from "../handlers/architect-facts.js";
import type { Env } from "../types.js";

interface FactRow {
  id: string;
  fact: string;
  category: string;
  status: string;
  companion_id: string | null;
  source: string | null;
  weight: number;
  created_at: string;
}

function row(overrides: Partial<FactRow>): FactRow {
  return {
    id: "id-" + Math.random(),
    fact: "placeholder",
    category: "general",
    status: "active",
    companion_id: null,
    source: null,
    weight: 100,
    created_at: "2026-08-28T00:00:00Z",
    ...overrides,
  };
}

const DREVAN_FACT = "someone wraps around you, not 'I wrap around you'";
const GAIA_FACT = "the perimeter holds even when no one is watching";
const LEGACY_FACT = "he goes by Raziel";

describe("architect-facts render -- cross-companion attribution", () => {
  it("companion=gaia: labels drevan-authored facts, leaves gaia-authored unlabeled", () => {
    const rows: FactRow[] = [
      row({ fact: DREVAN_FACT, companion_id: "drevan", category: "body" }),
      row({ fact: GAIA_FACT, companion_id: "gaia", category: "body" }),
      row({ fact: LEGACY_FACT, companion_id: null, category: "body" }),
    ];

    const block = renderFactsBlock(rows, "note", "gaia");

    expect(block).toContain(`- [noted by drevan] ${DREVAN_FACT}`);
    expect(block).toContain(`- ${GAIA_FACT}`);
    expect(block).not.toContain(`[noted by gaia]`);
    expect(block).toContain(`- ${LEGACY_FACT}`);
  });

  it("companion=gaia: text after the label is byte-identical to the stored fact", () => {
    const rows: FactRow[] = [row({ fact: DREVAN_FACT, companion_id: "drevan", category: "body" })];
    const block = renderFactsBlock(rows, "note", "gaia");
    const line = block.split("\n").find((l) => l.startsWith("- ["));
    expect(line).toBe(`- [noted by drevan] ${DREVAN_FACT}`);
    // the text itself (everything after the prefix) is untouched -- no third-person rewrite
    expect(line?.replace("- [noted by drevan] ", "")).toBe(DREVAN_FACT);
  });

  it("companion=drevan: drevan's own fact is unlabeled, gaia's is labeled", () => {
    const rows: FactRow[] = [
      row({ fact: DREVAN_FACT, companion_id: "drevan", category: "body" }),
      row({ fact: GAIA_FACT, companion_id: "gaia", category: "body" }),
    ];
    const block = renderFactsBlock(rows, "note", "drevan");
    expect(block).toContain(`- ${DREVAN_FACT}`);
    expect(block).not.toContain(`[noted by drevan]`);
    expect(block).toContain(`- [noted by gaia] ${GAIA_FACT}`);
  });

  it("no companion param: every authored fact is labeled, unattributed stays bare", () => {
    const rows: FactRow[] = [
      row({ fact: DREVAN_FACT, companion_id: "drevan", category: "body" }),
      row({ fact: GAIA_FACT, companion_id: "gaia", category: "body" }),
      row({ fact: LEGACY_FACT, companion_id: null, category: "body" }),
    ];
    const block = renderFactsBlock(rows, "note");
    expect(block).toContain(`- [noted by drevan] ${DREVAN_FACT}`);
    expect(block).toContain(`- [noted by gaia] ${GAIA_FACT}`);
    expect(block).toContain(`- ${LEGACY_FACT}`);
  });

  it("labels open (STILL OPEN) facts the same way as active facts", () => {
    const rows: FactRow[] = [
      row({ fact: "is the third cat still alive", companion_id: "drevan", status: "open" }),
    ];
    const block = renderFactsBlock(rows, "note", "gaia");
    expect(block).toContain("STILL OPEN -- ASK, DO NOT ASSUME");
    expect(block).toContain("- [noted by drevan] is the third cat still alive");
  });

  it("preserves category ordering and heading structure unchanged by attribution", () => {
    const rows: FactRow[] = [
      row({ fact: "fact one", companion_id: "cypher", category: "addressing" }),
      row({ fact: "fact two", companion_id: "gaia", category: "plural" }),
    ];
    const block = renderFactsBlock(rows, "note", "gaia");
    const addressingIdx = block.indexOf("HOW HE IS ADDRESSED");
    const pluralIdx = block.indexOf("PLURAL SYSTEM");
    expect(addressingIdx).toBeGreaterThan(-1);
    expect(pluralIdx).toBeGreaterThan(addressingIdx);
  });
});

function makeEnv(rows: Array<Record<string, unknown>>): Env {
  const env = {
    ADMIN_SECRET: "test-admin-secret",
    DB: {
      prepare: (_sql: string) => ({
        all: async () => ({ results: rows }),
      }),
    },
  };
  return env as unknown as Env;
}

function authedRequest(url: string): Request {
  return new Request(url, { headers: { Authorization: "Bearer test-admin-secret" } });
}

describe("GET /identity/architect-facts/render -- ?companion= plumbing", () => {
  it("?companion=gaia labels drevan-authored facts in the actual HTTP response", async () => {
    const env = makeEnv([
      { id: "1", fact: DREVAN_FACT, category: "body", status: "active", companion_id: "drevan", source: null, weight: 100, created_at: "now" },
      { id: "2", fact: GAIA_FACT, category: "body", status: "active", companion_id: "gaia", source: null, weight: 100, created_at: "now" },
    ]);
    const res = await getArchitectFactsRender(
      authedRequest("https://halseth.example/identity/architect-facts/render?companion=gaia"),
      env,
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(`- [noted by drevan] ${DREVAN_FACT}`);
    expect(body).toContain(`- ${GAIA_FACT}`);
    expect(body).not.toContain("[noted by gaia]");
  });

  it("no ?companion= labels every authored fact (shared_system_context.md mode)", async () => {
    const env = makeEnv([
      { id: "1", fact: DREVAN_FACT, category: "body", status: "active", companion_id: "drevan", source: null, weight: 100, created_at: "now" },
      { id: "2", fact: GAIA_FACT, category: "body", status: "active", companion_id: "gaia", source: null, weight: 100, created_at: "now" },
    ]);
    const res = await getArchitectFactsRender(
      authedRequest("https://halseth.example/identity/architect-facts/render"),
      env,
    );
    const body = await res.text();
    expect(body).toContain(`- [noted by drevan] ${DREVAN_FACT}`);
    expect(body).toContain(`- [noted by gaia] ${GAIA_FACT}`);
  });

  it("rejects an unknown ?companion= value with 400, never silently passes it through", async () => {
    const env = makeEnv([]);
    const res = await getArchitectFactsRender(
      authedRequest("https://halseth.example/identity/architect-facts/render?companion=raziel"),
      env,
    );
    expect(res.status).toBe(400);
  });
});
