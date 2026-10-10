// Checks how 401(k) and Roth IRA accounts are recognized and how this year's
// contributions add up by account. No network or credentials needed.
//
//   node tests/stocks/check-retirement-contributions.mjs

import assert from "node:assert/strict";

import { classifyDeposit, retirementPlanOf, summarizeContributions } from "../../lib/retirement-contributions.ts";

// Plaid subtypes, SnapTrade raw types, and account names.
assert.equal(retirementPlanOf("401k", "BANK OF AMERICA 401(K) PLAN"), "401k");
assert.equal(retirementPlanOf("roth 401k", "Roth"), "401k");
assert.equal(retirementPlanOf(null, "Merrill 401(k) Savings"), "401k");
assert.equal(retirementPlanOf("roth", "Roth IRA"), "rothIra");
assert.equal(retirementPlanOf("ROTH_IRA", "Robinhood"), "rothIra");
assert.equal(retirementPlanOf("Individual", "Robinhood Roth IRA"), "rothIra");
assert.equal(retirementPlanOf("ira", "Rollover IRA"), null);
assert.equal(retirementPlanOf("brokerage", "Individual"), null);
assert.equal(retirementPlanOf("MARGIN", "Account 4010"), null);

// Rollovers and prior-year contributions by the brokerage's wording.
assert.deepEqual(classifyDeposit({ date: "2026-07-20", description: "ROLLOVER CASH DIRECT ROLLOVER" }), { kind: "rollover" });
assert.deepEqual(classifyDeposit({ date: "2026-03-01", description: "Roth conversion" }), { kind: "rollover" });
assert.deepEqual(classifyDeposit({ date: "2026-04-14", description: "CASH CONTRIBUTION PRIOR YEAR" }), {
  kind: "contribution",
  taxYear: 2025,
});
assert.deepEqual(classifyDeposit({ date: "2026-04-14", description: "CASH CONTRIBUTION CURRENT YEAR" }), {
  kind: "contribution",
  taxYear: 2026,
});
assert.deepEqual(classifyDeposit({ date: "2026-05-01", description: "Electronic Funds Transfer Received" }), {
  kind: "contribution",
  taxYear: 2026,
});
assert.deepEqual(classifyDeposit({ date: "2026-05-01", description: null }), { kind: "contribution", taxYear: 2026 });
// A year in the wording names the tax year; a fund's name doesn't.
assert.deepEqual(classifyDeposit({ date: "2026-02-27", description: "2026 NONDEDUCT CONTRIB" }), {
  kind: "contribution",
  taxYear: 2026,
});
assert.deepEqual(classifyDeposit({ date: "2026-02-27", description: "2025 NONDEDUCT CONTRIB" }), {
  kind: "contribution",
  taxYear: 2025,
});
assert.deepEqual(classifyDeposit({ date: "2026-01-15", description: "VANGUARD TARGET RETIREMENT 2025" }), {
  kind: "contribution",
  taxYear: 2026,
});

const account = (id, name, retirementPlan) => ({
  id,
  source: "plaid",
  name,
  institution: "Bank",
  kind: "investment",
  balance: 1000,
  currency: "USD",
  ...(retirementPlan ? { retirementPlan } : {}),
});

const accounts = [
  account("plaid:k1", "Current 401(k)", "401k"),
  account("plaid:k2", "Old 401(k)", "401k"),
  account("snaptrade:r1", "Roth IRA", "rothIra"),
  account("snaptrade:b1", "Individual"),
];

const deposits = [
  // One paycheck split across two funds counts as one deposit.
  { accountId: "plaid:k1", date: "2026-01-15", amount: 400, description: null },
  { accountId: "plaid:k1", date: "2026-01-15", amount: 100.1, description: null },
  { accountId: "plaid:k1", date: "2026-01-31", amount: 500, description: null },
  // Last year's: left out.
  { accountId: "plaid:k1", date: "2025-12-31", amount: 500, description: null },
  { accountId: "snaptrade:r1", date: "2026-03-02", amount: 7000, description: null },
  // Not a retirement account.
  { accountId: "snaptrade:b1", date: "2026-03-02", amount: 2000, description: null },
  // Money out isn't a contribution.
  { accountId: "snaptrade:r1", date: "2026-04-01", amount: -50, description: null },
];

{
  const result = summarizeContributions(accounts, deposits, 2026, new Set(["plaid:k1", "plaid:k2", "snaptrade:r1"]));
  assert.equal(result.year, 2026);
  assert.deepEqual(
    result.plans.map((plan) => [plan.plan, plan.total, plan.complete]),
    [["401k", 1000.1, true], ["rothIra", 7000, true]],
  );

  const [k1, k2] = result.plans[0].accounts;
  assert.deepEqual(k1, {
    accountId: "plaid:k1",
    accountName: "Current 401(k)",
    institution: "Bank",
    total: 1000.1,
    count: 2,
    lastDate: "2026-01-31",
    rollovers: 0,
    priorYear: 0,
  });
  // Linked with nothing this year: listed at $0.
  assert.equal(k2.total, 0);
  assert.equal(k2.count, 0);
  assert.equal(k2.lastDate, null);
}

// An account whose history didn't load shows no total and marks the plan partial.
{
  const result = summarizeContributions(accounts, deposits, 2026, new Set(["plaid:k1"]));
  const [k401, roth] = result.plans;
  assert.equal(k401.complete, false);
  assert.equal(k401.total, 1000.1);
  assert.equal(k401.accounts.at(-1).total, null);
  assert.equal(roth.accounts[0].total, null);
  assert.equal(roth.total, 0);
}

// Rollovers and last year's contributions arrive this year but aren't counted
// in it; next year's April deposit for 2026 is.
{
  const roth = [account("snaptrade:r1", "Roth IRA", "rothIra")];
  const result = summarizeContributions(
    roth,
    [
      { accountId: "snaptrade:r1", date: "2026-04-14", amount: 6999.75, description: "CASH CONTRIBUTION PRIOR YEAR" },
      { accountId: "snaptrade:r1", date: "2026-07-20", amount: 10159.02, description: "ROLLOVER CASH DIRECT ROLLOVER" },
      { accountId: "snaptrade:r1", date: "2026-07-20", amount: 335.24, description: "ROLLOVER CASH DIRECT ROLLOVER" },
      { accountId: "snaptrade:r1", date: "2026-09-02", amount: 500, description: "CASH CONTRIBUTION CURRENT YEAR" },
      { accountId: "snaptrade:r1", date: "2027-04-01", amount: 1000, description: "CASH CONTRIBUTION PRIOR YEAR" },
      // Last year's rollover isn't this year's.
      { accountId: "snaptrade:r1", date: "2025-07-20", amount: 50, description: "ROLLOVER" },
    ],
    2026,
    new Set(["snaptrade:r1"]),
  );
  const [plan] = result.plans;
  assert.equal(plan.total, 1500);
  assert.equal(plan.rollovers, 10494.26);
  assert.equal(plan.priorYear, 6999.75);
  assert.equal(plan.accounts[0].count, 2);
  assert.equal(plan.accounts[0].lastDate, "2027-04-01");
}

// Only the kinds of accounts that are linked are listed.
{
  const result = summarizeContributions(accounts.slice(2), deposits, 2026, new Set(["snaptrade:r1"]));
  assert.deepEqual(result.plans.map((plan) => plan.plan), ["rothIra"]);
  assert.deepEqual(summarizeContributions([], deposits, 2026, new Set()).plans, []);
}

console.log("Retirement contributions checks passed.");
