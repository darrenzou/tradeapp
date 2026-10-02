// Transactions read from a bank or card statement PDF, for banks whose
// download is a monthly statement rather than a CSV. Statements are laid out
// differently by every bank, so this reads the common shape: a line per
// transaction that starts with its date and ends with its amount (and often
// the balance after it). Pure, so it runs in scripts and tests as well as in
// the browser, where the PDF's text is pulled out.

// A piece of text on a PDF page, as pdf.js reports it. y grows upward.
export type PdfTextItem = { str: string; x: number; y: number; width: number; height: number };

export type StatementRow = {
  // YYYY-MM-DD
  date: string;
  description: string;
  // Plaid's sign: positive when money left the account.
  amount: number;
};

export type ParsedStatement =
  | {
      rows: StatementRow[];
      // The account's last four digits, when the statement shows them.
      mask: string | null;
      // The ending balance (what's owed, on a card statement).
      balance: number | null;
      card: boolean;
    }
  | { error: string };

// A wide gap between two pieces of text on a line: a new column.
const COLUMN_GAP = "   ";

// A page's text as lines, top to bottom, with columns kept apart.
export function pdfLines(items: PdfTextItem[]): string[] {
  const sorted = items
    .filter((item) => item.str.trim() !== "")
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];

  for (const item of sorted) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(2, Math.min(item.height, line?.[0].height ?? item.height) * 0.5);

    if (line !== undefined && Math.abs(line[0].y - item.y) <= tolerance) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }

  return lines.map((line) => {
    let text = "";
    let end: number | null = null;

    for (const item of line.sort((a, b) => a.x - b.x)) {
      const gap = end === null ? 0 : item.x - end;
      const size = item.height || 10;

      if (end !== null) {
        text += gap > size * 1.2 ? COLUMN_GAP : gap > size * 0.12 ? " " : "";
      }

      text += item.str;
      end = item.x + item.width;
    }

    return text.trim();
  });
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
// "01/05", "1/5/26", "01/05/2026", "01-05", "Jan 5", "January 5, 2026".
const DATE = `(?:\\d{1,2}[/-]\\d{1,2}(?:[/-](?:\\d{4}|\\d{2}))?|${MONTH_NAME} \\d{1,2}(?:,? \\d{4})?)`;
const LEADING_DATE = new RegExp(`^(${DATE})(?:\\s+(${DATE}))?\\s+`, "i");
// "1,234.56", "-$45.00", "($12.00)", "500.00 CR", "45.00-".
const AMOUNT = "\\(?[-–]?\\s?\\$?\\s?\\d{1,3}(?:,\\d{3})*\\.\\d{2}\\)?(?:\\s?(?:CR|DR)\\b|-)?";
const TRAILING_AMOUNT = new RegExp(`\\s+(${AMOUNT})$`, "i");
const FULL_DATE = new RegExp(
  `(\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})\\b|${MONTH_NAME} \\d{1,2},? \\d{4})`,
  "gi",
);
const PERIOD_SEPARATOR = /^\s*(?:-|–|—|to|through|thru)\s*$/i;

const SUMMARY_LINE =
  /^(beginning|opening|starting|ending|closing|previous|prior|new|statement) balance\b|balance (forward|brought forward)|^total\b|daily (ending )?balance|^balance$/i;
const CARD_STATEMENT = /minimum payment (due)?|credit (limit|line)|available credit|payment due date/i;
const MONEY_IN_SECTION =
  /payments?,? (and|&) (other )?credits|deposits|additions|other credits|^credits\b|interest (paid|earned)|money in/i;
const MONEY_OUT_SECTION =
  /withdrawals|debits|subtractions|checks? paid|purchases?|fees|charges|electronic payments|card (activity|transactions)|atm|money out|interest charged/i;
const MONEY_IN_WORDS = /\b(deposit|credit|interest paid|interest earned|refund|transfer from|from)\b|\bpayroll\b|\bdir ?dep/i;
const OPENING_BALANCE = /^(beginning|opening|starting|previous|prior) balance\b|balance (forward|brought forward)/i;
const CLOSING_BALANCE = /^(ending|closing|new) balance\b/i;

type Money = { value: number; negative: boolean; credit: boolean };

