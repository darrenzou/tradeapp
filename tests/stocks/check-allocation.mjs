// Checks how holdings are sorted into asset classes and regions, how
// allocation targets are read, and the risk estimates. No network or
// credentials needed.
//
//   node tests/stocks/check-allocation.mjs

import assert from "node:assert/strict";

import { buildAllocation, classifyHolding, isSingleStock } from "../../lib/asset-classes.ts";
import { estimateRisk, parseAllocationTargets, TARGET_PRESETS } from "../../lib/allocation-targets.ts";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

// Funds on the list count by their usual mix.
assert.deepEqual(classifyHolding({ ticker: "VTI", name: "Vanguard Total Stock Market ETF", securityType: "etf" }).mix, { us: 1 });
assert.deepEqual(classifyHolding({ ticker: "bnd", name: "", securityType: "etf" }).mix, { bonds: 1 });
const vt = classifyHolding({ ticker: "VT", name: "", securityType: "etf" });
assert.deepEqual(vt.mix, { us: 0.62, intl: 0.38 });
near(vt.regions.us, 0.62, "VT US share");
near(vt.regions.developed, 0.38 * 0.75, "VT developed share");

// Single stocks are US unless listed as foreign.
assert.deepEqual(classifyHolding({ ticker: "AAPL", name: "Apple Inc.", securityType: "equity" }), {
  mix: { us: 1 },
  regions: { us: 1 },
  basis: "type",
});
assert.deepEqual(classifyHolding({ ticker: "TSM", name: "Taiwan Semiconductor", securityType: "equity" }).regions, { emerging: 1 });
assert.equal(isSingleStock({ ticker: "AAPL", securityType: "equity" }), true);
assert.equal(isSingleStock({ ticker: "VTI", securityType: "etf" }), false);

// 401(k) funds without a ticker are placed by name; unknown ones are Other.
assert.equal(classifyHolding({ ticker: null, name: "Fidelity 500 Index Fund", securityType: "mutual fund" }).basis, "name");
assert.deepEqual(classifyHolding({ ticker: null, name: "PIMCO Total Return Bond Fund", securityType: "mutual fund" }).mix, { bonds: 1 });
assert.deepEqual(
  classifyHolding({ ticker: null, name: "Vanguard Target Retirement 2055 Trust", securityType: "mutual fund" }).mix,
  { us: 0.54, intl: 0.36, bonds: 0.1 },
);
assert.deepEqual(classifyHolding({ ticker: "ZZZQX", name: "Mystery Fund", securityType: "mutual fund" }), {
  mix: { other: 1 },
  regions: {},
  basis: "unknown",
});

// The whole portfolio, with cash and accounts whose holdings didn't load.
const allocation = buildAllocation(
  [
    { key: "VTI", ticker: "VTI", name: "Vanguard Total Stock Market ETF", securityType: "etf", marketValue: 600 },
    { key: "VXUS", ticker: "VXUS", name: "Vanguard Total International Stock ETF", securityType: "etf", marketValue: 200 },
    { key: "AAPL", ticker: "AAPL", name: "Apple Inc.", securityType: "equity", marketValue: 100 },
    { key: "BND", ticker: "BND", name: "Vanguard Total Bond Market ETF", securityType: "etf", marketValue: 50 },
    { key: "GONE", ticker: "GONE", name: "Sold", securityType: "equity", marketValue: 0 },
  ],
  30,
  20,
);
assert.equal(allocation.total, 1000);
assert.deepEqual(
  allocation.classes.map((item) => [item.id, item.value, item.holdings.map((holding) => holding.key)]),
  [
    ["us", 700, ["VTI", "AAPL"]],
    ["intl", 200, ["VXUS"]],
    ["bonds", 50, ["BND"]],
    ["cash", 30, []],
    ["other", 20, []],
  ],
);
near(allocation.singleStocks, 0.1, "single stocks share");
near(allocation.regions[0].share, 700 / 900, "US region share");
near(allocation.regions[1].share, 150 / 900, "developed region share");
near(allocation.regions[2].share, 50 / 900, "emerging region share");

// Targets must be whole percents adding up to 100.
assert.deepEqual(parseAllocationTargets({ us: 60, intl: 25, bonds: 10, cash: 5 }), { us: 60, intl: 25, bonds: 10, cash: 5 });
assert.equal(parseAllocationTargets({ us: 60, intl: 25, bonds: 10, cash: 4 }), null);
assert.equal(parseAllocationTargets({ us: 60.5, intl: 24.5, bonds: 10, cash: 5 }), null);
assert.equal(parseAllocationTargets({ us: 60, intl: 25, bonds: 15 }), null);
assert.equal(parseAllocationTargets(null), null);
for (const preset of TARGET_PRESETS) {
  assert.deepEqual(parseAllocationTargets(preset.targets), preset.targets, preset.label);
}

// A mostly-stock mix: high volatility, a bad year well below zero.
const growth = estimateRisk({ us: 0.6, intl: 0.25, bonds: 0.1, cash: 0.05 });
assert.ok(growth.expectedReturn > 6 && growth.expectedReturn < 7, `growth return ${growth.expectedReturn}`);
assert.equal(growth.level, "High");
assert.ok(growth.badYear < -15, `growth bad year ${growth.badYear}`);
const cautious = estimateRisk({ us: 0.3, intl: 0.1, bonds: 0.5, cash: 0.1 });
assert.ok(cautious.volatility < growth.volatility);
assert.ok(cautious.expectedReturn < growth.expectedReturn);
assert.equal(estimateRisk({ cash: 1 }).level, "Low");

console.log("allocation checks passed");
