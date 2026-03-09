import { Env } from "../types";

// Allowed upload MIME types. Anything else is stored as application/octet-stream.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "image/svg+xml",     // stored but served as attachment (SVG can embed script)
  "application/pdf",
  "text/plain",
]);

// Types that are safe to render inline in a browser.
const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
]);

function authGuard(request: Request, env: Env): Response | null {
  if (!env.ADMIN_SECRET) return null;
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

// POST /assets/upload
// Accepts multipart/form-data with a `file` field and an optional `key` field.
// Stores the object in R2 under the given key (or a generated one).
// Returns { key, url } where url is the serving path.
export async function uploadAsset(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("Expected multipart/form-data", { status: 400 });
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return new Response("Missing file field", { status: 400 });
  }
  // At this point file is a Blob (File extends Blob); cast to access name/type.
  const blob = file as { arrayBuffer(): Promise<ArrayBuffer>; type: string; name?: string };

  // Allow caller to specify a key (e.g. "locations/kitchen.jpg"), or generate one.
  const rawKey = formData.get("key");
  const filename = blob.name ?? "upload";
  const key =
    typeof rawKey === "string" && rawKey.trim()
      ? rawKey.trim()
      : `${crypto.randomUUID()}/${filename}`;

  const mimeType = blob.type && ALLOWED_MIME_TYPES.has(blob.type)
    ? blob.type
    : "application/octet-stream";

  const buffer = await blob.arrayBuffer();
  await env.BUCKET.put(key, buffer, {
    httpMetadata: { contentType: mimeType },
  });

  return new Response(
    JSON.stringify({ key, url: `/assets/${encodeURIComponent(key)}` }),
    {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }
  );
}

// GET /assets?prefix=rooms/
// Lists R2 objects under an optional prefix. Returns key, size, uploaded timestamp.
export async function listAssets(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url    = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const listed = await env.BUCKET.list({ prefix, cursor, limit: 100 });

  const objects = listed.objects.map((obj) => ({
    key:      obj.key,
    size:     obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));

  return new Response(
    JSON.stringify({
      objects,
      truncated: listed.truncated,
      cursor:    listed.truncated ? listed.cursor : undefined,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// GET /assets/:key
// Streams the object from R2. The key is everything after /assets/ (URL-decoded).
export async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Strip the leading "/assets/" prefix to get the raw key.
  const key = decodeURIComponent(url.pathname.replace(/^\/assets\//, ""));

  if (!key) {
    return new Response("Missing key", { status: 400 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  // Allow browsers and the dashboard to cache static assets for 1 hour.
  headers.set("cache-control", "public, max-age=3600");

  // Only render images inline; force download for everything else (including SVG).
  const ct = ((headers.get("Content-Type") ?? "").split(";")[0] ?? "").trim();
  if (!INLINE_IMAGE_TYPES.has(ct)) {
    headers.set("Content-Disposition", "attachment");
  }

  return new Response(object.body, { headers });
}
