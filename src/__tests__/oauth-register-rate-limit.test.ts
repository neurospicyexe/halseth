import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "../lib/rate-limit.js";

describe("oauth/register rate limiting", () => {
  it("checkRateLimit short-circuits with 429 when the limiter reports failure", async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const result = await checkRateLimit(limiter as any, "oauth-register:1.2.3.4");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
  });

  it("checkRateLimit returns null (proceed) when the limiter reports success", async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
    const result = await checkRateLimit(limiter as any, "oauth-register:1.2.3.4");
    expect(result).toBeNull();
  });
});
