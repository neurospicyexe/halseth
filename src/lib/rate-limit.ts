/**
 * Rate limiting helper for sensitive endpoints.
 * Uses Cloudflare Workers Rate Limiting API (free tier compatible).
 * Binding configured in wrangler.toml [[ratelimits]].
 */

export async function checkRateLimit(
  limiter: RateLimit,
  key: string,
): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}
