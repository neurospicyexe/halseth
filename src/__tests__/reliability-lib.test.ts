import { describe, it, expect, vi } from "vitest";
import { createLogger, type LogLevel } from "../lib/log";
import { assertWritten, WriteFailedError, ok, err, isOk, tryAsync } from "../lib/result";

describe("lib/log structured logger", () => {
  function capture(minLevel?: LogLevel) {
    const lines: Array<{ level: LogLevel; record: Record<string, unknown> }> = [];
    const logger = createLogger(
      { component: "test" },
      { minLevel, sink: (level, line) => lines.push({ level, record: JSON.parse(line) }) },
    );
    return { logger, lines };
  }

  it("emits one JSON line per event with stable schema + shared trace id", () => {
    const { logger, lines } = capture();
    logger.info("thing_happened", { companion_id: "cypher" });
    logger.error("thing_broke", { code: 500 });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.record).toMatchObject({
      level: "info",
      event: "thing_happened",
      component: "test",
      companion_id: "cypher",
    });
    expect(lines[0]!.record.trace_id).toBe(logger.traceId);
    expect(lines[1]!.record.trace_id).toBe(logger.traceId); // same request -> same id
    expect(typeof lines[0]!.record.ts).toBe("string");
  });

  it("drops lines below minLevel", () => {
    const { logger, lines } = capture("warn");
    logger.info("ignored");
    logger.debug("ignored");
    logger.warn("kept");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.record.event).toBe("kept");
  });

  it("unwraps Error fields (and the cause chain) instead of logging {}", () => {
    const { logger, lines } = capture();
    const cause = new Error("ECONNREFUSED");
    const e = new Error("fetch failed", { cause });
    logger.error("write_failed", { err: e });
    const errField = lines[0]!.record.err as Record<string, unknown>;
    expect(errField.message).toBe("fetch failed");
    expect((errField.cause as Record<string, unknown>).message).toBe("ECONNREFUSED");
  });

  it("child loggers inherit trace id and merge bound fields", () => {
    const { logger, lines } = capture();
    const child = logger.child({ op: "orient" });
    child.info("step");
    expect(lines[0]!.record).toMatchObject({ component: "test", op: "orient" });
    expect(lines[0]!.record.trace_id).toBe(logger.traceId);
  });

  it("never throws on unserializable fields", () => {
    const { logger, lines } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.error("boom", { circular })).not.toThrow();
    expect(lines[0]!.record.log_error).toBe("unserializable_fields");
  });

  it("routes error level to console.error (default sink)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger({}, { minLevel: "info" }).error("e");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("lib/result assertWritten", () => {
  const ctx = { op: "journal_add", companion_id: "cypher" };

  it("returns change count on a successful write", () => {
    expect(assertWritten({ success: true, meta: { changes: 1 } }, ctx)).toBe(1);
  });

  it("throws when result is null/undefined", () => {
    expect(() => assertWritten(null, ctx)).toThrow(WriteFailedError);
    expect(() => assertWritten(undefined, ctx)).toThrow(/no result/);
  });

  it("throws on success=false and carries d1 error + context", () => {
    try {
      assertWritten({ success: false, error: "CONSTRAINT", meta: {} }, ctx);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WriteFailedError);
      const w = e as WriteFailedError;
      expect(w.context.op).toBe("journal_add");
      expect(w.context.d1_error).toBe("CONSTRAINT");
    }
  });

  it("throws on zero changes when changes are required (the silent no-op bug)", () => {
    expect(() => assertWritten({ success: true, meta: { changes: 0 } }, ctx)).toThrow(/zero rows/);
  });

  it("allows zero changes when requireChanges:false (e.g. idempotent upsert)", () => {
    expect(assertWritten({ success: true, meta: { changes: 0 } }, ctx, { requireChanges: false })).toBe(0);
  });
});

describe("lib/result Result<T>", () => {
  it("ok/err/isOk discriminate correctly", () => {
    const good = ok(42);
    const bad = err("nope");
    expect(isOk(good)).toBe(true);
    expect(isOk(bad)).toBe(false);
    if (isOk(good)) expect(good.value).toBe(42);
    if (!bad.ok) expect(bad.error).toBe("nope");
  });

  it("tryAsync captures a thrown error as err instead of propagating", async () => {
    const r = await tryAsync(async () => {
      throw new Error("kaboom");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("kaboom");
  });

  it("tryAsync returns ok on success", async () => {
    const r = await tryAsync(async () => "fine");
    expect(r).toEqual({ ok: true, value: "fine" });
  });
});
