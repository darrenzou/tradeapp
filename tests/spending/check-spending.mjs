// Checks the Spending page's calculations with made-up transactions: how
// Plaid categories become spending, income, other income, and transfers; the
// federal tax estimate; and yearly stock appreciation. No network or
// credentials needed.
//
//   node tests/spending/check-spending.mjs

import assert from "node:assert/strict";

import { monthlyAppreciation, yearlyAppreciation } from "../../lib/appreciation.ts";
import {
  buildCashflow,
  listMonthTransactions,
  similarKey,
  similarRuleKey,
  transactionRuleKey,
} from "../../lib/cashflow.ts";
import { estimateFederalTax } from "../../lib/federal-tax.ts";

let id = 0;
function tx(overrides) {
  id += 1;
  return {
    id: `t${id}`,
    accountId: "checking",
    accountKind: "depository",
    accountName: "Checking ••1234",
    date: "2025-05-10",
    amount: 0,
    name: "Transaction",
    primary: null,
    detailed: null,
    pending: false,
    currency: "USD",
    ...overrides,
  };
}

// Cashflow classification
{
  const flows = buildCashflow(
    [
      tx({ amount: -2700, name: "Acme Payroll", primary: "INCOME", detailed: "INCOME_WAGES" }),
      tx({ amount: -1.25, primary: "INCOME", detailed: "INCOME_INTEREST_EARNED" }),
      tx({ amount: -800, primary: "INCOME", detailed: "INCOME_TAX_REFUND", date: "2025-05-20" }),
      tx({ amount: 60, accountId: "card", accountKind: "credit", primary: "FOOD_AND_DRINK" }),
      tx({ amount: -10, accountId: "card", accountKind: "credit", primary: "FOOD_AND_DRINK" }),
      tx({ amount: 1500, primary: "RENT_AND_UTILITIES" }),
      // Card payment: checking side and card side.
      tx({ amount: 500, primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
      tx({ amount: -500, accountId: "card", accountKind: "credit", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }),
      // Transfer between own linked accounts: savings out, checking in.
      tx({ amount: 1000, accountId: "savings", primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER", date: "2025-05-11" }),
      tx({ amount: -1000, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", date: "2025-05-12" }),
      // Unexplained deposit: other income.
      tx({ amount: -250, name: "Zelle from Grandma", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", date: "2025-05-14" }),
      // Money from a brokerage is a transfer, not income.
      tx({ amount: -3000, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" }),
      // Pending and out-of-window transactions are ignored.
      tx({ amount: 99, primary: "GENERAL_MERCHANDISE", pending: true }),
      tx({ amount: 99, primary: "GENERAL_MERCHANDISE", date: "2022-01-01" }),
    ],
    "2025-04",
    "2025-05",
  );

  assert.equal(flows.months.length, 2);
  const may = flows.months[1];
  assert.equal(may.month, "2025-05");
  assert.equal(may.income, 3501.25);
  assert.equal(may.spending, 1550);
  assert.deepEqual(may.categories, { "Rent & utilities": 1500, "Food & drink": 50 });
  assert.equal(may.other, 250);
  assert.deepEqual(flows.other.map((entry) => entry.name), ["Zelle from Grandma"]);
  assert.equal(flows.other[0].source, "Other income");
  assert.equal(flows.income.find((entry) => entry.name === "Acme Payroll").amount, 2700);
  assert.equal(flows.income.find((entry) => entry.name === "Acme Payroll").source, "Paychecks");
  assert.equal(flows.income.find((entry) => entry.amount === 800).taxable, false);
  assert.equal(flows.months[0].spending, 0);
}

// A month's transaction list uses the same classification as the totals.
{
  const listed = listMonthTransactions(
    [
      tx({ id: "coffee", amount: 5.5, primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE", date: "2025-05-03" }),
      tx({ id: "pending", amount: 20, primary: "GENERAL_MERCHANDISE", pending: true, date: "2025-05-04" }),
      tx({ id: "other", amount: -100, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT", date: "2025-05-02" }),
      tx({ id: "april", amount: 9, primary: "FOOD_AND_DRINK", date: "2025-04-30" }),
    ],
    "2025-05",
  );

  assert.deepEqual(listed.map((entry) => entry.id), ["pending", "coffee", "other"]);
  assert.equal(listed[1].category, "Food & drink");
  assert.equal(listed[1].detail, "Coffee");
  assert.equal(listed[2].kind, "other");
  assert.equal(listed[2].category, "Other income");
  assert.equal(listed[0].pending, true);
}

// Categories the user picked: for all transactions between the same account
// and other party (reference numbers and dates in the description don't
// matter), or for one transaction, which wins.
{
  const transfers = [
    tx({ id: "sep", amount: 500, name: "Online Transfer to SAV ...5678 transaction#: 1111 09/12", date: "2025-05-12" }),
    tx({ id: "oct", amount: 250, name: "Online Transfer to SAV ...5678 transaction#: 2222 10/03", date: "2025-05-20" }),
    // Same account and other party, but money coming back: not like the others.
    tx({ id: "back", amount: -80, name: "Online Transfer from SAV ...5678 transaction#: 3333", date: "2025-05-21" }),
    // Same description in another account.
    tx({ id: "card", amount: 40, accountId: "card", accountKind: "credit", accountName: "Card ••9999", name: "Online Transfer to SAV ...5678 transaction#: 4444", date: "2025-05-22" }),
    // The savings side of the first transfer.
    tx({ id: "sep-in", amount: -500, accountId: "savings", accountName: "Savings ••5678", name: "Transfer from CHK", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT", date: "2025-05-13" }),
  ];

  assert.equal(similarKey(transfers[0]), similarKey(transfers[1]));
  assert.notEqual(similarKey(transfers[0]), similarKey(transfers[2]));
  assert.notEqual(similarKey(transfers[0]), similarKey(transfers[3]));

  // Without rules, the uncategorized payments out of checking count as
  // spending (only the savings deposit is matched as a transfer).
  const before = buildCashflow(transfers, "2025-05", "2025-05").months[0];
  assert.equal(before.spending, 790);
  assert.equal(before.other, 80);

  const rules = {
    [similarRuleKey(similarKey(transfers[0]))]: "TRANSFER",
    [similarRuleKey(similarKey(transfers[4]))]: "TRANSFER",
    [transactionRuleKey("oct")]: "FOOD_AND_DRINK",
  };
  const [may] = buildCashflow(transfers, "2025-05", "2025-05", rules).months;
  assert.deepEqual(may.categories, { "Food & drink": 250, Other: 40 });
  assert.equal(may.spending, 290);
  assert.equal(may.other, 80);

  const listed = listMonthTransactions(transfers, "2025-05", rules);
  const byId = Object.fromEntries(listed.map((entry) => [entry.id, entry]));
  assert.equal(byId.sep.kind, "transfer");
  assert.equal(byId.sep.setBy, "similar");
  assert.equal(byId.oct.category, "Food & drink");
  assert.equal(byId.oct.setBy, "transaction");
  assert.equal(byId.card.setBy, null);
  // The savings deposit is suggested as the other side of the first transfer.
  assert.equal(byId.sep.counterpart?.id, "sep-in");
  assert.equal(byId["sep-in"].counterpart?.id, "sep");
  assert.equal(byId.oct.counterpart, null);

  // Picked income sources and other income count as income.
  const [income] = buildCashflow(transfers, "2025-05", "2025-05", {
    [transactionRuleKey("sep-in")]: "INCOME_WAGES",
    [transactionRuleKey("back")]: "OTHER_INCOME",
  }).months;
  assert.equal(income.income, 500);
  assert.equal(income.other, 80);
}

// Brokerage cash (SnapTrade or Plaid): interest is income and dividends are
// totaled on their own; money moved between a brokerage and a bank is a
// transfer on both sides.
{
  const brokerage = { accountId: "snaptrade:ira", accountKind: "brokerage", accountName: "Schwab IRA" };
  const flows = buildCashflow(
    [
      tx({ ...brokerage, id: "div", amount: -42.5, name: "VTI dividend", primary: "INCOME", detailed: "INCOME_DIVIDENDS" }),
      tx({ ...brokerage, id: "int", amount: -3.1, name: "Interest", primary: "INCOME", detailed: "INCOME_INTEREST_EARNED" }),
      // Withdrawal to the bank, which Plaid labels as a plain deposit.
      tx({ ...brokerage, amount: 2000, primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", date: "2025-05-05" }),
      tx({ id: "withdrawal-in", amount: -2000, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT", date: "2025-05-07" }),
      // Money added from the bank with no Plaid category.
      tx({ ...brokerage, amount: -500, primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", date: "2025-05-20" }),
      tx({ id: "contribution-out", amount: 500, name: "ACH SCHWAB", date: "2025-05-19" }),
    ],
    "2025-05",
    "2025-05",
  );
  const [may] = flows.months;

  assert.equal(may.income, 3.1);
  assert.equal(may.dividends, 42.5);
  assert.equal(may.other, 0);
  assert.equal(may.spending, 0);
  assert.deepEqual(flows.income.map((entry) => entry.source), ["Interest"]);
  assert.deepEqual(flows.dividends.map((entry) => entry.name), ["VTI dividend"]);
  assert.equal([...flows.income, ...flows.dividends].every((entry) => entry.taxable), true);
}

// Bilt: rent charged to the Bilt card, the card paid from checking. Neither
// the card credit nor the bank payment is income or a second rent charge.
{
  const bilt = { accountId: "bilt", accountKind: "credit", accountName: "Bilt World Elite Mastercard ••0001" };
  const flows = buildCashflow(
    [
      tx({ ...bilt, amount: 2000, name: "Bilt Rent", primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" }),
      tx({ ...bilt, amount: -2000, name: "BILT PAYMENT", primary: "INCOME", detailed: "INCOME_OTHER_INCOME" }),
      tx({ amount: 2000, name: "BILT HOUSING PAYMENT", primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" }),
      tx({ amount: -150, name: "BILT REWARDS", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT" }),
      // As Plaid reports Bilt's instant rent payment on the card.
      tx({ ...bilt, accountName: "Bilt Blue Card ••8207", amount: -2776.25, name: "Payment - Bilt Housing", primary: "INCOME", detailed: "INCOME_RENTAL" }),
      // Any other credit on a card is a payment or refund, not income.
      tx({ ...bilt, amount: -40, name: "Statement credit", primary: "INCOME", detailed: "INCOME_OTHER_INCOME" }),
    ],
    "2025-05",
    "2025-05",
  );
  const [may] = flows.months;

  assert.equal(may.spending, 2000);
  assert.equal(may.income, 0);
  assert.equal(may.other, 0);
  assert.equal(flows.income.length, 0);
}

// Without a linked Bilt card, a bank payment to Bilt is the only record of
// the rent, so it stays spending.
{
  const [may] = buildCashflow(
    [tx({ amount: 1800, name: "BILT HOUSING PAYMENT", primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" })],
    "2025-05",
    "2025-05",
  ).months;
  assert.equal(may.spending, 1800);
}

// Paychecks without an income label: a direct deposit into a brokerage cash
// account (e.g. Fidelity CMA) or a bank deposit Plaid calls a transfer.
{
  const cma = { accountId: "plaid:cma", accountKind: "brokerage", accountName: "Fidelity Cash Management" };
  const flows = buildCashflow(
    [
      tx({ ...cma, amount: -3000, name: "DIRECT DEPOSIT ACME CORP PAYROLL", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" }),
      tx({ ...cma, amount: -200, name: "Money added", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" }),
      tx({ amount: -2500, name: "DIR DEP ACME CORP", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT" }),
    ],
    "2025-05",
    "2025-05",
  );
  const [may] = flows.months;

  assert.equal(may.income, 5500);
  assert.equal(may.other, 200);
  assert.deepEqual(flows.income.map((entry) => entry.source), ["Paychecks", "Paychecks"]);
}

// Federal tax: 2025 single, $100,000 of income.
{
  const estimate = estimateFederalTax(100_000, 2025, "single");
  // Taxable 84,250: 1,192.50 + 4,386 + 7,870.50 = 13,449
  assert.equal(estimate.taxableIncome, 84_250);
  assert.equal(estimate.tax, 13_449);
  assert.equal(estimateFederalTax(10_000, 2025, "single").tax, 0);
  assert.equal(estimateFederalTax(50_000, 2031, "single").bracketYear, 2026);
}

// Stock appreciation
{
  const closes = new Map([
    [
      "VTI",
      [
        { date: "2024-12-31", close: 100 },
        { date: "2025-03-03", close: 110 },
        { date: "2025-12-31", close: 120 },
      ],
    ],
  ]);
  const years = yearlyAppreciation({
    positions: [{ accountId: "a", key: "VTI", ticker: "VTI", quantity: 15, currentValue: 1950 }],
    // 10 shares held all 2025; 5 more bought in March at 110.
    activities: [{ accountId: "a", key: "VTI", date: "2025-03-03", shareChange: 5, cashFlow: -550 }],
    historyStarts: new Map([["a", "2024-01-01"]]),
    closes,
    years: [2025, 2026],
    today: "2026-06-30",
  });

  // 2025: 15 × 120 − 10 × 100 − 550 = 250
  assert.deepEqual(years[0], { year: 2025, amount: 250, status: "complete", note: null });
  // 2026 so far: 1950 − 1800 = 150
  assert.equal(years[1].amount, 150);

  const late = yearlyAppreciation({
    positions: [{ accountId: "a", key: "VTI", ticker: "VTI", quantity: 15, currentValue: 1950 }],
    activities: [],
    historyStarts: new Map([["a", "2025-06-01"]]),
    closes,
    years: [2024, 2025],
    today: "2026-06-30",
  });
  assert.equal(late[0].status, "unavailable");
  assert.equal(late[1].status, "partial");
}

// Monthly appreciation adds up to the year when every month is covered.
{
  const closes = new Map([
    [
      "VTI",
      [
        { date: "2024-12-31", close: 100 },
        { date: "2025-01-31", close: 105 },
        { date: "2025-02-28", close: 102 },
      ],
    ],
  ]);
  const months = monthlyAppreciation(
    {
      positions: [{ accountId: "a", key: "VTI", ticker: "VTI", quantity: 10, currentValue: 1020 }],
      activities: [],
      historyStarts: new Map([["a", "2024-01-01"]]),
      closes,
      today: "2025-03-01",
    },
    ["2025-01", "2025-02"],
  );

  assert.deepEqual(months.map((month) => month.amount), [50, -30]);
  assert.equal(months[0].status, "complete");
}

console.log("Spending checks passed.");
