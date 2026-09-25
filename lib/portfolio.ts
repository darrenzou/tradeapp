import { xirr, type CashFlow } from "@/lib/irr";
import { liveTicker, type Holding, type Quote } from "@/lib/live-valuation";
import type { LinkedAccount } from "@/lib/net-worth";

// One position in one account, as a provider reports it.
export type PortfolioHolding = Holding & {
  // Grouping key across accounts: the ticker, or the security name if none.
  key: string;
  name: string;
  institutionPrice: number | null;
  // Total cost of the position, when the provider reports it.
  costBasis: number | null;
  // Cash and money-market sweep positions count as cash, not as a stock.
  isCash: boolean;
};

// A dated change to a position, from the investor's point of view: buys are
// negative cash flows; sales, dividends, and interest are positive.
export type InvestmentActivity = {
  accountId: string;
  key: string;
  date: string;
  shareChange: number;
  cashFlow: number;
};

// exact: transactions explain every share held.
// estimated: some shares predate the history, so they are assumed to have
//   been bought at their average cost when the history starts.
// unavailable: no transactions for the holding.
export type IrrStatus = "exact" | "estimated" | "unavailable";

export type StockRow = {
  key: string;
  name: string;
  securityType: string | null;
  accountCount: number;
  shares: number;
  averagePrice: number | null;
  price: number | null;
  live: boolean;
  dayChangePercent: number | null;
  dayPnl: number | null;
  marketValue: number;
  totalPnl: number | null;
  totalPnlPercent: number | null;
  irr: number | null;
  irrStatus: IrrStatus;
  portfolioPercent: number;
};

export type StocksSummary = {
  // Cash plus investments; debts are not subtracted.
  totalValue: number;
  holdingsValue: number;
  // Bank cash, brokerage cash, and money-market sweep positions.
  cashValue: number;
  // Investment accounts whose holdings couldn't be loaded.
  otherInvestmentsValue: number;
  dayPnl: number;
  dayPnlPercent: number | null;
  totalCost: number;
  totalPnl: number;
  irr: number | null;
  irrStatus: IrrStatus;
  irrHoldings: { included: number; total: number };
  rows: StockRow[];
};

type BuildInput = {
  accounts: LinkedAccount[];
  holdings: PortfolioHolding[];
  holdingsLoaded: Set<string>;
  quotes: Map<string, Quote>;
  activities: InvestmentActivity[];
  historyStarts: Map<string, string>;
  today: string;
};

type ValuedHolding = {
  holding: PortfolioHolding;
  marketValue: number;
  price: number | null;
  quote: Quote | undefined;
  dayPnl: number | null;
};

// Share counts closer than this are treated as equal (fractional shares and
// rounding in provider data).
const SHARE_TOLERANCE = 1e-4;

function valueHolding(holding: PortfolioHolding, quotes: Map<string, Quote>): ValuedHolding {
  const ticker = liveTicker(holding);
  const quote = ticker === null ? undefined : quotes.get(ticker);

  // Live prices only replace values the provider reported, matching the
  // repricing on the overview page.
  if (quote !== undefined && holding.institutionValue !== null) {
    return {
      holding,
      quote,
      price: quote.price,
      marketValue: holding.quantity * quote.price,
      dayPnl:
        quote.previousClose === null ? null : holding.quantity * (quote.price - quote.previousClose),
    };
  }

  const marketValue =
    holding.institutionValue ?? holding.quantity * (holding.institutionPrice ?? 0);

  return {
    holding,
    quote: undefined,
    marketValue,
    price: holding.institutionPrice ?? (holding.quantity !== 0 ? marketValue / holding.quantity : null),
    dayPnl: null,
  };
}

// Cash flows for one position in one account, ending with its current value.
function positionFlows(
  valued: ValuedHolding,
  activities: InvestmentActivity[],
  historyStart: string | undefined,
  today: string,
): { flows: CashFlow[]; status: IrrStatus } {
  const { holding, marketValue } = valued;

  if (activities.length === 0) {
    return { flows: [], status: "unavailable" };
  }

  const flows: CashFlow[] = activities
    .filter((activity) => activity.cashFlow !== 0)
    .map((activity) => ({ date: activity.date, amount: activity.cashFlow }));
  const explainedShares = activities.reduce((total, activity) => total + activity.shareChange, 0);
  const missingShares = holding.quantity - explainedShares;
  let status: IrrStatus = "exact";

  if (Math.abs(missingShares) > Math.max(SHARE_TOLERANCE, Math.abs(holding.quantity) * SHARE_TOLERANCE)) {
    status = "estimated";

    if (missingShares > 0) {
      const averageCost =
        holding.costBasis !== null && holding.quantity !== 0
          ? holding.costBasis / holding.quantity
          : holding.institutionPrice;

      if (historyStart === undefined || averageCost === null) {
        return { flows: [], status: "unavailable" };
      }

      flows.push({ date: historyStart, amount: -missingShares * averageCost });
    }
  }

  flows.push({ date: today, amount: marketValue });
  return { flows, status };
}

