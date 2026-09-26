import "server-only";

import { summarizeNetWorth, type NetWorthSummary } from "@/lib/net-worth";
import { buildAccountBreakdowns, type AccountBreakdown } from "@/lib/portfolio";
import { loadLinkedPortfolio, loadLivePrices } from "@/lib/portfolio-data";

export type DashboardData = NetWorthSummary & {
  brokerageConnected: boolean;
  plaidConnectionCount: number;
  // Time of the newest live quote used, when any holdings were repriced.
  pricesAsOf: string | null;
  // Stock and cash breakdown of each asset account, by account id.
  breakdowns: Record<string, AccountBreakdown>;
  // Short, user-facing notes about data that could not be loaded.
  issues: string[];
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function loadDashboard(userId: string): Promise<DashboardData> {
  const issues: string[] = [];
  const portfolio = await loadLinkedPortfolio(userId, issues);
  const { adjustments, pricesAsOf, quotes } = await loadLivePrices(portfolio.holdings, issues);

  // Accounts with live-priced holdings move by the change in those holdings'
  // value; everything else keeps the provider-reported balance.
  const accounts = portfolio.accounts.map((account) => {
    const adjustment = adjustments.get(account.id);

    return adjustment === undefined
      ? account
      : {
          ...account,
          balance: roundCents(account.balance + adjustment.delta),
          live: { dayChange: roundCents(adjustment.dayChange), asOf: adjustment.asOf },
        };
  });

  return {
    ...summarizeNetWorth(accounts),
    brokerageConnected: portfolio.brokerageConnected,
    plaidConnectionCount: portfolio.plaidConnectionCount,
    pricesAsOf,
    breakdowns: buildAccountBreakdowns({
      accounts: portfolio.accounts,
      holdings: portfolio.holdings,
      holdingsLoaded: portfolio.holdingsLoaded,
      quotes,
    }),
    issues,
  };
}
