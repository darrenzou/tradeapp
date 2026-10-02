// Checks each holding's gain over a period, including dividends, and the
// return rate that counts money added partway through as at work for half
// the period. No network or credentials needed.
//
//   node tests/stocks/check-returns.mjs

import assert from "node:assert/strict";

import { holdingReturns, returnRate } from "../../lib/appreciation.ts";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

const today = "2026-10-01";
const input = {
  positions: [
    // 10 shares now, 5 of them bought in March.
    { accountId: "a", key: "VTI", ticker: "VTI", quantity: 10, currentValue: 1100 },
    // A fund without market prices can't be valued.
    { accountId: "a", key: "Plan fund", ticker: null, quantity: 3, currentValue: 300 },
    // Sold before the period: left out.
    { accountId: "a", key: "OLD", ticker: "OLD", quantity: 0, currentValue: 0 },
  ],
  activities: [
    { accountId: "a", key: "VTI", date: "2026-03-02", shareChange: 5, cashFlow: -500, purchase: true },
    { accountId: "a", key: "VTI", date: "2026-06-01", shareChange: 0, cashFlow: 20 },
    { accountId: "a", key: "OLD", date: "2025-06-01", shareChange: -4, cashFlow: 400 },
  ],
  historyStarts: new Map([["a", "2025-01-01"]]),
  closes: new Map([
    [
      "VTI",
      [
        { date: "2025-12-30", close: 88 },
        { date: "2025-12-31", close: 90 },
        { date: "2026-03-02", close: 100 },
      ],
    ],
  ]),
  today,
};

const result = holdingReturns(input, "2025-12-31");
assert.equal(result.missing, 1);
assert.equal(result.partial, false);
assert.equal(result.holdings.length, 1);
const [vti] = result.holdings;
assert.equal(vti.key, "VTI");
// 1,100 now − 450 at the start − 500 bought + 20 in dividends.
near(vti.gain, 170, "gain");
near(vti.startValue, 450, "start value");
near(vti.invested, 500, "invested");
near(returnRate(result.holdings), 170 / (450 + 250), "rate");
assert.equal(returnRate([]), null);

// History starting after the period start: only the covered part counts.
const late = holdingReturns({ ...input, historyStarts: new Map([["a", "2026-01-01"]]) }, "2025-06-30");
assert.equal(late.partial, true);
near(late.holdings[0].gain, 170, "gain from the history start");

console.log("returns checks passed");
