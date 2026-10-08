// Money put into 401(k) and Roth IRA accounts in a calendar year, by account.
// Pure, so it runs in tests as well as on the server.

import type { LinkedAccount } from "@/lib/net-worth";

export type RetirementPlan = "401k" | "rothIra";

export const RETIREMENT_PLANS: { id: RetirementPlan; label: string }[] = [
  { id: "401k", label: "401k" },
  { id: "rothIra", label: "Roth IRA" },
];

// One deposit into a retirement account, from the account's history.
export type RetirementDeposit = {
  accountId: string;
  date: string;
  // Positive: money that came into the account.
  amount: number;
};

export type AccountContributions = {
  accountId: string;
  accountName: string;
  institution: string;
  // Null when the account's transaction history couldn't be loaded.
  total: number | null;
  // Deposits on different days; same-day deposits (one paycheck split across
  // funds, or employee and employer parts) count once.
  count: number;
  lastDate: string | null;
};

export type PlanContributions = {
  plan: RetirementPlan;
  // Accounts with history only.
  total: number;
  // False when some account's history is missing from the total.
  complete: boolean;
  // Every linked account of this kind, largest total first; accounts with
  // nothing this year are listed at $0.
  accounts: AccountContributions[];
};

export type RetirementContributions = {
  year: number;
  // Only the kinds of accounts that are linked.
  plans: PlanContributions[];
};

// What kind of retirement account this is, from the type the provider reports
// (Plaid's subtype, SnapTrade's raw type) and the account's name. Roth 401(k)s
// count as 401(k)s. Null for any other account.
export function retirementPlanOf(type: string | null | undefined, name: string | null | undefined): RetirementPlan | null {
  const text = `${type ?? ""} ${name ?? ""}`.toLowerCase();

  if (/\b401\s*\(?\s*k\b/.test(text)) {
    return "401k";
  }

  // Plaid's "roth" subtype is a Roth IRA; SnapTrade says e.g. "ROTH_IRA".
  return /\broth/.test(text) ? "rothIra" : null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

// Totals the deposits made in `year` into each retirement account.
// `withHistory` holds the accounts whose transaction history was loaded.
export function summarizeContributions(
  accounts: LinkedAccount[],
  deposits: RetirementDeposit[],
  year: number,
  withHistory: ReadonlySet<string>,
): RetirementContributions {
  const prefix = `${year}-`;
  const byAccount = new Map<string, { total: number; dates: Set<string> }>();

  for (const deposit of deposits) {
    if (deposit.amount <= 0 || !deposit.date.startsWith(prefix)) {
      continue;
    }

    const entry = byAccount.get(deposit.accountId) ?? { total: 0, dates: new Set<string>() };
    entry.total += deposit.amount;
    entry.dates.add(deposit.date);
    byAccount.set(deposit.accountId, entry);
  }

  const plans = RETIREMENT_PLANS.flatMap(({ id }): PlanContributions[] => {
    const planAccounts = accounts.filter((account) => account.retirementPlan === id);

    if (planAccounts.length === 0) {
      return [];
    }

    const rows = planAccounts
      .map((account): AccountContributions => {
        const entry = byAccount.get(account.id);
        const dates = entry ? [...entry.dates].sort() : [];

        return {
          accountId: account.id,
          accountName: account.name,
          institution: account.institution,
          total: withHistory.has(account.id) ? roundCents(entry?.total ?? 0) : null,
          count: dates.length,
          lastDate: dates.at(-1) ?? null,
        };
      })
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));

    return [{
      plan: id,
      total: roundCents(rows.reduce((sum, row) => sum + (row.total ?? 0), 0)),
      complete: rows.every((row) => row.total !== null),
      accounts: rows,
    }];
  });

  return { year, plans };
}
