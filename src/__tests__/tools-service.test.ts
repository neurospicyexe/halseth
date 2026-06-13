import { describe, it, expect, beforeEach } from "vitest";
import { runWebSearch, runImageGen } from "../tools/service.js";
import type { ToolProvider, SearchResult, GeneratedImage } from "../tools/providers.js";
import type { Env } from "../types.js";

// ── Minimal fakes (no real D1/R2) ─────────────────────────────────────────────

interface InsertCall { sql: string; bound: unknown[] }

class FakeDb {
  inserts: InsertCall[] = [];
  // gate value returned by the companion_settings SELECT; null = no row.
  gateValue: string | null = null;

  prepare(sql: string) {
    const self = this;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) { bound = args; return this; },
      async first<T>() {
        if (sql.includes("FROM companion_settings")) {
          return (self.gateValue === null ? null : { value: self.gateValue }) as T | null;
        }
        return null as T | null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO companion_tool_calls")) {
          self.inserts.push({ sql, bound });
        }
        return { meta: { changes: 1 } };
      },
      async all<T>() { return { results: [] as T[] }; },
    };
  }
}

class FakeBucket {
  puts: { key: string; size: number; contentType?: string }[] = [];
  async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
    this.puts.push({ key, size: value.byteLength, contentType: opts?.httpMetadata?.contentType });
    return {} as unknown;
  }
}

function makeEnv(db: FakeDb, bucket: FakeBucket, toolsDefault = "false"): Env {
  return {
    DB: db as unknown as Env["DB"],
    BUCKET: bucket as unknown as Env["BUCKET"],
    COMPANION_TOOLS_DEFAULT: toolsDefault,
    PUBLIC_BASE_URL: "https://halseth.test",
  } as unknown as Env;
}

const okSearch: SearchResult[] = [
  { title: "T", url: "https://t.test", snippet: "snip", score: 0.5 },
];
const okImage: GeneratedImage = { bytes: new Uint8Array([1, 2, 3, 4]).buffer, mimeType: "image/png", prompt: "a fox" };

function mockProvider(over: Partial<ToolProvider> = {}): ToolProvider {
  return {
    name: "mock",
    async webSearch() { return okSearch; },
    async generateImage() { return okImage; },
    ...over,
  };
}

let db: FakeDb;
let bucket: FakeBucket;
beforeEach(() => { db = new FakeDb(); bucket = new FakeBucket(); });

describe("runWebSearch", () => {
  it("denied when the gate is off (env default false, no setting): no provider call, denied row logged", async () => {
    let called = false;
    const provider = mockProvider({ async webSearch() { called = true; return okSearch; } });
    const res = await runWebSearch(makeEnv(db, bucket, "false"), "cypher", "rome weather", provider);
    expect(res).toMatchObject({ ok: false, denied: true });
    expect(called).toBe(false);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.bound).toContain("denied");
  });

  it("runs and logs a success row when the per-companion setting enables it", async () => {
    db.gateValue = "true";
    const res = await runWebSearch(makeEnv(db, bucket, "false"), "cypher", "rome weather", mockProvider());
    expect(res).toMatchObject({ ok: true, results: okSearch });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.bound).toContain("success");
    expect(db.inserts[0]!.bound).toContain("web_search");
  });

  it("logs an error row (not a throw) when the provider fails, gate on", async () => {
    db.gateValue = "true";
    const provider = mockProvider({ async webSearch() { throw new Error("tavily 500"); } });
    const res = await runWebSearch(makeEnv(db, bucket, "false"), "cypher", "q", provider);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("tavily 500") });
    expect(db.inserts[0]!.bound).toContain("error");
  });
});

describe("runImageGen", () => {
  it("puts the image in R2 under the deterministic key and logs success with result_ref", async () => {
    db.gateValue = "true";
    const res = await runImageGen(makeEnv(db, bucket, "false"), "drevan", "a black truck at dusk", mockProvider());
    expect(res.ok).toBe(true);
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]!.key).toMatch(/^tool-images\/drevan\/[0-9a-f]+\.png$/);
    expect(bucket.puts[0]!.contentType).toBe("image/png");
    // result_ref (the R2 key) must be in the logged row
    expect(db.inserts[0]!.bound).toContain(bucket.puts[0]!.key);
    expect(db.inserts[0]!.bound).toContain("success");
    expect(res).toMatchObject({ ok: true, key: bucket.puts[0]!.key });
  });

  it("denied gate: no R2 write, denied row", async () => {
    const res = await runImageGen(makeEnv(db, bucket, "false"), "gaia", "a seal", mockProvider());
    expect(res).toMatchObject({ ok: false, denied: true });
    expect(bucket.puts).toHaveLength(0);
    expect(db.inserts[0]!.bound).toContain("denied");
  });

  it("env default true enables when no per-companion setting exists", async () => {
    const res = await runImageGen(makeEnv(db, bucket, "true"), "cypher", "a blade", mockProvider());
    expect(res.ok).toBe(true);
    expect(bucket.puts).toHaveLength(1);
  });
});
