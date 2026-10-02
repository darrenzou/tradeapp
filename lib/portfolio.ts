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
  // Shares bought, including recurring buys and reinvested dividends.
  purchase?: boolean;
};

// exact: transactions explain every share held.
// estimated: the history doesn't fully explain the position (shares predate
//   it, transfers have no price, or some accounts have no history), so
//   unexplained shares are assumed bought at average cost when it starts.
// unavailable: no account holding it has any transaction history.
export type IrrStatus = "exact" | "estimated" | "unavailable";

// One account's share of a symbol.
export type StockPosition = {
  accountId: string;
  accountName: string;
  institution: string;
  source: LinkedAccount["source"];
  shares: number;
  marketValue: number;
};

export type StockRow = {
  key: string;
  // Ticker to display; null when the security has none (e.g. some 401(k)
  // trust funds), in which case the name identifies it.
  ticker: string | null;
  name: string;
  // Accounts holding this symbol, largest first.
  positions: StockPosition[];
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
  // Date (YYYY-MM-DD) of the most recent buy in any account, or null when
  // the transaction history has none.
  lastPurchase: string | null;
  portfolioPercent: number;
};

// Where a piece of an account's cash comes from.
export type CashSource =
  | "Bank balance"
  | "Account balance"
  | "Uninvested cash"
  | `Money market (${string})`
  | `Cash equivalent (${string})`;

// One account's share of the portfolio's cash.
export type CashPosition = {
  accountId: string;
  accountName: string;
  institution: string;
  source: LinkedAccount["source"];
  amount: number;
  sources: CashSource[];
};

