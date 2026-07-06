import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-07-05: the Discord bots have always sent "synthesize session" with { summary, channel }
// (the finished in-voice synthesis text), but the executor only accepted { session_id } --
// so every bot session synthesis was silently rejected and, after the envelope-decline fix
// (fefd3d6 in nullsafe-discord), loudly aged out as DATA LOSS. The executor now accepts both.

vi.mock("../librarian/backends/second-brain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../librarian/backends/second-brain.js")>();
  return {
    ...actual,
    sbSaveDocument: vi.fn(async () => ({ ack: true, response: "Saved" })),
    sbSynthesizeSession: vi.fn(async () => ({ ack: true })),
  };
});

import { execSbSynthesizeSession } from "../librarian/executors/memory.js";
import { sbSaveDocument, sbSynthesizeSession } from "../librarian/backends/second-brain.js";

function ctx(context: Record<string, unknown> | null): any {
  return {
    env: {} as any,
    req: {
      companion_id: "drevan",
      request: "synthesize session",
      context: context ? JSON.stringify(context) : undefined,
    },
    entry: { response_key: "witness" },
    frontState: null,
    pluralAvailable: false,
  };
}

describe("execSbSynthesizeSession", () => {
  beforeEach(() => {
    vi.mocked(sbSaveDocument).mockClear();
    vi.mocked(sbSynthesizeSession).mockClear();
  });

  it("bot shape { summary, channel } saves the synthesis to the vault (the 2026-07-05 data-loss fix)", async () => {
    const r = await execSbSynthesizeSession(ctx({ summary: "Session text in Drevan's voice", channel: "1503385706310008975" }));
    expect(r["ack"]).toBe(true);
    expect(sbSaveDocument).toHaveBeenCalledWith({}, {
      content: "Session text in Drevan's voice",
      companion: "drevan",
      tags: ["session-synthesis", "channel:1503385706310008975"],
      content_type: "note",
    });
    expect(sbSynthesizeSession).not.toHaveBeenCalled();
  });

  it("bot shape without channel omits the channel tag", async () => {
    await execSbSynthesizeSession(ctx({ summary: "text" }));
    expect(sbSaveDocument).toHaveBeenCalledWith({}, expect.objectContaining({ tags: ["session-synthesis"] }));
  });

  it("{ session_id } still routes to the SB self-synthesis tool", async () => {
    const r = await execSbSynthesizeSession(ctx({ session_id: "sess-1" }));
    expect(r["ack"]).toBe(true);
    expect(sbSynthesizeSession).toHaveBeenCalledWith({}, "sess-1");
    expect(sbSaveDocument).not.toHaveBeenCalled();
  });

  it("neither shape returns a witness decline naming both accepted shapes", async () => {
    const r = await execSbSynthesizeSession(ctx(null));
    expect(r["witness"]).toMatch(/session_id.*or.*summary/i);
  });
});