function readMoney(text: string): Money | null {
  const credit = /CR$/i.test(text);
  const negative = /^\(.*\)|^\(?[-–]|-$/.test(text.replace(/\s?(CR|DR)$/i, ""));
  const digits = text.replace(/\s?(CR|DR)$/i, "").replace(/[^0-9.]/g, "");

  return digits === "" || Number.isNaN(Number(digits)) ? null : { value: Number(digits), negative, credit };
}

function isoFrom(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

type PartialDate = { month: number; day: number; year: number | null };

function readDate(text: string): PartialDate | null {
  const value = text.trim().toLowerCase();
  let match = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?$/.exec(value);

  if (match) {
    const year = match[3] === undefined ? null : Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return { month: Number(match[1]), day: Number(match[2]), year };
  }

  match = new RegExp(`^${MONTH_NAME} (\\d{1,2})(?:,? (\\d{4}))?$`).exec(value);

  if (match) {
    return { month: MONTHS[match[1]], day: Number(match[2]), year: match[3] === undefined ? null : Number(match[3]) };
  }

  return null;
}

function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

// The statement's period, so dates printed without a year ("01/05") land in
// the right one. Falls back to the latest full date anywhere in it.
function statementPeriod(lines: string[]): { start: string; end: string } | null {
  let latest = null as string | null;

  for (const line of lines) {
    const found: { iso: string; index: number; length: number }[] = [];

    for (const match of line.matchAll(FULL_DATE)) {
      const parsed = readDate(match[1].replace(/,/g, "").replace(/\s+/g, " "));
      const iso = parsed?.year == null ? null : isoFrom(parsed.year, parsed.month, parsed.day);

      if (iso !== null) {
        found.push({ iso, index: match.index, length: match[0].length });
        latest = latest === null || iso > latest ? iso : latest;
      }
    }

    // "Statement period: 12/15/25 - 01/14/26" or "December 15, 2025 to
    // January 14, 2026".
    for (let index = 1; index < found.length; index += 1) {
      const between = line.slice(found[index - 1].index + found[index - 1].length, found[index].index);

      if (PERIOD_SEPARATOR.test(between) && found[index - 1].iso <= found[index].iso) {
        return { start: found[index - 1].iso, end: found[index].iso };
      }
    }

    // "January 1 - January 31, 2026": the year only once, at the end.
    const short = new RegExp(`${MONTH_NAME} (\\d{1,2})\\s*(?:-|–|—|to|through)\\s*${MONTH_NAME} (\\d{1,2}),? (\\d{4})`, "i").exec(
      line.toLowerCase(),
    );

    if (short) {
      const endYear = Number(short[5]);
      const startMonth = MONTHS[short[1]];
      const endMonth = MONTHS[short[3]];
      const start = isoFrom(startMonth > endMonth ? endYear - 1 : endYear, startMonth, Number(short[2]));
      const end = isoFrom(endYear, endMonth, Number(short[4]));

      if (start !== null && end !== null) {
        return { start, end };
      }
    }
  }

  if (latest === null) {
    return null;
  }

  return { start: new Date((dayNumber(latest) - 62) * 86_400_000).toISOString().slice(0, 10), end: latest };
}

// The year that puts a month and day inside the statement's period.
function withYear(date: PartialDate, period: { start: string; end: string } | null): string | null {
  if (date.year !== null) {
    return isoFrom(date.year, date.month, date.day);
  }

  if (period === null) {
    return null;
  }

  const endYear = Number(period.end.slice(0, 4));
  const start = dayNumber(period.start);
  const end = dayNumber(period.end);
  let best: { iso: string; distance: number } | null = null;

  for (const year of [endYear, endYear - 1, endYear + 1]) {
    const iso = isoFrom(year, date.month, date.day);

    if (iso === null) {
      continue;
    }

    const day = dayNumber(iso);
    const distance = day < start ? start - day : day > end ? day - end : 0;

    if (best === null || distance < best.distance) {
      best = { iso, distance };
    }
  }

  return best !== null && best.distance <= 45 ? best.iso : null;
}

function findMask(lines: string[]): string | null {
  const pattern =
    /\b(?:account|acct|card)\b[^\n]{0,40}?(?:number|no\.?|#|ending(?: in)?|ends? (?:in|with))\s*:?\s*((?:[x*•.\d][\s-]?){4,})/i;

  for (const line of lines) {
    const match = pattern.exec(line);
    const digits = match?.[1].replace(/[^\dx*•]/gi, "") ?? "";

    if (/\d{4}$/.test(digits)) {
      return digits.slice(-4);
    }
  }

  return null;
}

type Line = {
  date: string;
  description: string;
  amounts: Money[];
  section: "in" | "out" | null;
};

// Reads a statement's lines (from pdfLines) into transactions.
export function parseStatementLines(lines: string[]): ParsedStatement {
  const text = lines.join("\n");

  if (text.replace(/\s/g, "").length < 40) {
    return { error: "That PDF has no text to read. It may be a scanned image." };
  }

  const card = CARD_STATEMENT.test(text);
  const period = statementPeriod(lines);
  const found: Line[] = [];
  let section: "in" | "out" | null = null;
  let opening: number | null = null;
  let closing: number | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    const dateMatch = LEADING_DATE.exec(`${line} `);
    let rest = dateMatch === null ? line : `${line} `.slice(dateMatch[0].length).trim();
    const amounts: Money[] = [];

    while (amounts.length < 4) {
      const match = TRAILING_AMOUNT.exec(` ${rest}`);
      const money = match === null ? null : readMoney(match[1].replace(/\s/g, ""));

      if (match === null || money === null) {
        break;
      }

      amounts.unshift(money);
      rest = ` ${rest}`.slice(0, match.index).trim();
    }

    const description = rest.replace(/^[-–:*#\s]+|[-–:*\s]+$/g, "").trim();

    if (OPENING_BALANCE.test(description) && amounts.length > 0) {
      opening ??= amounts[amounts.length - 1].value * (amounts[amounts.length - 1].negative ? -1 : 1);
      continue;
    }

    if (CLOSING_BALANCE.test(description) && amounts.length > 0) {
      closing ??= amounts[amounts.length - 1].value * (amounts[amounts.length - 1].negative ? -1 : 1);
      continue;
    }

    if (dateMatch === null) {
      // A heading such as "Deposits and Additions" or "Purchases" says which
      // way the amounts under it go.
      if (amounts.length === 0 && line.length <= 60 && !/\d{3}/.test(line)) {
        section = MONEY_IN_SECTION.test(line) ? "in" : MONEY_OUT_SECTION.test(line) ? "out" : section;
      }

      continue;
    }

    const date = readDate(dateMatch[1].replace(/,/g, "").replace(/\s+/g, " "));
    const iso = date === null ? null : withYear(date, period);

    if (iso === null || amounts.length === 0 || !/[a-z]{2}/i.test(description) || SUMMARY_LINE.test(description)) {
      continue;
    }

    found.push({ date: iso, description, amounts, section });
  }

  // On a bank statement with a running balance, the last amount is the
  // balance and the change from the line before says which way money went.
  const balances = found.map((line) =>
    !card && line.amounts.length >= 2
      ? line.amounts[line.amounts.length - 1].value * (line.amounts[line.amounts.length - 1].negative ? -1 : 1)
      : null,
  );
  const rows: StatementRow[] = [];

  for (const [index, line] of found.entries()) {
    const balance = balances[index];
    const values = balance === null ? line.amounts : line.amounts.slice(0, -1);
    const nonZero = values.filter((money) => money.value !== 0);

    if (nonZero.length !== 1 && values.length !== 1) {
      continue;
    }

    const money = nonZero[0] ?? values[0];

    if (money.value === 0) {
      continue;
    }

    let moneyIn: boolean | null = null;

    if (balance !== null) {
      const before = index === 0 ? opening : balances[index - 1];
      const after = balances[index + 1] ?? null;

      // Oldest first, then newest first.
      if (before !== null && Math.abs(Math.abs(balance - before) - money.value) < 0.005) {
        moneyIn = balance > before;
      } else if (after !== null && Math.abs(Math.abs(balance - after) - money.value) < 0.005) {
        moneyIn = balance > after;
      }
    }

    if (moneyIn === null) {
      if (card) {
        moneyIn = money.negative || money.credit || line.section === "in";
      } else if (money.credit || line.section !== null) {
        moneyIn = money.credit || line.section === "in";
      } else if (money.negative) {
        moneyIn = false;
      } else {
        moneyIn = MONEY_IN_WORDS.test(line.description);
      }
    }

    rows.push({
      date: line.date,
      description: line.description,
      amount: Math.round((moneyIn ? -money.value : money.value) * 100) / 100,
    });
  }

  if (rows.length === 0) {
    return { error: "No transactions were found in that PDF." };
  }

  return { rows, mask: findMask(lines), balance: closing === null ? null : Math.abs(closing), card };
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export type BankFileRows = { rows: StatementRow[]; mask: string | null; balance: number | null };

// Several files (CSV downloads and statement PDFs) as one CSV the import reads
// like a bank's own: money in is positive, the last 4 digits and the newest
// file's balance ride along. A transaction in two overlapping files is kept
// once.
export function combinedCsv(files: BankFileRows[]): string {
  const counts = new Map<string, { row: StatementRow; count: number }>();
  let mask: string | null = null;
  let balance: { date: string; amount: number } | null = null;

  for (const file of files) {
    const inFile = new Map<string, number>();

    for (const row of file.rows) {
      const key = `${row.date}|${row.description}|${row.amount}`;
      inFile.set(key, (inFile.get(key) ?? 0) + 1);
      const known = counts.get(key);
      counts.set(key, { row, count: Math.max(known?.count ?? 0, inFile.get(key) ?? 0) });
    }

    mask ??= file.mask;
    const newest = file.rows.reduce((latest, row) => (row.date > latest ? row.date : latest), "");

    if (file.balance !== null && (balance === null || newest > balance.date)) {
      balance = { date: newest, amount: file.balance };
    }
  }

  const rows = [...counts.values()]
    .flatMap(({ row, count }) => Array.from({ length: count }, () => row))
    .sort((a, b) => b.date.localeCompare(a.date));
  let balanceWritten = false;

  return [
    "Date,Description,Amount,Account Number,Balance",
    ...rows.map((row) => {
      const withBalance = balance !== null && !balanceWritten && row.date === balance.date;
      balanceWritten ||= withBalance;

      return [
        row.date,
        csvField(row.description),
        (-row.amount).toFixed(2),
        mask ?? "",
        withBalance && balance !== null ? balance.amount.toFixed(2) : "",
      ].join(",");
    }),
  ].join("\n");
}
