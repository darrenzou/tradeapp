export type AccountKind = "investment" | "cash" | "credit" | "loan" | "other";

export type LinkedAccount = {
  id: string;
  source: "snaptrade" | "plaid";
  name: string;
  institution: string;
  kind: AccountKind;
  // Credit and loan balances are the amount owed, as a positive number.
  balance: number;
  currency: string;
  // Present when stock and ETF holdings were repriced with live quotes.
  live?: { dayChange: number; asOf: string };
};

export type NetWorthSummary = {
  currency: string;
  netWorth: number;
  assets: number;
  creditCardBalance: number;
  loanBalance: number;
  accounts: LinkedAccount[];
  // Accounts in another currency are listed but left out of the totals.
  excludedAccounts: LinkedAccount[];
};

export const SUMMARY_CURRENCY = "USD";

export function isLiability(kind: AccountKind): boolean {
  return kind === "credit" || kind === "loan";
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeNetWorth(accounts: LinkedAccount[]): NetWorthSummary {
  const included = accounts.filter((account) => account.currency === SUMMARY_CURRENCY);
  const excludedAccounts = accounts.filter(
    (account) => account.currency !== SUMMARY_CURRENCY,
  );

  let assets = 0;
  let creditCardBalance = 0;
  let loanBalance = 0;

  for (const account of included) {
    if (account.kind === "credit") {
      creditCardBalance += account.balance;
    } else if (account.kind === "loan") {
      loanBalance += account.balance;
    } else {
      assets += account.balance;
    }
  }

  return {
    currency: SUMMARY_CURRENCY,
    netWorth: roundCents(assets - creditCardBalance - loanBalance),
    assets: roundCents(assets),
    creditCardBalance: roundCents(creditCardBalance),
    loanBalance: roundCents(loanBalance),
    accounts: included,
    excludedAccounts,
  };
}
