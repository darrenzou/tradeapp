import "server-only";

import { summarizeNetWorth, type LinkedAccount, type NetWorthSummary } from "@/lib/net-worth";
import { accountKey, type OverviewSettings } from "@/lib/overview-settings";
import { loadOverviewSettings } from "@/lib/user-settings-store";
import { loadLinkedPortfolio, loadLivePrices } from "@/lib/portfolio-data";

export type DashboardData = NetWorthSummary & {
  brokerageConnected: boolean;
  plaidConnectionCount: number;
  // Time of the newest live quote used, when any holdings were repriced.
  pricesAsOf: string | null;
  // Short, user-facing notes about data that could not be loaded.
  issues: string[];
  // Nicknames, hidden accounts and order from Edit accounts.
  settings: OverviewSettings;
  // Accounts removed in Edit accounts: left out of every total, listed only
  // there so they can be restored.
  removedAccounts: LinkedAccount[];
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function loadDashboard(userId: string): Promise<DashboardData> {
  const issues: string[] = [];
  const [portfolio, settings] = await Promise.all([
    loadLinkedPortfolio(userId, issues),
    loadOverviewSettings(userId, issues),
  ]);
  const { adjustments, pricesAsOf } = await loadLivePrices(portfolio.holdings, issues);

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

  const isRemoved = (account: LinkedAccount) => settings.accounts[accountKey(account)]?.removed === true;

  return {
    ...summarizeNetWorth(accounts.filter((account) => !isRemoved(account))),
    settings,
    removedAccounts: accounts.filter(isRemoved),
    brokerageConnected: portfolio.brokerageConnected,
    plaidConnectionCount: portfolio.plaidConnectionCount,
    pricesAsOf,
    issues,
  };
}
