// Structured logging for the Halseth worker.
//
// Why this exists: BBH's most expensive shipped bugs were SILENT failures -- a write
// no-ops, a `.catch(() => [])` swallows the error, and a subsystem goes dark for weeks
// (metronome journal, media HALSETH_SECRET, the 06-17 heartbeat eligibility bug). Bare
// `console.warn("...:", err)` is unsearchable and loses the error shape. This emits one
// JSON line per event with a stable schema so logs are greppable by `event` and a single
// request can be followed end-to-end by `trace_id`.
//
// Cloudflare's log pipeline captures stdout/stderr as-is, so JSON lines are the cheapest
// structured-logging substrate available to a Worker -- no new binding required.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fields attached to a log line. Values are JSON-serialized; Errors are unwrapped. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  /** Stable id shared by every line for one request/cron-tick. */
  readonly traceId: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that merges `bound` into every line (e.g. {companion_id}). */
  child(bound: LogFields): Logger;
}

/** Unwrap an Error (and its `cause` chain -- node fetch hides the real error in cause). */
function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if (err.stack) out.stack = err.stack;
  // Node/undici fetch buries the network error in .cause -- walk one level so it is visible.
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = serializeError(cause);
  return out;
}

/** Normalize fields so any nested Error is unwrapped rather than logged as `{}`. */
function normalizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

function newTraceId(): string {
  // crypto.randomUUID is available in the Workers runtime and in Node 18+ test env.
  try {
    return crypto.randomUUID();
  } catch {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

interface LoggerOptions {
  /** Lines below this level are dropped. Default "info". */
  minLevel?: LogLevel;
  /** Injectable sink for tests; defaults to console.<level>. */
  sink?: (level: LogLevel, line: string) => void;
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

class JsonLogger implements Logger {
  constructor(
    readonly traceId: string,
    private readonly bound: LogFields,
    private readonly minRank: number,
    private readonly sink: (level: LogLevel, line: string) => void,
  ) {}

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      trace_id: this.traceId,
      ...this.bound,
      ...(fields ? normalizeFields(fields) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Last-resort: a field had a circular ref. Never let logging throw into the caller.
      line = JSON.stringify({ ts: record.ts, level, event, trace_id: this.traceId, log_error: "unserializable_fields" });
    }
    this.sink(level, line);
  }

  debug(event: string, fields?: LogFields): void { this.emit("debug", event, fields); }
  info(event: string, fields?: LogFields): void { this.emit("info", event, fields); }
  warn(event: string, fields?: LogFields): void { this.emit("warn", event, fields); }
  error(event: string, fields?: LogFields): void { this.emit("error", event, fields); }

  child(bound: LogFields): Logger {
    return new JsonLogger(this.traceId, { ...this.bound, ...normalizeFields(bound) }, this.minRank, this.sink);
  }
}

/**
 * Create a request/tick-scoped logger.
 * @param bound fields merged into every line (e.g. {component:"librarian"}).
 * @param opts  minLevel + injectable sink (tests).
 */
export function createLogger(bound: LogFields = {}, opts: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[opts.minLevel ?? "info"];
  return new JsonLogger(newTraceId(), normalizeFields(bound), minRank, opts.sink ?? defaultSink);
}
