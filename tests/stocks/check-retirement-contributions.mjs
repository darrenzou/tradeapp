// Checks how 401(k) and Roth IRA accounts are recognized and how this year's
// contributions add up by account. No network or credentials needed.
//
//   node tests/stocks/check-retirement-contributions.mjs

import assert from "node:assert/strict";

import {
  classifyDeposit,
  parseEmployerMatch,
  parseEmployerMatches,
  retirementPlanOf,
  splitEmployerMatch,
  summarizeContributions,
} from "../../lib/retirement-contributions.ts";

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

// Employer match: 100% of the first 5% of a $87,550 salary paid twice a
// month is $182.40 a paycheck.
{
  const match = { salary: 87550, percent: 5 };
  const split = splitEmployerMatch(
    [
      // A paycheck of 5% from each side: the match is half.
      { date: "2026-01-15", amount: 354.16 },
      // A few cents two days later belong to the same pay period's paycheck.
      { date: "2026-01-16", amount: 0.08 },
      // Paid on the 30th; the deposit for the 31st landing on the 2nd of the
      // next month belongs to the same half.
      { date: "2026-01-30", amount: 1327.84 },
      // A deposit off payday, in the same half as a paycheck: the employer's.
      { date: "2026-02-24", amount: 761.46 },
      { date: "2026-02-27", amount: 1327.84 },
      { date: "2026-04-02", amount: 1327.84 },
      // One paycheck split across two funds.
      { date: "2026-09-30", amount: 663.94 },
      { date: "2026-09-30", amount: 663.93 },
    ],
    match,
  );
  // Employer: 177.08 + 0.08 + 182.40 × 4 + 761.46.
  assert.deepEqual(split, { employee: 4758.87, employer: 1668.22 });

  assert.deepEqual(parseEmployerMatch({ salary: 87550, percent: 5 }), match);
  assert.equal(parseEmployerMatch({ salary: 0, percent: 5 }), null);
  assert.equal(parseEmployerMatch({ salary: 87550, percent: 120 }), null);
  assert.equal(parseEmployerMatch({ salary: "87550", percent: 5 }), null);
  assert.deepEqual(parseEmployerMatches({ "plaid:k1": match, "plaid:k2": { salary: -1, percent: 5 } }), {
    "plaid:k1": match,
  });
  assert.deepEqual(parseEmployerMatches(null), {});

  // In the summary: the account and plan show the split and the limit; an
  // account with nothing this year doesn't need a match.
  const result = summarizeContributions(
    accounts,
    [
      { accountId: "plaid:k1", date: "2026-01-15", amount: 354.16, description: null },
      { accountId: "plaid:k1", date: "2026-02-24", amount: 761.46, description: null },
      { accountId: "plaid:k1", date: "2026-02-27", amount: 1327.84, description: null },
    ],
    2026,
    new Set(["plaid:k1", "plaid:k2", "snaptrade:r1"]),
    { "plaid:k1": match, "snaptrade:r1": match },
  );
  const [k401, roth] = result.plans;
  assert.equal(k401.total, 2443.46);
  assert.equal(k401.employee, 1322.52);
  assert.equal(k401.employer, 1120.94);
  assert.equal(k401.employeeLimit, 24500);
  assert.deepEqual(k401.accounts[0].match, match);
  assert.equal(k401.accounts[0].employee, 1322.52);
  assert.equal(k401.accounts[1].employee, undefined);
  // Roth IRAs have no employer match.
  assert.equal(roth.employee, undefined);
  assert.equal(roth.accounts[0].match, undefined);
  assert.equal(roth.employeeLimit, undefined);

  // Without a match on every account that had money, the plan isn't split.
  const partial = summarizeContributions(
    accounts,
    [
      { accountId: "plaid:k1", date: "2026-01-15", amount: 354.16, description: null },
      { accountId: "plaid:k2", date: "2026-01-15", amount: 100, description: null },
    ],
    2026,
    new Set(["plaid:k1", "plaid:k2"]),
    { "plaid:k1": match },
  );
  assert.equal(partial.plans[0].employee, undefined);
  assert.equal(partial.plans[0].accounts.find((row) => row.accountId === "plaid:k1").employee, 177.08);
}

console.log("Retirement contributions checks passed.");
