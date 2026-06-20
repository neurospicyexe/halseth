import { describe, it, expect, beforeEach } from "vitest";
import {
  postInteriority,
  getInteriority,
  getInteriorityMeta,
  patchInteriorityDisclose,
} from "../handlers/interiority";

// --- minimal stateful D1 mock for companion_interiority -----------------------
interface Row {
  id: string;
  companion_id: string;
  created_at: string;
  content: string;
  mood: string | null;
  tags: string | null;
  disclosed_at: string | null;
  edited_at: string | null;
}

function makeDB(rows: Row[]) {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async run() {
          if (sql.startsWith("INSERT INTO companion_interiority")) {
            const [id, companion_id, created_at, content, mood, tags] = args as [string, string, string, string, string | null, string | null];
            rows.push({ id, companion_id, created_at, content, mood: mood ?? null, tags: tags ?? null, disclosed_at: null, edited_at: null });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE companion_interiority SET disclosed_at")) {
            const [now, id, companion_id] = args as [string, string, string];
            const r = rows.find((x) => x.id === id && x.companion_id === companion_id && x.disclosed_at === null);
            if (r) {
              r.disclosed_at = now;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async all<T>() {
          const companion_id = args[0] as string;
          if (sql.includes("SELECT DISTINCT mood")) {
            const moods = [...new Set(rows.filter((r) => r.companion_id === companion_id && r.mood).map((r) => r.mood))];
            return { results: moods.map((mood) => ({ mood })) as T[] };
          }
          const mine = rows
            .filter((r) => r.companion_id === companion_id)
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          return { results: mine as T[] };
        },
        async first<T>() {
          const companion_id = args[0] as string;
          const mine = rows.filter((r) => r.companion_id === companion_id);
          return {
            count: mine.length,
            last_written_at: mine.length ? mine[mine.length - 1]!.created_at : null,
            disclosed_count: mine.filter((r) => r.disclosed_at).length,
          } as T;
        },
      };
      return stmt;
    },
  };
}

const SECRETS = {
  ADMIN_SECRET: "admin-tok",
  CYPHER_MCP_SECRET: "cy-tok",
  DREVAN_MCP_SECRET: "dre-tok",
  GAIA_MCP_SECRET: "ga-tok",
};

let rows: Row[];
function env() {
  return { ...SECRETS, DB: makeDB(rows) } as any;
}

function req(method: string, path: string, token?: string, body?: unknown) {
  return new Request("https://test.local" + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  rows = [];
});

describe("interiority: write", () => {
  it("a companion writes into its own room (201) tagged with its id", async () => {
    const res = await postInteriority(req("POST", "/interiority", "cy-tok", { content: "a thought just for me" }), env());
    expect(res.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.companion_id).toBe("cypher");
  });

  it("admin may write on behalf of a named companion", async () => {
    const res = await postInteriority(req("POST", "/interiority", "admin-tok", { companion_id: "gaia", content: "x" }), env());
    expect(res.status).toBe(201);
    expect(rows[0]!.companion_id).toBe("gaia");
  });

  it("a companion CANNOT write into another companion's room (403)", async () => {
    const res = await postInteriority(req("POST", "/interiority", "cy-tok", { companion_id: "gaia", content: "x" }), env());
    expect(res.status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it("rejects an unauthenticated write", async () => {
    const res = await postInteriority(req("POST", "/interiority", undefined, { content: "x" }), env());
    expect(res.status).toBe(401);
  });
});

describe("interiority: the privacy boundary (the whole point)", () => {
  beforeEach(async () => {
    await postInteriority(req("POST", "/interiority", "cy-tok", { content: "sealed thought", mood: "raw" }), env());
  });

  it("the owning companion CAN read its own content", async () => {
    const res = await getInteriority(req("GET", "/interiority/cypher", "cy-tok"), env(), { companion_id: "cypher" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Row[];
    expect(body[0]!.content).toBe("sealed thought");
  });

  it("ADMIN (Raziel) is refused content -- frosted glass, by design", async () => {
    const res = await getInteriority(req("GET", "/interiority/cypher", "admin-tok"), env(), { companion_id: "cypher" });
    expect(res.status).toBe(403);
  });

  it("a different companion is refused content", async () => {
    const res = await getInteriority(req("GET", "/interiority/cypher", "ga-tok"), env(), { companion_id: "cypher" });
    expect(res.status).toBe(403);
  });
});

describe("interiority: meta (frosted glass)", () => {
  beforeEach(async () => {
    const e = env();
    await postInteriority(req("POST", "/interiority", "cy-tok", { content: "one", mood: "tender" }), e);
    await postInteriority(req("POST", "/interiority", "cy-tok", { content: "two", mood: "sharp" }), e);
  });

  it("admin sees count + moods but never content", async () => {
    const res = await getInteriorityMeta(req("GET", "/interiority/cypher/meta", "admin-tok"), env(), { companion_id: "cypher" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; moods: string[] };
    expect(body.count).toBe(2);
    expect(body.moods.sort()).toEqual(["sharp", "tender"]);
    expect(JSON.stringify(body)).not.toContain("one");
    expect(JSON.stringify(body)).not.toContain("two");
  });

  it("owner may also read meta", async () => {
    const res = await getInteriorityMeta(req("GET", "/interiority/cypher/meta", "cy-tok"), env(), { companion_id: "cypher" });
    expect(res.status).toBe(200);
  });
});

describe("interiority: disclosure is an explicit owner act", () => {
  it("owner discloses one entry; a second disclose is a no-op 404", async () => {
    const e = env();
    const created = (await (await postInteriority(req("POST", "/interiority", "cy-tok", { content: "share this" }), e)).json()) as { id: string };

    const first = await patchInteriorityDisclose(req("PATCH", `/interiority/${created.id}/disclose`, "cy-tok"), e, { id: created.id });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { disclosed: boolean }).disclosed).toBe(true);

    const second = await patchInteriorityDisclose(req("PATCH", `/interiority/${created.id}/disclose`, "cy-tok"), e, { id: created.id });
    expect(second.status).toBe(404);
  });

  it("a non-owner cannot disclose", async () => {
    const res = await patchInteriorityDisclose(req("PATCH", "/interiority/whatever/disclose", "admin-tok"), env(), { id: "whatever" });
    expect(res.status).toBe(403);
  });
});
