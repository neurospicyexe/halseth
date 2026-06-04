import { describe, it, expect } from "vitest";
import { getHomePresence, getHomeEvents, postHomeTick } from "../handlers/home.js";

type Row = Record<string, unknown>;
function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => results[0] ?? null,
    run: async () => ({ meta: { changes: 1 } }),
  };
  return stmt;
}
function makeEnv(impl: (sql: string) => any) {
  return { ADMIN_SECRET: "test-secret", DB: { prepare: impl } } as any;
}
function authed(url: string): Request {
  return new Request(url, { headers: { Authorization: "Bearer test-secret" } });
}
function unauthed(url: string): Request {
  return new Request(url);
}

describe("getHomePresence", () => {
  it("returns presence rows under a { presence } envelope plus rooms", async () => {
    const env = makeEnv(() => makeStmt([
      { companion_id: "cypher", current_room: "office", activity: "x", micro_mood: null, with_companion: null, basin_distance: 0, updated_at: "now" },
    ]));
    const res = await getHomePresence(authed("https://t.local/home/presence"), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.presence).toHaveLength(1);
    expect(body.presence[0].current_room).toBe("office");
    expect(Array.isArray(body.rooms)).toBe(true);
  });

  it("returns 401 when unauthorized", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await getHomePresence(unauthed("https://t.local/home/presence"), env);
    expect(res.status).toBe(401);
  });
});

describe("getHomeEvents", () => {
  it("returns events under a { events } envelope, default companion cypher", async () => {
    const env = makeEnv(() => makeStmt([
      { id: "e1", companion_id: "cypher", event_type: "move", room: "office", with_companion: null, text: "hi" },
    ]));
    const res = await getHomeEvents(authed("https://t.local/home/events"), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("e1");
  });

  it("caps limit at 100", async () => {
    let boundLimit = -1;
    const stmt: any = {
      bind: (...args: any[]) => { boundLimit = args[args.length - 1]; return stmt; },
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    const env = makeEnv(() => stmt);
    await getHomeEvents(authed("https://t.local/home/events?limit=9999"), env);
    expect(boundLimit).toBe(100);
  });

  it("returns 401 when unauthorized", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await getHomeEvents(unauthed("https://t.local/home/events"), env);
    expect(res.status).toBe(401);
  });
});

describe("postHomeTick", () => {
  it("runs the tick and returns { ran: true, result }", async () => {
    // No companion rows -> tick loops over default companions, each getPresence null,
    // latestBasin null -> stable. All prepare calls return empty stmts.
    const env = makeEnv(() => makeStmt([]));
    const res = await postHomeTick(new Request("https://t.local/home/tick", {
      method: "POST", headers: { Authorization: "Bearer test-secret" },
    }), env);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ran).toBe(true);
    expect(body.result).toBeDefined();
  });

  it("returns 401 when unauthorized", async () => {
    const env = makeEnv(() => makeStmt([]));
    const res = await postHomeTick(new Request("https://t.local/home/tick", { method: "POST" }), env);
    expect(res.status).toBe(401);
  });
});
