// Classifies bank and credit-card transactions into spending, income, gifts,
// and transfers using Plaid's personal finance categories, and totals them by
// month. Pure, so it runs in scripts and tests as well as on the server.

// A transaction as Plaid reports it. Plaid amounts are positive when money
// leaves the account (a purchase) and negative when it arrives (a paycheck
// or a refund).
export type CashTransaction = {
  id: string;
  accountId: string;
  accountKind: "depository" | "credit" | "loan" | "investment" | "other";
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

// One deposit counted as income or as a gift, as shown in the breakdowns.
export type IncomeEntry = {
  id: string;
  date: string;
  name: string;
  accountName: string;
  // Money received, positive; a reversal of earlier income is negative.
  amount: number;
  // "Paychecks", "Dividends", …; gifts use "Gift".
  source: string;
  // Counted toward the federal tax estimate (tax refunds and gifts are not).
  taxable: boolean;
};

export type MonthTotals = {
  // YYYY-MM
  month: string;
  income: number;
  gifts: number;
  // Purchases less refunds, across every spending category.
  spending: number;
  // Spending by category label, largest first once serialized.
  categories: Record<string, number>;
};

export type Cashflow = {
  months: MonthTotals[];
  income: IncomeEntry[];
  gifts: IncomeEntry[];
};

// Incoming transfers Plaid can't attribute to one of your own accounts.
// Unless they match money leaving another linked account, the source is
// unknown, so they are treated as gifts.
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
    return "Other income";
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
  | { type: "gift" }
  | { type: "transfer" };

function isGiftCandidate(transaction: CashTransaction): boolean {
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

  if (primary === "INCOME") {
    if (amount < 0 && detailed !== null && UNEXPLAINED_INCOME.has(detailed)) {
      return { type: "gift" };
    }

    return {
      type: "income",
      source: incomeLabel(detailed),
      taxable: detailed === null || !NON_TAXABLE_INCOME.has(detailed),
    };
  }

  if (isGiftCandidate(transaction)) {
    return matchedTransfer ? { type: "transfer" } : { type: "gift" };
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

// Pairs deposits that look like gifts with money leaving another linked
// account for the same amount within a few days: those are transfers between
// your own accounts. Returns the ids of matched deposits.
function matchOwnTransfers(transactions: CashTransaction[]): Set<string> {
  const outgoing = transactions
    .filter(
      (transaction) =>
        transaction.amount > 0 &&
        (transaction.primary === null || transaction.primary === "TRANSFER_OUT"),
    )
    .map((transaction) => ({ transaction, day: dayNumber(transaction.date), used: false }));
  const byAmount = new Map<number, typeof outgoing>();

  for (const entry of outgoing) {
    const key = Math.round(entry.transaction.amount * 100);
    const list = byAmount.get(key) ?? [];
    list.push(entry);
    byAmount.set(key, list);
  }

  const matched = new Set<string>();

  for (const deposit of transactions.filter(isGiftCandidate)) {
    const day = dayNumber(deposit.date);
    const candidates = (byAmount.get(Math.round(-deposit.amount * 100)) ?? []).filter(
      (entry) =>
        !entry.used &&
        entry.transaction.accountId !== deposit.accountId &&
        Math.abs(entry.day - day) <= TRANSFER_MATCH_DAYS,
    );
    const closest = candidates.sort((a, b) => Math.abs(a.day - day) - Math.abs(b.day - day))[0];

    if (closest !== undefined) {
      closest.used = true;
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
  kind: "spending" | "income" | "gift" | "transfer";
  // Spending category, income source, "Gift", or "Transfer".
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
              : kind.type === "gift"
                ? "Gift"
                : "Transfer",
        detail: detailLabel(transaction.primary, transaction.detailed),
        pending: transaction.pending,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.pending) - Number(a.pending) || b.amount - a.amount);
}

// Totals posted USD transactions from `startMonth` through `endMonth`
// (YYYY-MM) into monthly spending, income, and gifts.
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
      { month, income: 0, gifts: 0, spending: 0, categories: {} },
    ]),
  );
  const income: IncomeEntry[] = [];
  const gifts: IncomeEntry[] = [];

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
      case "gift":
        totals.gifts -= transaction.amount;
        gifts.push({ ...entryBase, source: "Gift", taxable: false });
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
      gifts: roundCents(totals.gifts),
      spending: roundCents(totals.spending),
      categories: Object.fromEntries(
        Object.entries(totals.categories)
          .map(([category, amount]) => [category, roundCents(amount)] as const)
          .filter(([, amount]) => amount !== 0)
          .sort((a, b) => b[1] - a[1]),
      ),
    })),
    income: income.sort(byDate),
    gifts: gifts.sort(byDate),
  };
}
