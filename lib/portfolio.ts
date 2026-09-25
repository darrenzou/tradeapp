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
  // Share transfers reported without a price: valued at the position's
  // average cost instead of cashFlow.
  valueAtCost?: boolean;
};

// exact: transactions explain every share held.
// estimated: the history doesn't fully explain the position (shares predate
//   it, transfers have no price, or some accounts have no history), so
//   unexplained shares are assumed bought at average cost when it starts.
// unavailable: no account holding it has any transaction history.
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
  // Why the IRR is estimated or missing, for display; null when exact.
  irrNote: string | null;
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
type PositionIrr = { flows: CashFlow[]; status: IrrStatus };

// Cash flows for one position in one account, ending with its current value.
// Wherever the history can't account for the position, shares are assumed
// bought at the position's average cost when the history starts, and the
// result is marked estimated.
function positionFlows(
  valued: ValuedHolding,
  activities: InvestmentActivity[],
  historyStart: string | undefined,
  today: string,
): PositionIrr {
  const { holding, marketValue } = valued;
  const averageCost =
    holding.costBasis !== null && holding.quantity !== 0
      ? holding.costBasis / holding.quantity
      : holding.institutionPrice;
  const earliestActivity = activities.map((activity) => activity.date).sort()[0];
  const assumedStart = historyStart ?? earliestActivity;

  // No history for this account at all: nothing to date the position from.
  if (assumedStart === undefined || (averageCost === null && activities.length === 0)) {
    return { flows: [], status: "unavailable" };
  }

  let status: IrrStatus = "exact";
  const flows: CashFlow[] = [];

  for (const activity of activities) {
    // Transfers reported without a price count as money invested (or taken
    // out) at the position's average cost.
    const amount = activity.valueAtCost
      ? averageCost === null
        ? 0
        : -activity.shareChange * averageCost
      : activity.cashFlow;

    if (activity.valueAtCost) {
      status = "estimated";
    }
    if (amount !== 0) {
      flows.push({ date: activity.date, amount });
    }
  }

  const explainedShares = activities.reduce((total, activity) => total + activity.shareChange, 0);
  const missingShares = holding.quantity - explainedShares;
  const tolerance = Math.max(SHARE_TOLERANCE, Math.abs(holding.quantity) * SHARE_TOLERANCE);

  if (Math.abs(missingShares) > tolerance) {
    status = "estimated";

    if (missingShares > 0 && averageCost !== null) {
      flows.push({ date: assumedStart, amount: -missingShares * averageCost });
    }
  }

  // History with no money going in (e.g. only a sale, split, or dividends)
  // can't produce a return; assume the shares held and sold were bought at
  // average cost when the history starts.
  if (!flows.some((flow) => flow.amount < 0) && averageCost !== null) {
    const sharesSold = activities
      .filter((activity) => activity.shareChange < 0 && activity.cashFlow > 0)
      .reduce((total, activity) => total - activity.shareChange, 0);

    status = "estimated";
    flows.push({ date: assumedStart, amount: -(holding.quantity + sharesSold) * averageCost });
  }

  flows.push({ date: today, amount: marketValue });
  return { flows, status };
}

// Combines one symbol's positions across accounts. Positions without any
// history are left out rather than hiding the whole row's IRR.
function combinePositions(positions: PositionIrr[]): {
  flows: CashFlow[];
  status: IrrStatus;
  note: string | null;
} {
  const included = positions.filter((position) => position.status !== "unavailable");

  if (included.length === 0) {
    return {
      flows: [],
      status: "unavailable",
      note: "No transaction history for this holding yet. Brokerages can take a day to share it after connecting.",
    };
  }

  const flows = included.flatMap((position) => position.flows);

  if (included.length < positions.length) {
    return {
      flows,
      status: "estimated",
      note: `Based on ${included.length} of ${positions.length} accounts holding this; the others have no transaction history yet.`,
    };
  }

  return included.some((position) => position.status === "estimated")
    ? {
        flows,
        status: "estimated",
        note: "Estimated: part of this position isn't explained by the available transaction history, so those shares are assumed bought at your average cost when the history starts.",
      }
    : { flows, status: "exact", note: null };
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
    const combined = combinePositions(positions);
    const flows = combined.flows;
    const irr = combined.status === "unavailable" ? null : xirr(flows);
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
      irr,
      irrStatus: combined.status,
      irrNote:
        combined.status !== "unavailable" && irr === null
          ? "Not enough time has passed since these shares were bought to calculate an IRR."
          : combined.note,
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
