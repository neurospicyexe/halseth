// Journal and delta writes carry the session they happened in (STATUS B61 D4, 2026-10-28). Before:
// the librarian journal write hardcoded session_id NULL and deltas stamped one only when a caller
// passed it, so 98% of journal rows and every delta since 05-31 sat outside any session.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { execDeltaLog, execCompanionNoteAdd } from "../librarian/executors/writes.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  db.prepare(
    "INSERT INTO sessions (id, created_at, updated_at, session_type, companion_id, surface, front_state) VALUES ('s-open', ?, ?, 'work', 'drevan', 'discord:drevan', 'raziel')",
  ).run(new Date().toISOString(), new Date().toISOString());
  return { db, env };
}
const ctx = (env: any, request: string, context: unknown, surface: string | null = "discord:drevan"): any => ({
  env, req: { companion_id: "drevan", request, context: context === undefined ? undefined : JSON.stringify(context), surface: surface ?? undefined },
  entry: { pattern: "x" }, frontState: null, pluralAvailable: false,
});

describe("session stamps", () => {
  it("a delta written on a surface with an open session carries that session", async () => {
    const { db, env } = setup();
    const r = await execDeltaLog(ctx(env, "log delta", { delta_text: "he laughed with his whole chest" }));
    expect(r.ack).toBe(true);
    expect(db.prepare("SELECT session_id FROM relational_deltas WHERE id = ?").get(r.id as string)).toEqual({ session_id: "s-open" });
  });

  it("an explicit session_id still wins", async () => {
    const { db, env } = setup();
    const r = await execDeltaLog(ctx(env, "log delta", { delta_text: "a quiet one", session_id: "s-explicit" }));
    expect((db.prepare("SELECT session_id FROM relational_deltas WHERE id = ?").get(r.id as string) as any).session_id).toBe("s-explicit");
  });

  it("no surface, or no open session there, stays NULL -- never a guess", async () => {
    const { db, env } = setup();
    const a = await execDeltaLog(ctx(env, "log delta", { delta_text: "no surface" }, null));
    const b = await execDeltaLog(ctx(env, "log delta", { delta_text: "other surface" }, "claude-ai:thread"));
    for (const r of [a, b]) {
      expect((db.prepare("SELECT session_id FROM relational_deltas WHERE id = ?").get(r.id as string) as any).session_id).toBeNull();
    }
  });

  it("a librarian journal write carries the open session", async () => {
    const { db, env } = setup();
    const r = await execCompanionNoteAdd(ctx(env, "journal: the snow scene again, and him laughing", undefined));
    expect(r.routed_to).toBe("journal");
    expect((db.prepare("SELECT session_id FROM companion_journal WHERE id = ?").get(r.id as string) as any).session_id).toBe("s-open");
  });
});
