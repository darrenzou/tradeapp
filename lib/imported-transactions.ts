// Bank transactions imported from a CSV the bank lets you download, for
// history older than Plaid shares (some banks, such as Discover, give Plaid
// only a few months). Pure, so it runs in scripts and tests as well as on the
// server.

export type ImportedTransaction = {
  id: string;
  // YYYY-MM-DD
  date: string;
  // The bank's wording, e.g. "ACH Withdrawal DUKEENERGY BILL PAY".
  description: string;
  // Plaid's sign: positive when money left the account.
  amount: number;
};

export type ParsedCsv =
  | {
      transactions: ImportedTransaction[];
      skipped: number;
      // The account's last four digits, when the file has an account number
      // column.
      mask: string | null;
      // The balance after the newest transaction, when the file has a
      // balance column.
      balance: number | null;
    }
  | { error: string };

export const MAX_IMPORTED_TRANSACTIONS = 5000;

// Splits CSV text into rows of fields, honoring quoted fields with commas,
// doubled quotes and line breaks.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

// "09/30/2026", "9/3/26" or "2026-09-30" as YYYY-MM-DD; null otherwise.
function isoDate(value: string): string | null {
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);

  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);

  if (!match) {
    return null;
  }

  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const date = `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

// "$1,574.46", "-$63.41", "(12.00)" or "0" as a number; null when empty or
// not a number.
function money(value: string | undefined): number | null {
  const text = (value ?? "").trim();

  if (text === "") {
    return null;
  }

  const negative = /^-|^\(.*\)$/.test(text);
  const digits = text.replace(/[^0-9.]/g, "");

  if (digits === "" || Number.isNaN(Number(digits))) {
    return null;
  }

  return (negative ? -1 : 1) * Number(digits);
}

function column(headers: string[], ...patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = headers.findIndex((header) => pattern.test(header));

    if (index !== -1) {
      return index;
    }
  }

  return -1;
}

// A short, stable id: the same file imported again gives the same ids.
function hash(text: string): string {
  let value = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }

  return (value >>> 0).toString(36);
}

// Reads a bank's CSV download: a date column, a description column, and
// either one amount column (negative for money out) or separate debit and
// credit columns. Rows without a date or amount are skipped.
export function parseBankCsv(text: string, accountKey: string): ParsedCsv {
  const [header, ...rows] = csvRows(text.replace(/^﻿/, ""));

  if (header === undefined) {
    return { error: "That file is empty." };
  }

  const headers = header.map((cell) => cell.trim().toLowerCase());
  const dateColumn = column(headers, /^(transaction|trans\.?|posted|posting) date$/, /date/);
  const descriptionColumn = column(headers, /description/, /^(name|payee|memo|details)$/);
  const amountColumn = column(headers, /^amount$/, /amount/);
  const debitColumn = column(headers, /^debit/, /withdrawal/);
  const creditColumn = column(headers, /^credit/, /deposit/);
  const balanceColumn = column(headers, /balance/);
  const maskColumn = column(headers, /^(account|card|acct)\.?( ?(number|no\.?|#))?$/, /(account|card|acct)\.? ?(number|no\b|#)|last ?(4|four)/);

  if (dateColumn === -1 || descriptionColumn === -1 || (amountColumn === -1 && (debitColumn === -1 || creditColumn === -1))) {
    return { error: "That file needs date, description and amount (or debit and credit) columns." };
  }

  const transactions: ImportedTransaction[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  let mask: string | null = null;
  let balance: { date: string; amount: number } | null = null;

  for (const row of rows) {
    const date = isoDate(row[dateColumn] ?? "");
    const description = (row[descriptionColumn] ?? "").trim().replace(/\s+/g, " ");
    let amount: number | null;

    if (amountColumn !== -1) {
      const value = money(row[amountColumn]);
      amount = value === null ? null : -value;
    } else {
      const debit = money(row[debitColumn]) ?? 0;
      const credit = money(row[creditColumn]) ?? 0;
      amount = Math.abs(debit) - Math.abs(credit);
    }

    if (date === null || description === "" || amount === null || amount === 0) {
      skipped += 1;
      continue;
    }

    amount = Math.round(amount * 100) / 100;

    const digits = maskColumn === -1 ? "" : (row[maskColumn] ?? "").replace(/\D/g, "");
    mask ??= digits.length >= 4 ? digits.slice(-4) : null;

    // Newest first or oldest first, the newest row's balance is the latest.
    const rowBalance = balanceColumn === -1 ? null : money(row[balanceColumn]);

    if (rowBalance !== null && (balance === null || date > balance.date)) {
      balance = { date, amount: rowBalance };
    }

    // Two identical rows on one day are two transactions.
    const base = `${accountKey}|${date}|${description}|${amount}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    transactions.push({ id: `import:${hash(`${base}|${occurrence}`)}`, date, description, amount });
  }

  if (transactions.length === 0) {
    return { error: "No transactions were found in that file." };
  }

  if (transactions.length > MAX_IMPORTED_TRANSACTIONS) {
    return { error: `That file has more than ${MAX_IMPORTED_TRANSACTIONS} transactions.` };
  }

  return { transactions, skipped, mask, balance: balance?.amount ?? null };
}

