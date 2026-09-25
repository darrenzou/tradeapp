import "server-only";

import { AccountType, type AccountBase } from "plaid";

import { getLatestStockQuotes, type StockQuote } from "@/lib/alpaca";
import { getSnapTradeCredentials, listPlaidItems, type PlaidItem } from "@/lib/linked-accounts";
import {
  summarizeNetWorth,
  type AccountKind,
  type LinkedAccount,
  type NetWorthSummary,
} from "@/lib/net-worth";
import { liveAdjustments, liveTicker, type Holding } from "@/lib/live-valuation";
import { getInvestmentHoldings, listFinancialAccounts } from "@/lib/plaid";
import {
  getBrokerageAccountPositions,
  listBrokerageAccounts,
  type SnapTradeUserCredentials,
} from "@/lib/snaptrade";

export type DashboardData = NetWorthSummary & {
  brokerageConnected: boolean;
  plaidConnectionCount: number;
  // Time of the newest live quote used, when any holdings were repriced.
  pricesAsOf: string | null;
  // Short, user-facing notes about data that could not be loaded.
  issues: string[];
};

// Accounts as the providers report them, plus the holdings that can be
// repriced live. Holding.accountId is the LinkedAccount id.
type ProviderAccounts = { accounts: LinkedAccount[]; holdings: Holding[] };

const PLAID_KINDS: Partial<Record<AccountType, AccountKind>> = {
  [AccountType.Depository]: "cash",
  [AccountType.Credit]: "credit",
  [AccountType.Loan]: "loan",
  [AccountType.Investment]: "investment",
  [AccountType.Brokerage]: "investment",
  [AccountType.Other]: "other",
};

// SnapTrade instrument kinds that trade as US-listed shares. Crypto, mutual
// funds, options, and the rest keep the brokerage's reported value.
const SNAPTRADE_SECURITY_TYPES: Record<string, string> = {
  stock: "equity",
  adr: "equity",
  etf: "etf",
};

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

async function loadSnapTradeHoldings(
  credentials: SnapTradeUserCredentials,
  snaptradeAccountId: string,
): Promise<Holding[]> {
  try {
    const { results } = await getBrokerageAccountPositions(credentials, snaptradeAccountId);

    return results.flatMap((position) => {
      const units = Number(position.units);
      const price = Number(position.price);
      const securityType = SNAPTRADE_SECURITY_TYPES[position.instrument.kind];

      // Alpaca quotes are US dollar listings only.
      if (!securityType || position.currency !== "USD" || !Number.isFinite(units) || !Number.isFinite(price)) {
        return [];
      }

      return [{
        accountId: `snaptrade:${snaptradeAccountId}`,
        ticker: "symbol" in position.instrument ? position.instrument.symbol : null,
        securityType,
        quantity: units,
        institutionValue: units * price,
      }];
    });
  } catch {
    // Without positions the account keeps the brokerage-reported balance.
    return [];
  }
}

async function loadBrokerageAccounts(
  userId: string,
  issues: string[],
): Promise<ProviderAccounts & { connected: boolean }> {
  const credentials = await getSnapTradeCredentials(userId);

  if (credentials === null) {
    return { connected: false, accounts: [], holdings: [] };
  }

  let brokerageAccounts: Awaited<ReturnType<typeof listBrokerageAccounts>>;

  try {
    brokerageAccounts = await listBrokerageAccounts(credentials);
  } catch {
    issues.push("Brokerage accounts couldn't be loaded right now.");
    return { connected: true, accounts: [], holdings: [] };
  }

  const accounts: LinkedAccount[] = [];
  let missingBalance = false;

  for (const account of brokerageAccounts) {
    if (account.status === "closed" || account.status === "archived") {
      continue;
    }

    const total = account.balance?.total;

    if (typeof total?.amount !== "number" || !Number.isFinite(total.amount)) {
      missingBalance = true;
      continue;
    }

    const isCreditLine = account.account_category === "LOC";

    accounts.push({
      id: `snaptrade:${account.id}`,
      source: "snaptrade",
      name: account.name ?? "Brokerage account",
      institution: account.institution_name,
      kind: isCreditLine ? "loan" : account.account_category === "DEPOSIT" ? "cash" : "investment",
      balance: isCreditLine ? Math.abs(total.amount) : total.amount,
      currency: total.currency ?? "USD",
    });
  }

  if (missingBalance) {
    issues.push("Some brokerage balances are still syncing and aren't included yet.");
  }

  const holdings = await Promise.all(
    accounts
      .filter((account) => account.kind === "investment")
      .map((account) => loadSnapTradeHoldings(credentials, account.id.slice("snaptrade:".length))),
  );

  return { connected: true, accounts, holdings: holdings.flat() };
}

