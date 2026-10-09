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
  // When the account has an employer match set: the estimated split of
  // `total` into the employee's own money and the employer's.
  match?: EmployerMatch;
  employee?: number;
  employer?: number;
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
  // The estimated employee and employer parts of `total`, when every account
  // with contributions has its employer match set.
  employee?: number;
  employer?: number;
  // The IRS limit on the employee's own 401(k) contributions for the year,
  // when it's known. Employer money doesn't count toward it.
  employeeLimit?: number;
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

// An employer's 401(k) match: 100% of what the employee puts in, up to
// `percent` of each paycheck, on a yearly `salary` paid twice a month.
// Entered on the 401k contributions sheet, by account, since providers
// report each paycheck as one amount without saying whose money it is.
export type EmployerMatch = { salary: number; percent: number };

export type EmployerMatches = Record<string, EmployerMatch>;

const MAX_SALARY = 100_000_000;
const MAX_MATCHED_ACCOUNTS = 50;

// One match as sent by the browser or read back from storage, or null when
// it isn't valid.
export function parseEmployerMatch(value: unknown): EmployerMatch | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const { salary, percent } = value as Record<string, unknown>;

  if (
    typeof salary !== "number" ||
    !Number.isFinite(salary) ||
    salary <= 0 ||
    salary > MAX_SALARY ||
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent > 100
  ) {
    return null;
  }

  return { salary: roundCents(salary), percent: Math.round(percent * 100) / 100 };
}

// Every saved match, keyed by account id, dropping any that aren't valid.
export function parseEmployerMatches(value: unknown): EmployerMatches {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const matches: EmployerMatches = {};

  for (const [accountId, entry] of Object.entries(value).slice(0, MAX_MATCHED_ACCOUNTS)) {
    const match = parseEmployerMatch(entry);

    if (match !== null) {
      matches[accountId] = match;
    }
  }

  return matches;
}

// The IRS limit on what an employee can put into a 401(k) each year
// (before catch-up contributions at 50 and over).
const EMPLOYEE_LIMITS: Record<number, number> = { 2024: 23_000, 2025: 23_500, 2026: 24_500 };

export function employeeLimitFor(year: number): number | undefined {
  return EMPLOYEE_LIMITS[year];
}

// Which half-month pay period a deposit belongs to. Paychecks land around
// the 15th and the last day of the month, a day or two either way, so the
// second half runs from the 23rd to the 5th of the next month.
function payPeriodOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  if (day <= 5) {
    const previous = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
    return `${previous}-B`;
  }

  return `${date.slice(0, 7)}-${day <= 22 ? "A" : "B"}`;
}

// Splits a year's deposits into a 401(k) into the employee's money and the
// employer's. In each pay period the day with the most money is the
// paycheck, and the employer matched the smaller of `percent` of that
// paycheck's pay and half the deposit (a 100% match can't be more than the
// employee's part). Deposits on other days, like a yearly company
// contribution, are the employer's. An estimate: it uses today's salary for
// every paycheck.
export function splitEmployerMatch(
  deposits: { date: string; amount: number }[],
  match: EmployerMatch,
): { employee: number; employer: number } {
  // Payroll rounds each paycheck's match to the cent.
  const matchPerPaycheck = roundCents(((match.salary / 24) * match.percent) / 100);
  const periods = new Map<string, Map<string, number>>();

  for (const deposit of deposits) {
    const period = payPeriodOf(deposit.date);
    const days = periods.get(period) ?? new Map<string, number>();
    days.set(deposit.date, (days.get(deposit.date) ?? 0) + deposit.amount);
    periods.set(period, days);
  }

  let employee = 0;
  let employer = 0;

  for (const days of periods.values()) {
    const amounts = [...days.values()];
    const paycheck = Math.max(...amounts);
    const matched = Math.min(matchPerPaycheck, paycheck / 2);
    employee += paycheck - matched;
    employer += matched + amounts.reduce((sum, amount) => sum + amount, 0) - paycheck;
  }

  return { employee: roundCents(employee), employer: roundCents(employer) };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

type Tally = {
  total: number;
  dates: Set<string>;
  deposits: { date: string; amount: number }[];
  rollovers: number;
  priorYear: number;
};

// Totals the contributions for `year` into each retirement account, and what
// else arrived that year. `withHistory` holds the accounts whose transaction
// history was loaded; `matches` the 401(k) employer matches the user set.
export function summarizeContributions(
  accounts: LinkedAccount[],
  deposits: RetirementDeposit[],
  year: number,
  withHistory: ReadonlySet<string>,
  matches: EmployerMatches = {},
): RetirementContributions {
  const byAccount = new Map<string, Tally>();
  const tallyOf = (accountId: string): Tally => {
    const tally = byAccount.get(accountId) ?? {
      total: 0,
      dates: new Set<string>(),
      deposits: [],
      rollovers: 0,
      priorYear: 0,
    };
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
      tally.deposits.push({ date: deposit.date, amount: deposit.amount });
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
        const match = id === "401k" ? matches[account.id] : undefined;
        const split = match && known ? splitEmployerMatch(tally?.deposits ?? [], match) : undefined;

        return {
          accountId: account.id,
          accountName: account.name,
          institution: account.institution,
          total: known ? roundCents(tally?.total ?? 0) : null,
          count: dates.length,
          lastDate: dates.at(-1) ?? null,
          rollovers: roundCents(tally?.rollovers ?? 0),
          priorYear: roundCents(tally?.priorYear ?? 0),
          ...(match ? { match } : {}),
          ...split,
        };
      })
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
    const sum = (value: (row: AccountContributions) => number) =>
      roundCents(rows.reduce((total, row) => total + value(row), 0));
    // Accounts with nothing this year don't need a match to be split.
    const splittable =
      id === "401k" &&
      rows.some((row) => row.employee !== undefined) &&
      rows.every((row) => row.employee !== undefined || !row.total);
    const employeeLimit = id === "401k" ? employeeLimitFor(year) : undefined;

    return [{
      plan: id,
      total: sum((row) => row.total ?? 0),
      complete: rows.every((row) => row.total !== null),
      rollovers: sum((row) => row.rollovers ?? 0),
      priorYear: sum((row) => row.priorYear ?? 0),
      ...(splittable
        ? { employee: sum((row) => row.employee ?? 0), employer: sum((row) => row.employer ?? 0) }
        : {}),
      ...(employeeLimit !== undefined ? { employeeLimit } : {}),
      accounts: rows,
    }];
  });

  return { year, plans };
}
