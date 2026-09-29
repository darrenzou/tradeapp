// Classifies bank and credit-card transactions into spending, income, other
// income (money in with no identified source), and transfers using Plaid's personal finance categories, and totals them by
// month. Pure, so it runs in scripts and tests as well as on the server.

// A transaction as Plaid reports it. Plaid amounts are positive when money
// leaves the account (a purchase) and negative when it arrives (a paycheck
// or a refund).
export type CashTransaction = {
  id: string;
  accountId: string;
  // "brokerage" is cash moving in a SnapTrade brokerage account (dividends,
  // interest, money added or withdrawn); "investment" is a Plaid investment
  // account, which isn't counted.
  accountKind: "depository" | "credit" | "loan" | "investment" | "brokerage" | "other";
  accountName: string;
  date: string;
  amount: number;
  name: string;
  // Plaid's personal finance category, e.g. FOOD_AND_DRINK and
  // FOOD_AND_DRINK_RESTAURANT; null when Plaid couldn't categorize it.
  primary: string | null;
  detailed: string | null;
  pending: boolean;
  currency: string;
};

// One deposit counted as income, as shown in the breakdowns.
export type IncomeEntry = {
  id: string;
  date: string;
  name: string;
  accountName: string;
  // Money received, positive; a reversal of earlier income is negative.
  amount: number;
  // "Paychecks", "Dividends", …; deposits with no identified source use
  // OTHER_INCOME_LABEL.
  source: string;
  // Counted toward the federal tax estimate (tax refunds and other income
  // are not).
  taxable: boolean;
};

export type MonthTotals = {
  // YYYY-MM
  month: string;
  // Income with an identified source (paychecks, interest, …).
  income: number;
  // Money in with no identified source.
  other: number;
  // Purchases less refunds, across every spending category.
  spending: number;
  // Spending by category label, largest first once serialized.
  categories: Record<string, number>;
};

export type Cashflow = {
  months: MonthTotals[];
  income: IncomeEntry[];
  other: IncomeEntry[];
};

// Source label for money in with no identified source.
export const OTHER_INCOME_LABEL = "Other income";

// Incoming transfers Plaid can't attribute to one of your own accounts.
// Unless they match money leaving another linked account, the source is
// unknown, so they count as other income.
const UNEXPLAINED_TRANSFERS_IN = new Set([
  "TRANSFER_IN_ACCOUNT_TRANSFER",
  "TRANSFER_IN_DEPOSIT",
  "TRANSFER_IN_OTHER_TRANSFER_IN",
]);

// Income Plaid couldn't attribute to wages, interest, dividends, and so on.
const UNEXPLAINED_INCOME = new Set(["INCOME_OTHER_INCOME", "INCOME_OTHER"]);

const NON_TAXABLE_INCOME = new Set(["INCOME_TAX_REFUND"]);

