// Checks reading transactions from bank and card statement PDFs. The PDFs in
// fixtures/ are made-up statements laid out the ways banks commonly do it;
// each .json next to one is what it should read as. No network or
// credentials needed.
//
//   node tests/spending/check-statement-pdf.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getDocumentProxy } from "unpdf";

import { combinedCsv, parseStatementLines, pdfLines } from "../../lib/bank-statement.ts";
import { parseBankCsv } from "../../lib/imported-transactions.ts";

// The same steps as app/bank-files.ts, in Node.
async function statementLines(path) {
  const document = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const lines = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    lines.push(
      ...pdfLines(
        content.items
          .filter((item) => "str" in item)
          .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height })),
      ),
    );
  }

  await document.cleanup();
  return lines;
}

const fixtures = new URL("./fixtures/", import.meta.url);
const parsedByName = new Map();

for (const name of ["checking-running-balance", "card-signed", "checking-sections", "newest-first"]) {
  const expected = JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"));
  const parsed = parseStatementLines(await statementLines(new URL(`${name}.pdf`, fixtures)));

  assert.ok(!("error" in parsed), `${name}: ${parsed.error}`);
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description) || a.amount - b.amount;
  assert.deepEqual([...parsed.rows].sort(byDate), [...expected.rows].sort(byDate), name);
  assert.equal(parsed.mask, expected.mask, `${name} mask`);
  assert.equal(parsed.balance, expected.balance, `${name} balance`);
  assert.equal(parsed.card, name.startsWith("card"), `${name} card`);
  parsedByName.set(name, parsed);
}

// Statement text that has no transactions, or no text at all.
assert.ok("error" in parseStatementLines([]));
assert.ok("error" in parseStatementLines(["Thank you for banking with us.", "Questions? Call 1-800-555-0100 any time."]));

// Several files become one import: overlapping files keep a transaction once,
// two identical transactions in one file stay two, and the newest file's
// balance and the last 4 digits come along.
{
  const checking = parsedByName.get("checking-running-balance");
  const january = { ...checking, rows: checking.rows.filter((row) => row.date >= "2026-01-01"), balance: 1.23 };
  const december = { ...checking, rows: checking.rows.filter((row) => row.date < "2026-01-01"), balance: 999 };
  const csv = combinedCsv([january, checking, december]);
  const imported = parseBankCsv(csv, "plaid|Discover|Cashback Checking ••0042");

  assert.ok(!("error" in imported));
  assert.equal(imported.transactions.length, checking.rows.length);
  assert.equal(imported.transactions.filter((row) => row.description.startsWith("Debit Card Purchase TRADER JOE")).length, 2);
  assert.equal(imported.mask, "0042");
  assert.equal(imported.balance, 1.23);
  assert.deepEqual(
    imported.transactions.find((row) => row.date === "2025-12-17" && row.amount < 0),
    { ...imported.transactions.find((row) => row.date === "2025-12-17" && row.amount < 0), amount: -2041.6 },
  );
}

// A CSV download read on its own and through the combined file gives the same
// ids, so it doesn't matter which way it was imported.
{
  const csv = "Date,Description,Amount\n2025-01-05,\"Coffee, Bagels\",-4.50\n2025-01-07,Deposit,100\n";
  const direct = parseBankCsv(csv, "key");
  const rows = direct.transactions.map(({ date, description, amount }) => ({ date, description, amount }));
  const combined = parseBankCsv(combinedCsv([{ rows, mask: null, balance: null }]), "key");

  assert.deepEqual(
    combined.transactions.map((row) => row.id).sort(),
    direct.transactions.map((row) => row.id).sort(),
  );
}

console.log("Statement PDF checks passed.");
