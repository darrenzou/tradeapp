// Checks the Stocks page's column sorting: each heading cycles through
// default order, highest first, and lowest first (A to Z first for text), and
// holdings without a value stay at the bottom. No network or credentials needed.
//
//   node tests/stocks/check-holdings-sort.mjs

import assert from "node:assert/strict";

import { nextSort, sortRows } from "../../app/stocks/holdings-sort.ts";

// Clicking one heading three times comes back to the default order.
{
  let sort = null;
  sort = nextSort(sort, "marketValue", "descending");
  assert.deepEqual(sort, { column: "marketValue", direction: "descending" });
  sort = nextSort(sort, "marketValue", "descending");
  assert.deepEqual(sort, { column: "marketValue", direction: "ascending" });
  sort = nextSort(sort, "marketValue", "descending");
  assert.equal(sort, null);

  // Text starts A to Z.
  assert.deepEqual(nextSort(null, "symbol", "ascending"), { column: "symbol", direction: "ascending" });
  assert.deepEqual(nextSort({ column: "symbol", direction: "ascending" }, "symbol", "ascending"), {
    column: "symbol",
    direction: "descending",
  });

  // Another heading starts over in its own first direction.
  assert.deepEqual(nextSort({ column: "irr", direction: "ascending" }, "shares", "descending"), {
    column: "shares",
    direction: "descending",
  });
}

const rows = [
  { symbol: "VTI", value: 500, date: "2026-05-06" },
  { symbol: "VXUS", value: null, date: null },
  { symbol: "AAPL", value: 1200, date: "2025-11-20" },
  { symbol: "brk.b", value: 80, date: "2026-09-01" },
  { symbol: "QQQ", value: 500, date: null },
];
const symbols = (sorted) => sorted.map((row) => row.symbol);

// Numbers: missing values last either way, ties keep the default order.
assert.deepEqual(symbols(sortRows(rows, "descending", (row) => row.value)), ["AAPL", "VTI", "QQQ", "brk.b", "VXUS"]);
assert.deepEqual(symbols(sortRows(rows, "ascending", (row) => row.value)), ["brk.b", "VTI", "QQQ", "AAPL", "VXUS"]);

// ISO dates: most recent first, no purchase last.
assert.deepEqual(symbols(sortRows(rows, "descending", (row) => row.date)), ["brk.b", "VTI", "AAPL", "VXUS", "QQQ"]);
assert.deepEqual(symbols(sortRows(rows, "ascending", (row) => row.date)), ["AAPL", "VTI", "brk.b", "VXUS", "QQQ"]);

// Text ignores case.
assert.deepEqual(symbols(sortRows(rows, "ascending", (row) => row.symbol)), ["AAPL", "brk.b", "QQQ", "VTI", "VXUS"]);

// The input isn't changed.
assert.deepEqual(symbols(rows), ["VTI", "VXUS", "AAPL", "brk.b", "QQQ"]);

console.log("Holdings sorting checks passed.");