// Paying a credit card moves money between your own accounts; the purchases
// were already counted on the card.
const CARD_PAYMENTS = new Set(["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);

const NOT_SPENDING = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_DISBURSEMENTS", "INCOME"]);

const CATEGORY_LABELS: Record<string, string> = {
  BANK_FEES: "Bank fees",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Food & drink",
  GENERAL_MERCHANDISE: "Shopping",
  GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Government & donations",
  HOME_IMPROVEMENT: "Home improvement",
  LOAN_PAYMENTS: "Loan payments",
  MEDICAL: "Medical",
  PERSONAL_CARE: "Personal care",
  RENT_AND_UTILITIES: "Rent & utilities",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
  OTHER: "Other",
};

const INCOME_LABELS: Record<string, string> = {
  INCOME_WAGES: "Paychecks",
  INCOME_SALARY: "Paychecks",
  INCOME_DIVIDENDS: "Dividends",
  INCOME_INTEREST_EARNED: "Interest",
  INCOME_RETIREMENT_PENSION: "Retirement & pension",
  INCOME_TAX_REFUND: "Tax refunds",
  INCOME_UNEMPLOYMENT: "Unemployment",
};

// Transfers between two linked accounts post within a few days of each other.
const TRANSFER_MATCH_DAYS = 4;
const DAY_MS = 86_400_000;

function titleCase(code: string): string {
  const words = code.toLowerCase().replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function categoryLabel(primary: string | null): string {
  return primary === null ? "Other" : CATEGORY_LABELS[primary] ?? titleCase(primary);
}

function incomeLabel(detailed: string | null): string {
  if (detailed === null) {
    return "Unlabeled income";
  }

  return INCOME_LABELS[detailed] ?? titleCase(detailed.replace(/^INCOME_/, ""));
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

// Months from `start` (YYYY-MM) through `end` inclusive.
export function monthRange(start: string, end: string): string[] {
  const months: string[] = [];
  let [year, month] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

type Kind =
  | { type: "spending"; category: string }
  | { type: "income"; source: string; taxable: boolean }
  | { type: "other" }
  | { type: "transfer" };

function isUnexplainedDeposit(transaction: CashTransaction): boolean {
  return (
    transaction.amount < 0 &&
    transaction.accountKind === "depository" &&
    (transaction.primary === null ||
      (transaction.primary === "TRANSFER_IN" &&
        (transaction.detailed === null || UNEXPLAINED_TRANSFERS_IN.has(transaction.detailed))))
  );
}

function classify(transaction: CashTransaction, matchedTransfer: boolean): Kind {
  const { primary, detailed, amount } = transaction;

  if (matchedTransfer) {
    return { type: "transfer" };
  }

  if (primary === "INCOME") {
    if (amount < 0 && detailed !== null && UNEXPLAINED_INCOME.has(detailed)) {
      return { type: "other" };
    }

    return {
      type: "income",
      source: incomeLabel(detailed),
      taxable: detailed === null || !NON_TAXABLE_INCOME.has(detailed),
    };
  }

  if (isUnexplainedDeposit(transaction)) {
    return { type: "other" };
  }

  if (
    (primary !== null && NOT_SPENDING.has(primary)) ||
    (detailed !== null && CARD_PAYMENTS.has(detailed)) ||
    // Money arriving on a card or loan without a category is a payment.
    (amount < 0 && primary === null && transaction.accountKind !== "depository")
  ) {
    return { type: "transfer" };
  }

  return { type: "spending", category: categoryLabel(primary) };
}

type Pool = Map<number, { transaction: CashTransaction; day: number; used: boolean }[]>;

// Transactions grouped by amount in cents, for matching the other side of a
// transfer.
function poolByAmount(transactions: CashTransaction[]): Pool {
  const pool: Pool = new Map();

  for (const transaction of transactions) {
    const key = Math.round(Math.abs(transaction.amount) * 100);
    const list = pool.get(key) ?? [];
    list.push({ transaction, day: dayNumber(transaction.date), used: false });
    pool.set(key, list);
  }

  return pool;
}

// The unused entry in `pool` for the same amount as `transaction`, in another
// account, closest in date within a few days; marks it used.
function takeMatch(pool: Pool, transaction: CashTransaction): CashTransaction | null {
  const day = dayNumber(transaction.date);
  const candidates = (pool.get(Math.round(Math.abs(transaction.amount) * 100)) ?? []).filter(
    (entry) =>
      !entry.used &&
      entry.transaction.accountId !== transaction.accountId &&
      Math.abs(entry.day - day) <= TRANSFER_MATCH_DAYS,
  );
  const closest = candidates.sort((a, b) => Math.abs(a.day - day) - Math.abs(b.day - day))[0];

  if (closest === undefined) {
    return null;
  }

  closest.used = true;
  return closest.transaction;
}

// Finds transfers between your own accounts that Plaid didn't label as such:
// deposits with no identified source that match money leaving another linked
// account (a bank, or a withdrawal from a brokerage), and uncategorized bank
// payments that match money added to a brokerage. Returns the ids of the
// deposits and payments matched.
function matchOwnTransfers(transactions: CashTransaction[]): Set<string> {
  const matched = new Set<string>();
  const uncategorizedOut = transactions.filter(
    (transaction) =>
      transaction.amount > 0 && transaction.primary === null && transaction.accountKind === "depository",
  );
  const bankPayments = poolByAmount(uncategorizedOut);

  for (const contribution of transactions.filter(
    (transaction) => transaction.accountKind === "brokerage" && transaction.amount < 0 && transaction.primary === "TRANSFER_IN",
  )) {
    const payment = takeMatch(bankPayments, contribution);

    if (payment !== null) {
      matched.add(payment.id);
    }
  }

  const outgoing = poolByAmount(
    transactions.filter(
      (transaction) =>
        transaction.amount > 0 &&
        !matched.has(transaction.id) &&
        (transaction.primary === null || transaction.primary === "TRANSFER_OUT"),
    ),
  );

  for (const deposit of transactions.filter(isUnexplainedDeposit)) {
    if (takeMatch(outgoing, deposit) !== null) {
      matched.add(deposit.id);
    }
  }

  return matched;
}

function isCounted(transaction: CashTransaction): boolean {
  return (
    transaction.currency === "USD" &&
    transaction.accountKind !== "investment" &&
    Number.isFinite(transaction.amount)
  );
}

// One transaction as listed on a month's page.
export type MonthTransaction = {
  id: string;
  date: string;
  name: string;
  accountName: string;
  // Plaid's sign: positive when money left the account.
  amount: number;
  kind: "spending" | "income" | "other" | "transfer";
  // Spending category, income source, OTHER_INCOME_LABEL, or "Transfer".
  category: string;
  // Plaid's own detailed category, for display (e.g. "Coffee").
  detail: string | null;
  // Pending transactions are listed but not counted in any total.
  pending: boolean;
};

function detailLabel(primary: string | null, detailed: string | null): string | null {
  if (detailed === null) {
    return null;
  }

  // FOOD_AND_DRINK_COFFEE → "Coffee"
  const prefix = `${primary}_`;
  const rest = detailed.startsWith(prefix) ? detailed.slice(prefix.length) : detailed;
  return rest === "OTHER" || rest.startsWith("OTHER_") ? null : titleCase(rest);
}

// Every USD bank and card transaction in one month (YYYY-MM), newest first,
// classified the same way as the monthly totals.
export function listMonthTransactions(transactions: CashTransaction[], month: string): MonthTransaction[] {
  const counted = transactions.filter(isCounted);
  const ownTransfers = matchOwnTransfers(counted.filter((transaction) => !transaction.pending));

  return counted
    .filter((transaction) => transaction.date.startsWith(month))
    .map((transaction): MonthTransaction => {
      const kind = classify(transaction, !transaction.pending && ownTransfers.has(transaction.id));

      return {
        id: transaction.id,
        date: transaction.date,
        name: transaction.name,
        accountName: transaction.accountName,
        amount: roundCents(transaction.amount),
        kind: kind.type,
        category:
          kind.type === "spending"
            ? kind.category
            : kind.type === "income"
              ? kind.source
              : kind.type === "other"
                ? OTHER_INCOME_LABEL
                : "Transfer",
        detail: detailLabel(transaction.primary, transaction.detailed),
        pending: transaction.pending,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.pending) - Number(a.pending) || b.amount - a.amount);
}

// Totals posted USD transactions from `startMonth` through `endMonth`
// (YYYY-MM) into monthly spending, income, and other income.
export function buildCashflow(
  transactions: CashTransaction[],
  startMonth: string,
  endMonth: string,
): Cashflow {
  const included = transactions.filter((transaction) => !transaction.pending && isCounted(transaction));
  const ownTransfers = matchOwnTransfers(included);
  const months = new Map<string, MonthTotals>(
    monthRange(startMonth, endMonth).map((month) => [
      month,
      { month, income: 0, other: 0, spending: 0, categories: {} },
    ]),
  );
  const income: IncomeEntry[] = [];
  const other: IncomeEntry[] = [];

  for (const transaction of included) {
    const totals = months.get(transaction.date.slice(0, 7));

    if (totals === undefined) {
      continue;
    }

    const kind = classify(transaction, ownTransfers.has(transaction.id));
    const entryBase = {
      id: transaction.id,
      date: transaction.date,
      name: transaction.name,
      accountName: transaction.accountName,
      amount: roundCents(-transaction.amount),
    };

    switch (kind.type) {
      case "spending":
        totals.spending += transaction.amount;
        totals.categories[kind.category] = (totals.categories[kind.category] ?? 0) + transaction.amount;
        break;
      case "income":
        totals.income -= transaction.amount;
        income.push({ ...entryBase, source: kind.source, taxable: kind.taxable });
        break;
      case "other":
        totals.other -= transaction.amount;
        other.push({ ...entryBase, source: OTHER_INCOME_LABEL, taxable: false });
        break;
      case "transfer":
        break;
    }
  }

  const byDate = (a: IncomeEntry, b: IncomeEntry) => a.date.localeCompare(b.date) || b.amount - a.amount;

  return {
    months: [...months.values()].map((totals) => ({
      ...totals,
      income: roundCents(totals.income),
      other: roundCents(totals.other),
      spending: roundCents(totals.spending),
      categories: Object.fromEntries(
        Object.entries(totals.categories)
          .map(([category, amount]) => [category, roundCents(amount)] as const)
          .filter(([, amount]) => amount !== 0)
          .sort((a, b) => b[1] - a[1]),
      ),
    })),
    income: income.sort(byDate),
    other: other.sort(byDate),
  };
}
