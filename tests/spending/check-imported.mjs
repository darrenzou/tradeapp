// Checks transactions imported from a bank's CSV download: reading the file,
// guessing Plaid-style categories from the bank's wording, and leaving out
// the ones Plaid already has. No network or credentials needed.
//
//   node tests/spending/check-imported.mjs

import assert from "node:assert/strict";

import { buildCashflow } from "../../lib/cashflow.ts";
import { categorizeImported, guessInstitution, importedBefore, parseBankCsv } from "../../lib/imported-transactions.ts";

const KEY = "plaid|Discover|Cashback Checking ••0042";

// Discover's download: separate Debit and Credit columns, newest first.
{
  const csv = [
    "Transaction Date,Transaction Description,Transaction Type,Debit,Credit,Balance",
    "09/30/2026,Interest Paid,Credit,0,$5.37,$2199.38",
    "09/15/2026,Early Pay BANK OF AM ACH from BANK OF AMERICA,Credit,0,\"$2,041.60\",$2194.01",
    "09/02/2026,ACH Withdrawal DUKEENERGY BILL PAY,Debit,$94.12,0,$152.41",
    "09/02/2026,ACH Withdrawal DUKEENERGY BILL PAY,Debit,$94.12,0,$246.53",
    ",Pending,Debit,$1.00,0,",
    "",
  ].join("\r\n");
  const parsed = parseBankCsv(`﻿${csv}`, KEY);

  assert.ok(!("error" in parsed));
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(
    parsed.transactions.map(({ date, description, amount }) => ({ date, description, amount })),
    [
      { date: "2026-09-30", description: "Interest Paid", amount: -5.37 },
      { date: "2026-09-15", description: "Early Pay BANK OF AM ACH from BANK OF AMERICA", amount: -2041.6 },
      { date: "2026-09-02", description: "ACH Withdrawal DUKEENERGY BILL PAY", amount: 94.12 },
      { date: "2026-09-02", description: "ACH Withdrawal DUKEENERGY BILL PAY", amount: 94.12 },
    ],
  );

  // Two identical rows stay two transactions, and the same file gives the
  // same ids every time.
  const ids = parsed.transactions.map((transaction) => transaction.id);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual(parseBankCsv(csv, KEY).transactions.map((transaction) => transaction.id), ids);
  assert.notDeepEqual(parseBankCsv(csv, "another account").transactions[0].id, ids[0]);
}

// One signed Amount column, ISO or short dates, and quoted descriptions.
{
  const parsed = parseBankCsv(
    'Date,Description,Amount\n2025-01-05,"Coffee, Bagels",-4.50\n1/6/25,Refund,(2.00)\n1/7/25,Deposit,100\n',
    KEY,
  );

  assert.deepEqual(
    parsed.transactions.map(({ date, description, amount }) => ({ date, description, amount })),
    [
      { date: "2025-01-05", description: "Coffee, Bagels", amount: 4.5 },
      { date: "2025-01-06", description: "Refund", amount: 2 },
      { date: "2025-01-07", description: "Deposit", amount: -100 },
    ],
  );
}

// The balance comes from the newest row, whichever way the file is sorted;
// the last 4 digits from an account number column when there is one.
{
  const discover = parseBankCsv(
    "Transaction Date,Transaction Description,Transaction Type,Debit,Credit,Balance\n09/30/2026,Interest Paid,Credit,0,$5.37,$2199.38\n08/31/2026,Interest Paid,Credit,0,$4.15,$2194.01\n",
    KEY,
  );
  assert.equal(discover.balance, 2199.38);
  assert.equal(discover.mask, null);

  const card = parseBankCsv(
    "Date,Description,Amount,Account Number,Running Balance\n2026-01-02,Coffee,-4.50,XXXX-XXXX-XXXX-4412,104.50\n2026-01-09,Lunch,-12.00,XXXX-XXXX-XXXX-4412,116.50\n",
    KEY,
  );
  assert.equal(card.balance, 116.5);
  assert.equal(card.mask, "4412");

  assert.equal(parseBankCsv("Date,Description,Amount\n2025-01-05,Coffee,-4.50\n", KEY).balance, null);
}

