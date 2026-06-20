// Write contract for the Halseth worker.
//
// Why this exists: D1's `.run()` resolves to a result whose `success` flag and
// `meta.changes` count are routinely ignored. A constraint violation, a missing row, or a
// no-op UPDATE all resolve "successfully" from the caller's point of view, so a write that
// changed nothing looks identical to a write that worked. Combined with `.catch(() => ...)`
// this is the exact shape of every silent-no-op bug in BUGS.md.
//
// `assertWritten` makes a REQUIRED write loud: it throws if the statement failed or (when
// asked) if it changed zero rows. Per `feedback_fire_and_forget_pattern`, continuity-critical
// writes must raise on failure; truly-optional writes should instead log via lib/log.ts.
//
// `Result<T>` is the typed return for operations that can fail without throwing -- callers
// `if (!r.ok)` instead of relying on a thrown error or a swallowed null.

/** Minimal shape of a D1 run() result (avoids importing the full Cloudflare types here). */
export interface D1RunResult {
  success?: boolean;
  meta?: { changes?: number; last_row_id?: number | null } & Record<string, unknown>;
  error?: string;
}

export class WriteFailedError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WriteFailedError";
  }
}

export interface AssertWrittenOptions {
  /** Throw if the write reported zero changed rows. Default true. */
  requireChanges?: boolean;
}

/**
 * Assert that a REQUIRED D1 write actually persisted. Throws WriteFailedError otherwise.
 *
 * @param res D1 result from `.run()`.
 * @param ctx identifying fields for the log/error (e.g. {op:"journal_add", companion_id}).
 * @returns the number of changed rows (so callers can branch without re-reading meta).
 */
export function assertWritten(
  res: D1RunResult | null | undefined,
  ctx: Record<string, unknown>,
  opts: AssertWrittenOptions = {},
): number {
  const requireChanges = opts.requireChanges ?? true;

  if (!res) {
    throw new WriteFailedError("write returned no result", { ...ctx });
  }
  if (res.success === false) {
    throw new WriteFailedError("write reported success=false", { ...ctx, d1_error: res.error });
  }
  const changes = res.meta?.changes ?? 0;
  if (requireChanges && changes <= 0) {
    throw new WriteFailedError("write changed zero rows", { ...ctx, changes });
  }
  return changes;
}

// --- Result<T> -----------------------------------------------------------------

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** True when `r` is the success variant (type guard). */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/**
 * Run an async op, capturing a thrown error as an `err` Result instead of propagating it.
 * Use at boundaries where a failure should degrade gracefully but must NOT be swallowed
 * silently -- the caller still sees `{ok:false}` and can log it.
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  mapError: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<Result<T, string>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(mapError(e));
  }
}