function combineStatus(statuses: IrrStatus[]): IrrStatus {
  if (statuses.includes("unavailable")) {
    return "unavailable";
  }

  return statuses.includes("estimated") ? "estimated" : "exact";
}

function sumOrNull(values: (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function buildStocksSummary(input: BuildInput): StocksSummary {
  const accounts = input.accounts.filter(
    (account) => account.currency === "USD" && account.kind !== "credit" && account.kind !== "loan",
  );
  const accountIds = new Set(accounts.map((account) => account.id));
  const holdings = input.holdings.filter((holding) => accountIds.has(holding.accountId));

  // Cash: bank and other non-investment accounts, cash positions, and any
  // brokerage balance not accounted for by positions (uninvested cash).
  let cashValue = 0;
  let otherInvestmentsValue = 0;

  for (const account of accounts) {
    if (account.kind !== "investment") {
      cashValue += account.balance;
    } else if (!input.holdingsLoaded.has(account.id)) {
      otherInvestmentsValue += account.balance;
    } else {
      const positionsValue = holdings
        .filter((holding) => holding.accountId === account.id)
        .reduce((total, holding) => total + (holding.institutionValue ?? 0), 0);
      // A negative remainder means the provider's positions and balance
      // disagree; don't turn that into negative cash.
      cashValue += Math.max(0, account.balance - positionsValue);
    }
  }

  const groups = new Map<string, ValuedHolding[]>();

  for (const holding of holdings) {
    if (holding.isCash) {
      cashValue += holding.institutionValue ?? 0;
      continue;
    }

    const group = groups.get(holding.key) ?? [];
    group.push(valueHolding(holding, input.quotes));
    groups.set(holding.key, group);
  }

  const rowsWithFlows = [...groups.entries()].map(([key, group]) => {
    const shares = group.reduce((total, valued) => total + valued.holding.quantity, 0);
    const marketValue = group.reduce((total, valued) => total + valued.marketValue, 0);
    const costBasis = sumOrNull(group.map((valued) => valued.holding.costBasis));
    const dayPnl = sumOrNull(group.map((valued) => valued.dayPnl));
    const quote = group.find((valued) => valued.quote !== undefined)?.quote;
    const positions = group.map((valued) =>
      positionFlows(
        valued,
        input.activities.filter(
          (activity) => activity.accountId === valued.holding.accountId && activity.key === key,
        ),
        input.historyStarts.get(valued.holding.accountId),
        input.today,
      ),
    );
    const irrStatus = combineStatus(positions.map((position) => position.status));
    const flows = irrStatus === "unavailable" ? [] : positions.flatMap((position) => position.flows);
    const totalPnl = costBasis === null ? null : marketValue - costBasis;

    const row: Omit<StockRow, "portfolioPercent"> = {
      key,
      name: group[0].holding.name,
      securityType: group[0].holding.securityType,
      accountCount: new Set(group.map((valued) => valued.holding.accountId)).size,
      shares,
      averagePrice: costBasis !== null && shares !== 0 ? costBasis / shares : null,
      price: quote?.price ?? (shares !== 0 ? marketValue / shares : null),
      live: quote !== undefined,
      dayChangePercent:
        quote?.previousClose ? (quote.price - quote.previousClose) / quote.previousClose : null,
      dayPnl,
      marketValue,
      totalPnl,
      totalPnlPercent: totalPnl !== null && costBasis ? totalPnl / costBasis : null,
      irr: irrStatus === "unavailable" ? null : xirr(flows),
      irrStatus,
    };

    return { row, flows, costBasis };
  });

  const holdingsValue = rowsWithFlows.reduce((total, entry) => total + entry.row.marketValue, 0);
  const totalValue = holdingsValue + cashValue + otherInvestmentsValue;
  const dayPnl = rowsWithFlows.reduce((total, entry) => total + (entry.row.dayPnl ?? 0), 0);
  const withCost = rowsWithFlows.filter((entry) => entry.costBasis !== null);
  const totalCost = withCost.reduce((total, entry) => total + (entry.costBasis ?? 0), 0);
  const totalPnl = withCost.reduce((total, entry) => total + (entry.row.totalPnl ?? 0), 0);
  const withIrr = rowsWithFlows.filter((entry) => entry.row.irrStatus !== "unavailable");
  const previousValue = totalValue - dayPnl;

  return {
    totalValue,
    holdingsValue,
    cashValue,
    otherInvestmentsValue,
    dayPnl,
    dayPnlPercent: previousValue > 0 ? dayPnl / previousValue : null,
    totalCost,
    totalPnl,
    // The portfolio IRR combines every holding with transaction history.
    irr: xirr(withIrr.flatMap((entry) => entry.flows)),
    irrStatus:
      withIrr.length === 0
        ? "unavailable"
        : withIrr.length < rowsWithFlows.length
          ? "estimated"
          : combineStatus(withIrr.map((entry) => entry.row.irrStatus)),
    irrHoldings: { included: withIrr.length, total: rowsWithFlows.length },
    rows: rowsWithFlows
      .map(({ row }) => ({
        ...row,
        portfolioPercent: totalValue > 0 ? row.marketValue / totalValue : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue),
  };
}
