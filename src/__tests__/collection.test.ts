import { describe, it, expect } from "vitest";
import {
  isValidSparkleSource,
  sparkleDelta,
  bumpSparkleSql,
  collectionForageSql,
  collectionMediaSql,
} from "../webmind/collection.js";

describe("sparkle sources + deltas", () => {
  it("validates source tables", () => {
    expect(isValidSparkleSource("forage_finds")).toBe(true);
    expect(isValidSparkleSource("media_experiences")).toBe(true);
    expect(isValidSparkleSource("sessions")).toBe(false);
  });
  it("consume shines brightest, recall faintest", () => {
    expect(sparkleDelta("consume")).toBeGreaterThan(sparkleDelta("react"));
    expect(sparkleDelta("react")).toBeGreaterThan(sparkleDelta("recall"));
    expect(sparkleDelta("recall")).toBeGreaterThan(0);
  });
});

describe("sql builders", () => {
  it("bumpSparkleSql is an additive upsert (monotonic up)", () => {
    const sql = bumpSparkleSql();
    expect(sql).toContain("INSERT INTO collection_sparkle");
    expect(sql).toContain("ON CONFLICT(source_table, source_id) DO UPDATE SET");
    expect(sql).toContain("sparkle = sparkle + excluded.sparkle");
  });
  it("collection reads LEFT JOIN sparkle and order by it brightest-first", () => {
    expect(collectionForageSql()).toContain("LEFT JOIN collection_sparkle");
    expect(collectionForageSql()).toContain("ORDER BY sparkle DESC");
    expect(collectionForageSql()).toContain("f.companion_id = ? OR f.companion_id IS NULL");
    expect(collectionMediaSql()).toContain("LEFT JOIN collection_sparkle");
    expect(collectionMediaSql()).toContain("ORDER BY sparkle DESC");
  });
});