const KNOWN_BANKS: [RegExp, string][] = [
  [/discover/i, "Discover"],
  [/chase/i, "Chase"],
  [/bank ?of ?america|\bbofa\b/i, "Bank of America"],
  [/wells ?fargo/i, "Wells Fargo"],
  [/capital ?one/i, "Capital One"],
  [/citi/i, "Citi"],
  [/american ?express|\bamex\b/i, "American Express"],
  [/\bally\b/i, "Ally"],
  [/schwab/i, "Charles Schwab"],
  [/fidelity/i, "Fidelity"],
  [/\busaa\b/i, "USAA"],
  [/navy ?federal/i, "Navy Federal"],
  [/\bpnc\b/i, "PNC"],
  [/\bu\.?s\.? ?bank/i, "U.S. Bank"],
  [/\btd ?bank/i, "TD Bank"],
  [/marcus/i, "Marcus"],
  [/\bsofi\b/i, "SoFi"],
  [/\bbilt\b/i, "Bilt"],
];

// The bank a downloaded file is from, guessed from its name
// ("Discover_a_division_of_Capital_One_N.A.-Statement-2026102.csv" is
// Discover: the first bank named wins).
export function guessInstitution(fileName: string): string | null {
  let best: { index: number; name: string } | null = null;

  for (const [pattern, name] of KNOWN_BANKS) {
    const match = pattern.exec(fileName.replace(/[_-]+/g, " "));

    if (match && (best === null || match.index < best.index)) {
      best = { index: match.index, name };
    }
  }

  return best?.name ?? null;
}

type Category = { primary: string | null; detailed: string | null };

const TAX_REFUND = /\btax ?ref|taxrfd|irs treas|\bncdor\b|state of n\.?j|\bny state\b|tax refund/i;
const INTEREST = /\binterest (paid|earned|payment)\b|^interest$/i;
const PAYCHECK = /\b(payroll|payrll|direct ?dep(osit)?|dir ?dep|salary|paycheck|early ?pay)\b/i;
const UTILITIES = /energy|electric|\bpower\b|water|natural gas|utilit|comcast|xfinity|spectrum|verizon|at&t|t-mobile/i;
const RENT = /\brent\b/i;
const CARD_PAYMENT =
  /e-payment|card auto ?pay|ccpymt|card payment|crcardpmt|\bonline pmt\b|\bretry pymt\b|bank of america payment|autopay/i;
const INVESTING =
  /fidelity|fid bkg|schwab|vanguard|\bjpms\b|webull|robinhood|coinbase|binance|kalshi|e\*?trade|wealthfront|betterment|\bumb bank\b|moneylink|moneyline/i;
const SAVINGS = /\bsavings\b/i;
const PEOPLE = /\bzelle\b|\bvenmo\b|cash app|paypal/i;
const CHECK_DEPOSIT = /check deposit|mobile deposit/i;
const BANK_TRANSFER = /\b(n\.?a\.?|bank|chase|webxfr|transfer)\b/i;

// Plaid-style categories for an imported transaction, guessed from the
// bank's wording, so it's counted the same way as a Plaid transaction.
// Money in from an unknown source and money out to an unknown payee are left
// uncategorized, as Plaid would leave them.
export function categorizeImported(description: string, amount: number): Category {
  const moneyIn = amount < 0;

  if (moneyIn && TAX_REFUND.test(description)) {
    return { primary: "INCOME", detailed: "INCOME_TAX_REFUND" };
  }

  if (moneyIn && INTEREST.test(description)) {
    return { primary: "INCOME", detailed: "INCOME_INTEREST_EARNED" };
  }

  if (moneyIn && PAYCHECK.test(description)) {
    return { primary: "INCOME", detailed: "INCOME_WAGES" };
  }

  if (UTILITIES.test(description)) {
    return { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" };
  }

  if (RENT.test(description)) {
    return { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_RENT" };
  }

  if (CARD_PAYMENT.test(description)) {
    return { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
  }

  if (INVESTING.test(description)) {
    return moneyIn
      ? { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS" }
      : { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS" };
  }

  if (SAVINGS.test(description)) {
    return moneyIn
      ? { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_SAVINGS" }
      : { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_SAVINGS" };
  }

  if (PEOPLE.test(description)) {
    return moneyIn
      ? { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }
      : { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
  }

  if (moneyIn && CHECK_DEPOSIT.test(description)) {
    return { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT" };
  }

  // "ACH Withdrawal Bank of America NA": money moved to another bank.
  if (!moneyIn && /^ach withdrawal\b/i.test(description) && BANK_TRANSFER.test(description.slice(15))) {
    return { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
  }

  return { primary: null, detailed: null };
}

// Imported transactions older than the account's oldest Plaid transaction
// (all of them when Plaid has none), so the overlap isn't counted twice.
export function importedBefore(imported: ImportedTransaction[], plaidDates: string[]): ImportedTransaction[] {
  const earliest = plaidDates.reduce<string | null>((oldest, date) => (oldest === null || date < oldest ? date : oldest), null);
  return earliest === null ? imported : imported.filter((transaction) => transaction.date < earliest);
}
