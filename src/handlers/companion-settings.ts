import type { Env } from "../types.js";

export async function handleGetCompanionSettings(
  companionId: string,
  env: Env,
): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM companion_settings WHERE companion_id = ?",
  ).bind(companionId).all<{ key: string; value: string }>();

  const result: Record<string, string> = {};
  for (const row of rows.results) result[row.key] = row.value;
  return Response.json(result);
}

export async function handlePostCompanionSettings(
  companionId: string,
  body: unknown,
  env: Env,
): Promise<Response> {
  const { key, value } = body as { key: string; value: string };
  if (!key || !value) return new Response("Missing key or value", { status: 400 });

  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(companionId, key, value).run();

  return Response.json({ ok: true });
}
