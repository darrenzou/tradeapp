// Checks the Spending page's rough federal tax estimate: brackets less the
// standard deduction, and the nearest year's table when a year has none. No
// network or credentials needed.
//
//   node tests/spending/check-federal-tax.mjs

import assert from "node:assert/strict";

import { estimateFederalTax } from "../../lib/federal-tax.ts";

// $100,000, single, 2026: $83,900 taxable across the 10, 12 and 22% brackets.
{
  const estimate = estimateFederalTax(100_000, 2026, "single");
  assert.equal(estimate.taxableIncome, 83_900);
  assert.equal(estimate.tax, 1_240 + 4_560 + 7_370);
  assert.equal(estimate.effectiveRate, 0.1317);
  assert.equal(estimate.bracketYear, 2026);
}

// Above the last bound, the rest is taxed at 37%.
assert.equal(estimateFederalTax(1_000_000, 2026, "single").tax, 320_000.25);

// Income under the standard deduction owes nothing; no income has no rate.
assert.equal(estimateFederalTax(10_000, 2026, "married_joint").tax, 0);
assert.equal(estimateFederalTax(0, 2026, "single").effectiveRate, null);

// Years without a table use the nearest one.
assert.equal(estimateFederalTax(50_000, 2030, "single").bracketYear, 2026);
assert.equal(estimateFederalTax(50_000, 2020, "head_of_household").bracketYear, 2023);

console.log("Federal tax checks passed.");
