import { describe, it, expect } from "vitest";
import { postMindSpiralRun } from "../handlers/webmind.js";

function req(body: unknown): Request {
  return new Request("https://h.example/mind/spiral/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer admin-tok" },
    body: JSON.stringify(body),
  });
}

describe("postMindSpiralRun error shape", () => {
  it("does not leak raw exception text when the DB call throws", async () => {
    // No DB binding on env -- queueAndRunSpiral's first env.DB.prepare() throws synchronously.
    const env = { ADMIN_SECRET: "admin-tok" } as any;
    const res = await postMindSpiralRun(
      req({ companion_id: "cypher", seed_text: "a test seed" }),
      env,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("detail");
    expect(JSON.stringify(body)).not.toContain("Cannot read properties");
    expect(body.error).toBe("spiral run failed");
  });
});
