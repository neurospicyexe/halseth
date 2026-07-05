// Schema-sprawl guardrail (2026-07-05).
//
// docs/write-routing-map.md is the single source of truth for which Librarian verb writes to
// which D1 table (the sibling-table trap map). This test keeps it in lockstep with the router:
// adding an EXECUTOR_MAP entry without documenting its write target fails CI, and stale doc
// rows for removed verbs fail too. The doc's table contents (which tables) are human-verified;
// what CI enforces is complete key coverage in both directions.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const routerSrc = readFileSync(resolve(here, "../librarian/router.ts"), "utf8");
const mapDoc = readFileSync(resolve(here, "../../docs/write-routing-map.md"), "utf8");

/** Extract the keys of EXECUTOR_MAP from router.ts source. */
function executorMapKeys(src: string): string[] {
  const start = src.indexOf("const EXECUTOR_MAP");
  expect(start).toBeGreaterThan(-1);
  // The map ends at the first line that is exactly "};" after the declaration.
  const rest = src.slice(start);
  const end = rest.search(/^\};/m);
  expect(end).toBeGreaterThan(-1);
  const block = rest.slice(0, end);
  // Keys are `identifier:` or `"quoted":` at the start of a line (values are bare
  // executor function refs, so only keys match this shape).
  const keys: string[] = [];
  for (const m of block.matchAll(/^\s{2}(?:"([^"]+)"|([a-zA-Z_]\w*)):\s/gm)) {
    const key = m[1] ?? m[2];
    if (key && key !== "const") keys.push(key);
  }
  return keys;
}

/** Extract the tool keys documented in the routing table (first backticked cell per row). */
function documentedKeys(doc: string): string[] {
  const keys: string[] = [];
  for (const m of doc.matchAll(/^\| `([a-zA-Z_]\w*)` \|/gm)) {
    keys.push(m[1]!);
  }
  return keys;
}

describe("write-routing-map.md stays in lockstep with EXECUTOR_MAP", () => {
  const routerKeys = executorMapKeys(routerSrc);
  const docKeys = documentedKeys(mapDoc);

  it("parses a plausible number of keys from both sources", () => {
    expect(routerKeys.length).toBeGreaterThan(100);
    expect(docKeys.length).toBeGreaterThan(100);
  });

  it("has no duplicate rows in the doc", () => {
    const dupes = docKeys.filter((k, i) => docKeys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("documents every EXECUTOR_MAP key (new verb => add a row with its write target)", () => {
    const docSet = new Set(docKeys);
    const missing = routerKeys.filter((k) => !docSet.has(k));
    expect(missing, `undocumented verbs -- add rows to docs/write-routing-map.md (trace the executor to its actual table, do not guess from the name): ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale doc rows for verbs removed from the router", () => {
    const routerSet = new Set(routerKeys);
    const stale = docKeys.filter((k) => !routerSet.has(k));
    expect(stale, `stale doc rows -- remove from docs/write-routing-map.md: ${stale.join(", ")}`).toEqual([]);
  });
});
