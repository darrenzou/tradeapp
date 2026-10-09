// Checks how an account's transactions are listed on the Overview: SnapTrade
// and Plaid investment activity become readable rows with money in positive,
// and the list pages newest first. No network or credentials needed.
//
//   node tests/accounts/check-account-history.mjs

import assert from "node:assert/strict";

import {
  fromPlaidInvestmentTransaction,
  fromSnapTradeActivity,
  pageOf,
  sortNewestFirst,
} from "../../lib/account-history.ts";

const ACCOUNT = "snaptrade:abc";

// SnapTrade: trades show shares and price, dividends name the stock, and
// cash moves keep the brokerage's wording.
{
  const buy = fromSnapTradeActivity(
    { id: "1", type: "BUY", symbol: { symbol: "AAPL" }, units: 10, price: 150, amount: -1500, trade_date: "2026-03-02T14:30:00Z" },
    ACCOUNT,
    0,
  );
  assert.deepEqual(
    { description: buy.description, detail: buy.detail, amount: buy.amount, date: buy.date },
    { description: "Bought AAPL", detail: "10 shares at $150.00", amount: -1500, date: "2026-03-02" },
  );

  const dividend = fromSnapTradeActivity(
    { id: "2", type: "DIVIDEND", symbol: { symbol: "VTI" }, amount: 12.5, description: "VANGUARD TOTAL STK MKT", trade_date: "2026-03-20" },
    ACCOUNT,
    1,
  );
  assert.equal(dividend.description, "VTI dividend");
  assert.equal(dividend.detail, "VANGUARD TOTAL STK MKT");
  assert.equal(dividend.amount, 12.5);

  const deposit = fromSnapTradeActivity(
    { type: "CONTRIBUTION", amount: 2000, description: "DIRECT DEPOSIT ACME PAYROLL", settlement_date: "2026-03-15" },
    ACCOUNT,
    2,
  );
  assert.equal(deposit.description, "DIRECT DEPOSIT ACME PAYROLL");
  assert.equal(deposit.detail, "Money added");
  assert.equal(deposit.id, `${ACCOUNT}:2026-03-15:CONTRIBUTION:2`);

  const fee = fromSnapTradeActivity({ id: "4", type: "FEE", amount: -5, trade_date: "2026-03-01" }, ACCOUNT, 3);
  assert.equal(fee.description, "Fee");
  assert.equal(fee.detail, null);

  assert.equal(fromSnapTradeActivity({ id: "5", type: "BUY" }, ACCOUNT, 4), null);
}

// Plaid investments: amounts are flipped so cash leaving the account is negative.
{
  const base = {
    account_id: "p1",
    security_id: "s1",
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    fees: 0,
  };
  const buy = fromPlaidInvestmentTransaction(
    { ...base, investment_transaction_id: "i1", date: "2026-02-03", name: "BUY VOO", quantity: 2, price: 500, amount: 1000, type: "buy", subtype: "buy" },
    { security_id: "s1", ticker_symbol: "VOO" },
  );
  assert.deepEqual(
    { id: buy.id, accountId: buy.accountId, description: buy.description, detail: buy.detail, amount: buy.amount },
    { id: "plaid:i1", accountId: "plaid:p1", description: "Bought VOO", detail: "2 shares at $500.00", amount: -1000 },
  );

  const dividend = fromPlaidInvestmentTransaction(
    { ...base, investment_transaction_id: "i2", date: "2026-02-10", name: "Dividend VOO", quantity: 0, price: 0, amount: -8.4, type: "cash", subtype: "qualified dividend" },
    { security_id: "s1", ticker_symbol: "VOO" },
  );
  assert.equal(dividend.description, "Dividend VOO");
  assert.equal(dividend.detail, "Qualified dividend");
  assert.equal(dividend.amount, 8.4);

  // A 401(k) paycheck contribution the plan reports as cash leaving for the
  // fund is money coming into the account.
  const contribution = fromPlaidInvestmentTransaction(
    { ...base, investment_transaction_id: "i3", date: "2026-09-30", name: "VANGUARD INSTL 500 INDEX", quantity: 0, price: 0, amount: 663.94, type: "cash", subtype: "withdrawal" },
    { security_id: "s2", ticker_symbol: null, name: "VANGUARD INSTL 500 INDEX" },
    true,
  );
  assert.equal(contribution.description, "VANGUARD INSTL 500 INDEX");
  assert.equal(contribution.detail, "Contribution");
  assert.equal(contribution.amount, 663.94);
}

// Paging: pending first, then newest first, 50 at a time.
{
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `t${String(index).padStart(3, "0")}`,
    accountId: "plaid:x",
    date: `2026-0${(index % 9) + 1}-10`,
    description: "Row",
    detail: null,
    amount: -1,
    currency: "USD",
    pending: index === 7,
  }));
  const sorted = sortNewestFirst(rows);
  assert.equal(sorted[0].id, "t007");
  assert.ok(sorted.slice(1).every((row, index, list) => index === 0 || list[index - 1].date >= row.date));

  const first = pageOf(sorted, 0);
  assert.equal(first.transactions.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.total, 120);

  const last = pageOf(sorted, 100);
  assert.equal(last.transactions.length, 20);
  assert.equal(last.nextOffset, null);
}

console.log("Account history checks passed.");