export type StocksSummary = {
  // Cash plus investments; debts are not subtracted.
  totalValue: number;
  holdingsValue: number;
  // Bank cash, brokerage cash, and money-market sweep positions.
  cashValue: number;
  // The accounts that make up cashValue, largest first.
  cashPositions: CashPosition[];
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

function stockPositions(
  group: ValuedHolding[],
  accountsById: Map<string, LinkedAccount>,
): StockPosition[] {
  const byAccount = new Map<string, StockPosition>();

  for (const { holding, marketValue } of group) {
    const account = accountsById.get(holding.accountId);
    const position = byAccount.get(holding.accountId) ?? {
      accountId: holding.accountId,
      accountName: account?.name ?? "Account",
      institution: account?.institution ?? "",
      source: account?.source ?? "plaid",
      shares: 0,
      marketValue: 0,
    };

    position.shares += holding.quantity;
    position.marketValue += marketValue;
    byAccount.set(holding.accountId, position);
  }

  return [...byAccount.values()].sort((a, b) => b.marketValue - a.marketValue);
}

// How an investment account's cash reconciles with its reported balance.
// The balance is authoritative. Any of it the positions don't cover is
// uninvested cash. When the positions add up to more than the balance, the
// excess comes out of the cash positions first: some institutions (Merrill's
// CMA through Plaid, for one) report cash both in the balance and as a cash
// position that already includes it, which would otherwise count it twice.
type CashReconciliation = {
  uninvested: number;
  // Share of each cash position's reported value to count, from 0 to 1.
  cashPositionShare: number;
  // How far the non-cash positions alone exceed the balance, if they do.
  unreconciled: number;
};

function reconcileCash(balance: number, positions: PortfolioHolding[]): CashReconciliation {
  const reported = positions.reduce((total, holding) => total + (holding.institutionValue ?? 0), 0);
  const cashPositions = positions
    .filter((holding) => holding.isCash)
    .reduce((total, holding) => total + (holding.institutionValue ?? 0), 0);
  const excess = Math.max(0, reported - balance);
  const trimmed = cashPositions > 0 ? Math.min(excess, cashPositions) : 0;

  return {
    uninvested: Math.max(0, balance - reported),
    cashPositionShare: cashPositions > 0 ? (cashPositions - trimmed) / cashPositions : 1,
    unreconciled: excess - trimmed,
  };
}

export function buildStocksSummary(input: BuildInput): StocksSummary {
  const accounts = input.accounts.filter(
    (account) => account.currency === "USD" && account.kind !== "credit" && account.kind !== "loan",
  );
  const accountIds = new Set(accounts.map((account) => account.id));
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  // Only investment accounts with loaded holdings are valued by position;
  // any other account's positions are already in its balance.
  const holdings = input.holdings.filter(
    (holding) =>
      accountIds.has(holding.accountId) &&
      accountsById.get(holding.accountId)?.kind === "investment" &&
      input.holdingsLoaded.has(holding.accountId),
  );

  // Cash: bank and other non-investment accounts, cash positions, and any
  // brokerage balance not accounted for by positions (uninvested cash),
  // tracked per account for the cash breakdown.
  const cashByAccount = new Map<string, CashPosition>();
  const cashPositionShares = new Map<string, number>();
  let otherInvestmentsValue = 0;

  function addCash(account: LinkedAccount, amount: number, source: CashSource) {
    if (Math.abs(amount) < 0.005) {
      return;
    }

    const position = cashByAccount.get(account.id) ?? {
      accountId: account.id,
      accountName: account.name,
      institution: account.institution,
      source: account.source,
      amount: 0,
      sources: [],
    };

    position.amount += amount;
    if (!position.sources.includes(source)) {
      position.sources.push(source);
    }
    cashByAccount.set(account.id, position);
  }

  for (const account of accounts) {
    if (account.kind !== "investment") {
      addCash(account, account.balance, account.kind === "cash" ? "Bank balance" : "Account balance");
    } else if (!input.holdingsLoaded.has(account.id)) {
      otherInvestmentsValue += account.balance;
    } else {
      const reconciled = reconcileCash(
        account.balance,
        holdings.filter((holding) => holding.accountId === account.id),
      );
      cashPositionShares.set(account.id, reconciled.cashPositionShare);
      addCash(account, reconciled.uninvested, "Uninvested cash");
    }
  }

  const groups = new Map<string, ValuedHolding[]>();

  for (const holding of holdings) {
    if (holding.isCash) {
      const account = accountsById.get(holding.accountId);
      if (account !== undefined) {
        // Cash-equivalent positions are named by ticker: funds as money
        // market (e.g. SPAXX), anything else the provider classifies as a
        // cash equivalent generically. Plain cash counts as uninvested cash.
        const label = holding.ticker?.trim().toUpperCase();
        const isFund = /mutual ?fund/i.test(holding.securityType ?? "");
        addCash(
          account,
          (holding.institutionValue ?? 0) * (cashPositionShares.get(account.id) ?? 1),
          !label ? "Uninvested cash" : isFund ? `Money market (${label})` : `Cash equivalent (${label})`,
        );
      }
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
    const lastPurchase =
      input.activities
        .filter((activity) => activity.purchase && activity.key === key)
        .map((activity) => activity.date)
        .sort()
        .at(-1) ?? null;
    const flows = combined.flows;
    const irr = combined.status === "unavailable" ? null : xirr(flows);
    const totalPnl = costBasis === null ? null : marketValue - costBasis;

    const row: Omit<StockRow, "portfolioPercent"> = {
      key,
      ticker: group.find((valued) => valued.holding.ticker)?.holding.ticker?.trim().toUpperCase() ?? null,
      name: group[0].holding.name,
      positions: stockPositions(group, accountsById),
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
      lastPurchase,
    };

    return { row, flows, costBasis };
  });

  const holdingsValue = rowsWithFlows.reduce((total, entry) => total + entry.row.marketValue, 0);
  const cashPositions = [...cashByAccount.values()].sort((a, b) => b.amount - a.amount);
  const cashValue = cashPositions.reduce((total, position) => total + position.amount, 0);
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
    cashPositions,
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