// The bank, guessed from the downloaded file's name.
{
  assert.equal(guessInstitution("Discover_a_division_of_Capital_One_N.A.-Statement-2026102.csv"), "Discover");
  assert.equal(guessInstitution("Chase1234_Activity_20261002.CSV"), "Chase");
  assert.equal(guessInstitution("stmt.csv"), null);
}

// Files that can't be read say why.
{
  assert.ok("error" in parseBankCsv("", KEY));
  assert.ok("error" in parseBankCsv("Date,Amount\n2025-01-05,4", KEY));
  assert.ok("error" in parseBankCsv("Date,Description,Amount\n", KEY));
}

// Categories from the bank's wording. Positive amounts left the account.
{
  const detailed = (description, amount) => categorizeImported(description, amount).detailed;

  assert.equal(detailed("Interest Paid", -5), "INCOME_INTEREST_EARNED");
  assert.equal(detailed("Early Pay BANK OF AM ACH from BANK OF AMERICA", -2041), "INCOME_WAGES");
  assert.equal(detailed("Early Pay TAX REF ACH from IRS TREAS 310", -2800), "INCOME_TAX_REFUND");
  assert.equal(detailed("Early Pay NJSTTAXRFD ACH from STATE OF N.J.", -63), "INCOME_TAX_REFUND");
  assert.equal(detailed("ACH Withdrawal DUKEENERGY BILL PAY", 94), "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY");
  assert.equal(detailed("ACH Withdrawal BILTPYMTS RENT PMT", 2777), "RENT_AND_UTILITIES_RENT");
  assert.equal(detailed("ACH Withdrawal WF Credit Card AUTO PAY", 500), "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");
  assert.equal(detailed("BANK OF AMERICA ONLINE PMT", 400), "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");
  assert.equal(detailed("ACH Withdrawal SCHWAB BROKERAGE MONEYLINK", 6000), "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS");
  assert.equal(detailed("ACH Deposit From Webull Financial", -900), "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS");
  assert.equal(detailed("Transfer From ONLINE SAVINGS 1234", -800), "TRANSFER_IN_SAVINGS");
  assert.equal(detailed("Zelle Payment From A FRIEND", -50), "TRANSFER_IN_ACCOUNT_TRANSFER");
  assert.equal(detailed("ACH Withdrawal VENMO PAYMENT", 15), "TRANSFER_OUT_ACCOUNT_TRANSFER");
  assert.equal(detailed("Check Deposit", -10000), "TRANSFER_IN_DEPOSIT");
  assert.equal(detailed("ACH Withdrawal Bank of America NA", 750), "TRANSFER_OUT_ACCOUNT_TRANSFER");
  // Unknown payees and payers stay uncategorized, as Plaid would leave them.
  assert.equal(detailed("ACH Withdrawal ROOMORS LIVING I FUNDING", 2425.99), null);
  assert.equal(detailed("ACH Deposit From ACME CORP", -1200), null);
  // Money in never reads as a paycheck from wording on money out, and the
  // other way round.
  assert.equal(detailed("Payroll correction", 100), null);
}

// Only imports older than the account's oldest Plaid transaction are kept.
{
  const rows = [
    { id: "a", date: "2026-06-30", description: "Old", amount: 1 },
    { id: "b", date: "2026-07-01", description: "Overlap", amount: 1 },
    { id: "c", date: "2026-08-15", description: "Overlap", amount: 1 },
  ];

  assert.deepEqual(importedBefore(rows, ["2026-09-01", "2026-07-01"]).map((row) => row.id), ["a"]);
  assert.deepEqual(importedBefore(rows, []).map((row) => row.id), ["a", "b", "c"]);
}

// A tax refund the bank releases early isn't a paycheck.
{
  const flows = buildCashflow(
    [
      {
        id: "refund",
        accountId: "plaid:discover",
        accountKind: "depository",
        accountName: "Cashback Checking ••0042",
        date: "2026-04-10",
        amount: -2800,
        name: "IRS",
        description: "Early Pay TAX REF ACH from IRS TREAS 310",
        primary: "INCOME",
        detailed: "INCOME_TAX_REFUND",
        pending: false,
        currency: "USD",
      },
    ],
    "2026-04",
    "2026-04",
  );

  assert.equal(flows.income[0].source, "Tax refunds");
}

console.log("Imported transaction checks passed.");
