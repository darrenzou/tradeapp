// Checks the Spending page's calculations with made-up transactions: how
// Plaid categories become spending, income, gifts, and transfers; the
// federal tax estimate; and yearly stock appreciation. No network or
// credentials needed.
//
//   node tests/spending/check-spending.mjs

import assert from "node:assert/strict";

import { yearlyAppreciation } from "../../lib/appreciation.ts";
import { buildCashflow } from "../../lib/cashflow.ts";
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
      // Unexplained deposit: a gift.
      tx({ amount: -250, name: "Zelle from Grandma", primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER", date: "2025-05-14" }),
      // Money from a brokerage is not a gift.
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
  assert.equal(may.gifts, 250);
  assert.deepEqual(flows.gifts.map((gift) => gift.name), ["Zelle from Grandma"]);
  assert.equal(flows.income.find((entry) => entry.name === "Acme Payroll").amount, 2700);
  assert.equal(flows.income.find((entry) => entry.name === "Acme Payroll").source, "Paychecks");
  assert.equal(flows.income.find((entry) => entry.amount === 800).taxable, false);
  assert.equal(flows.months[0].spending, 0);
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

console.log("Spending checks passed.");
