import { describe, it, expect } from "vitest";
import { getKernel, getKernelBundle, postKernel } from "../handlers/identity-kernel.js";

type Row = Record<string, unknown>;

function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: results.length || 1 } }),
  };
  return stmt;
}

// A statement whose first() resolves based on the bound companion_id, so the
// bundle path (which looks up 'shared' and the companion with the SAME sql) can
// return two different rows.
function kernelLookupStmt(rowFor: (cid: string) => Row | null) {
  let bound: unknown[] = [];
  const stmt: any = {
    bind: (...args: unknown[]) => { bound = args; return stmt; },
    first: async () => rowFor(String(bound[0] ?? "")),
    run: async () => ({ meta: { changes: 1 } }),
  };
  return stmt;
}

function makeEnv(prepareImpl: (sql: string) => any) {
  return { ADMIN_SECRET: "test-secret", DB: { prepare: prepareImpl } } as any;
}

function authed(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Mirror of the handler's checksum so the idempotency test can match it.
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const LONG = "C".repeat(250); // exceeds MIN_KERNEL_LENGTH (200)

describe("postKernel", () => {
  it("inserts the next version when content differs from the active row", async () => {
    let insertBound: unknown[] = [];
    const env = makeEnv((sql: string) => {
      if (sql.includes("SELECT * FROM identity_kernel")) return makeStmt([]); // no active row
      if (sql.includes("SELECT COALESCE(MAX(version)")) return makeStmt([{ v: 2 }]);
      if (sql.startsWith("UPDATE identity_kernel")) return makeStmt([]);
      if (sql.startsWith("INSERT INTO identity_kernel")) {
        return { bind: (...b: unknown[]) => { insertBound = b; return { run: async () => ({ meta: { changes: 1 } }) }; } };
      }
      return makeStmt([]);
    });
    const res = await postKernel(authed("https://t/identity/kernel", "POST", { companion_id: "shared", kernel_md: LONG }), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.version).toBe(3); // MAX(2) + 1
    expect(body.unchanged).toBeUndefined();
    // INSERT bind order: id, companion_id, version, kernel_md, vows_json, checksum, source_note
    expect(insertBound[1]).toBe("shared");
    expect(insertBound[2]).toBe(3);
  });

  it("is a checksum no-op when content is unchanged", async () => {
    const checksum = await sha256Hex(LONG);
    const env = makeEnv((sql: string) => {
      if (sql.includes("SELECT * FROM identity_kernel")) {
        return makeStmt([{ id: "kern_existing", companion_id: "shared", version: 5, checksum, active: 1, kernel_md: LONG }]);
      }
      return makeStmt([]);
    });
    const res = await postKernel(authed("https://t/identity/kernel", "POST", { companion_id: "shared", kernel_md: LONG }), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.unchanged).toBe(true);
    expect(body.version).toBe(5);
    expect(body.id).toBe("kern_existing");
  });

  it("rejects kernel_md under the minimum length", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await postKernel(authed("https://t/identity/kernel", "POST", { companion_id: "shared", kernel_md: "too short" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid companion_id", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await postKernel(authed("https://t/identity/kernel", "POST", { companion_id: "bogus", kernel_md: LONG }), env);
    expect(res.status).toBe(400);
  });
});

describe("getKernelBundle", () => {
  it("prepends the shared floor to the companion kernel with the canonical separator", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.includes("SELECT * FROM identity_kernel")) {
        return kernelLookupStmt((cid) =>
          cid === "shared" ? ({ kernel_md: "SHARED-FLOOR", version: 7 } as Row) :
          cid === "cypher" ? ({ kernel_md: "CYPHER-SELF", version: 3 } as Row) : null);
      }
      return makeStmt([]);
    });
    const res = await getKernelBundle(authed("https://t/identity/kernel/cypher/bundle", "GET"), env, { companion_id: "cypher" });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.bundle).toBe("SHARED-FLOOR\n\n---\n\nCYPHER-SELF");
    expect(body.versions).toEqual({ shared: 7, companion: 3 });
  });

  it("rejects a bundle request for 'shared'", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await getKernelBundle(authed("https://t/identity/kernel/shared/bundle", "GET"), env, { companion_id: "shared" });
    expect(res.status).toBe(400);
  });

  it("404s when the companion has no active kernel", async () => {
    const env = makeEnv((sql: string) => {
      if (sql.includes("SELECT * FROM identity_kernel")) {
        return kernelLookupStmt((cid) => (cid === "shared" ? ({ kernel_md: "SHARED" } as Row) : null));
      }
      return makeStmt([]);
    });
    const res = await getKernelBundle(authed("https://t/identity/kernel/cypher/bundle", "GET"), env, { companion_id: "cypher" });
    expect(res.status).toBe(404);
  });
});

describe("getKernel auth", () => {
  it("denies a request without the bearer token", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await getKernel(new Request("https://t/identity/kernel/cypher", { method: "GET" }), env, { companion_id: "cypher" });
    expect(res.status).toBe(401);
  });
});
