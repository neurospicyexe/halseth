// The ledger number rule, shared with the bots (2026-09-26 integration pass). The same fixture file lives in
// nullsafe-discord (packages/shared/src/__tests__/fixtures/ledger-number-fixtures.json), where the bots'
// local pre-filter (preflightLedgerBody) must name the same rule for every case. The server is the
// authority; this test pins what it says, so a grammar change that is not mirrored in the bots fails there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateLedger } from "../ledger/grammar.js";

interface Case { body: string; kind: string; ref?: string; function?: string; rule: string | null }
const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ledger-number-fixtures.json"), "utf8")) as { window: string; cases: Case[] };

describe("ledger number fixtures (shared with the bots' pre-filter)", () => {
  it.each(fx.cases.map((c) => [c.body, c.kind, c] as const))("%s [%s]", (_b, _k, c) => {
    const v = validateLedger({
      companion_id: "drevan", function: c.function ?? "distiller", body: c.body,
      source_kind: c.kind, source_ref: c.ref ?? fx.window, observed_on: "2026-09-24",
    }, "2026-09-26");
    expect(v.ok ? null : v.rule).toBe(c.rule);
  });
});
