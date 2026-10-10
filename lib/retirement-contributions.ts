// Money put into 401(k) and Roth IRA accounts for a tax year, by account.
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
  // The brokerage's own wording, e.g. "CASH CONTRIBUTION PRIOR YEAR".
  description: string | null;
};

export type AccountContributions = {
  accountId: string;
  accountName: string;
  institution: string;
  // Contributions for the year; null when the account's transaction history
  // couldn't be loaded.
  total: number | null;
  // Deposits on different days; same-day deposits (one paycheck split across
  // funds, or employee and employer parts) count once.
  count: number;
  lastDate: string | null;
  // Money that arrived this year but isn't a contribution for it: rollovers
  // and conversions from other retirement accounts, and contributions made
  // by the tax deadline for the year before. Missing from copies saved on the
  // phone before they existed.
  rollovers?: number;
  priorYear?: number;
};

export type PlanContributions = {
  plan: RetirementPlan;
  // Accounts with history only.
  total: number;
  // False when some account's history is missing from the total.
  complete: boolean;
  // See AccountContributions.
  rollovers?: number;
  priorYear?: number;
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

// Brokerages name these deposits, e.g. "ROLLOVER CASH DIRECT ROLLOVER" or
// "CASH CONTRIBUTION PRIOR YEAR" (Fidelity), "2026 NONDEDUCT CONTRIB".
const ROLLOVER = /roll\s*-?\s*over|conversion|recharacteri[sz]|trustee/i;
const PRIOR_YEAR = /prior\s*-?\s*y(?:ea)?r|previous\s+y(?:ea)?r|last\s+year/i;

// A contribution's tax year when its wording names one, e.g. "2025 NONDEDUCT
// CONTRIB" made by the April deadline. Only wording that says "contrib", so a
// target-date fund's name ("TARGET RETIREMENT 2025") isn't read as one.
const NAMED_YEAR = /\b(20\d\d)\b/;
const CONTRIBUTION_WORDING = /contrib/i;

// Whether a deposit is a contribution, and for which tax year, or money
// rolled over from another retirement account.
export function classifyDeposit(
  deposit: Pick<RetirementDeposit, "date" | "description">,
): { kind: "contribution"; taxYear: number } | { kind: "rollover" } {
  const description = deposit.description ?? "";

  if (ROLLOVER.test(description)) {
    return { kind: "rollover" };
  }

  const year = Number(deposit.date.slice(0, 4));
  const named = CONTRIBUTION_WORDING.test(description) ? Number(NAMED_YEAR.exec(description)?.[1]) : NaN;

  // Only the year it arrived or the one before can be a contribution's year.
  if (named === year || named === year - 1) {
    return { kind: "contribution", taxYear: named };
  }

  return { kind: "contribution", taxYear: PRIOR_YEAR.test(description) ? year - 1 : year };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

type Tally = { total: number; dates: Set<string>; rollovers: number; priorYear: number };

// Totals the contributions for `year` into each retirement account, and what
// else arrived that year. `withHistory` holds the accounts whose transaction
// history was loaded.
export function summarizeContributions(
  accounts: LinkedAccount[],
  deposits: RetirementDeposit[],
  year: number,
  withHistory: ReadonlySet<string>,
): RetirementContributions {
  const byAccount = new Map<string, Tally>();
  const tallyOf = (accountId: string): Tally => {
    const tally = byAccount.get(accountId) ?? { total: 0, dates: new Set<string>(), rollovers: 0, priorYear: 0 };
    byAccount.set(accountId, tally);
    return tally;
  };

  for (const deposit of deposits) {
    if (deposit.amount <= 0) {
      continue;
    }

    const kind = classifyDeposit(deposit);
    const arrivedThisYear = deposit.date.startsWith(`${year}-`);

    if (kind.kind === "rollover") {
      if (arrivedThisYear) {
        tallyOf(deposit.accountId).rollovers += deposit.amount;
      }
    } else if (kind.taxYear === year) {
      const tally = tallyOf(deposit.accountId);
      tally.total += deposit.amount;
      tally.dates.add(deposit.date);
    } else if (arrivedThisYear) {
      tallyOf(deposit.accountId).priorYear += deposit.amount;
    }
  }

  const plans = RETIREMENT_PLANS.flatMap(({ id }): PlanContributions[] => {
    const planAccounts = accounts.filter((account) => account.retirementPlan === id);

    if (planAccounts.length === 0) {
      return [];
    }

    const rows = planAccounts
      .map((account): AccountContributions => {
        const tally = byAccount.get(account.id);
        const dates = tally ? [...tally.dates].sort() : [];
        const known = withHistory.has(account.id);

        return {
          accountId: account.id,
          accountName: account.name,
          institution: account.institution,
          total: known ? roundCents(tally?.total ?? 0) : null,
          count: dates.length,
          lastDate: dates.at(-1) ?? null,
          rollovers: roundCents(tally?.rollovers ?? 0),
          priorYear: roundCents(tally?.priorYear ?? 0),
        };
      })
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
    const sum = (value: (row: AccountContributions) => number) =>
      roundCents(rows.reduce((total, row) => total + value(row), 0));

    return [{
      plan: id,
      total: sum((row) => row.total ?? 0),
      complete: rows.every((row) => row.total !== null),
      rollovers: sum((row) => row.rollovers ?? 0),
      priorYear: sum((row) => row.priorYear ?? 0),
      accounts: rows,
    }];
  });

  return { year, plans };
}