function toLinkedAccount(item: PlaidItem, account: AccountBase): LinkedAccount | null {
  const kind = PLAID_KINDS[account.type];
  const current = account.balances.current;

  if (kind === undefined || current === null) {
    return null;
  }

  const suffix = account.mask ? ` ••${account.mask}` : "";

  return {
    id: `plaid:${account.account_id}`,
    source: "plaid",
    name: `${account.name}${suffix}`,
    institution: item.institutionName ?? "Bank",
    kind,
    balance: current,
    currency:
      account.balances.iso_currency_code ??
      account.balances.unofficial_currency_code ??
      "USD",
  };
}

async function loadPlaidItem(item: PlaidItem): Promise<ProviderAccounts> {
  const plaidAccounts = await listFinancialAccounts(item.accessToken);
  const accounts = plaidAccounts.flatMap((account) => toLinkedAccount(item, account) ?? []);

  if (!accounts.some((account) => account.kind === "investment")) {
    return { accounts, holdings: [] };
  }

  try {
    const data = await getInvestmentHoldings(item.accessToken);
    const securities = new Map(data.securities.map((security) => [security.security_id, security]));
    const holdings = data.holdings.map((holding) => {
      const security = securities.get(holding.security_id);
      return {
        accountId: `plaid:${holding.account_id}`,
        ticker: security?.ticker_symbol ?? null,
        securityType: security?.type ?? null,
        quantity: holding.quantity,
        institutionValue: holding.institution_value ?? null,
      };
    });
    return { accounts, holdings };
  } catch {
    // Items linked before investment consent was requested, or institutions
    // without holdings data, keep the institution-reported balance.
    return { accounts, holdings: [] };
  }
}

async function loadPlaidAccounts(
  userId: string,
  issues: string[],
): Promise<ProviderAccounts & { itemCount: number }> {
  const items = await listPlaidItems(userId);
  const results = await Promise.allSettled(items.map(loadPlaidItem));
  const accounts: LinkedAccount[] = [];
  const holdings: Holding[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      accounts.push(...result.value.accounts);
      holdings.push(...result.value.holdings);
    } else {
      const institution = items[index]?.institutionName ?? "A bank";
      issues.push(`${institution} couldn't be loaded right now. It may need to be reconnected.`);
    }
  });

  return { itemCount: items.length, accounts, holdings };
}

// Reprices stock and ETF holdings from both providers with one batch of live
// Alpaca quotes. Accounts without live prices keep their reported balance.
async function applyLivePrices(
  accounts: LinkedAccount[],
  holdings: Holding[],
  issues: string[],
): Promise<{ accounts: LinkedAccount[]; pricesAsOf: string | null }> {
  const symbols = holdings.flatMap((holding) => liveTicker(holding) ?? []);
  let quotes = new Map<string, StockQuote>();

  if (symbols.length > 0) {
    try {
      quotes = await getLatestStockQuotes(symbols);
    } catch {
      issues.push("Live prices are unavailable right now. Investment values are from the last update.");
    }
  }

  const adjustments = liveAdjustments(holdings, quotes);
  const asOfTimes = [...adjustments.values()].map((adjustment) => adjustment.asOf).sort();

  return {
    pricesAsOf: asOfTimes.at(-1) ?? null,
    accounts: accounts.map((account) => {
      const adjustment = adjustments.get(account.id);

      return adjustment === undefined
        ? account
        : {
            ...account,
            balance: roundCents(account.balance + adjustment.delta),
            live: { dayChange: roundCents(adjustment.dayChange), asOf: adjustment.asOf },
          };
    }),
  };
}

export async function loadDashboard(userId: string): Promise<DashboardData> {
  const issues: string[] = [];
  const [brokerage, plaid] = await Promise.all([
    loadBrokerageAccounts(userId, issues),
    loadPlaidAccounts(userId, issues),
  ]);
  const priced = await applyLivePrices(
    [...brokerage.accounts, ...plaid.accounts],
    [...brokerage.holdings, ...plaid.holdings],
    issues,
  );

  return {
    ...summarizeNetWorth(priced.accounts),
    brokerageConnected: brokerage.connected,
    plaidConnectionCount: plaid.itemCount,
    pricesAsOf: priced.pricesAsOf,
    issues,
  };
}
