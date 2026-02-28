import { Env } from "../types.js";

export async function handleBiometricsLatest(_request: Request, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT 1"
  ).first();

  return new Response(JSON.stringify(row ?? null), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleBiometricsList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "7", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 7 : rawLimit), 30);

  const result = await env.DB.prepare(
    "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT ?"
  ).bind(limit).all();

  return new Response(JSON.stringify(result.results), {
    headers: { "Content-Type": "application/json" },
  });
}
