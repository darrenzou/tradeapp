"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, formatMoney, isRecord, readJson } from "./client-api";
import { CATEGORY_ICONS, Icon, Skeleton, type IconName } from "./theme-ui";
import type { AccountTransaction, AccountTransactionsPage } from "@/lib/account-history";

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response | null>;

type Loaded = Omit<AccountTransactionsPage, "transactions">;

const LOAD_FAILED_MESSAGE = "Transactions couldn't be loaded. Try again.";

// Transactions the sheet shows before "View all transactions".
const RECENT_TRANSACTIONS = 20;

// The page listing every transaction for an account, with search.
export function accountPagePath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}`;
}

function monthHeading(date: string): string {
  return new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Money in shows as +$, money out as −$.
function signedAmount(transaction: AccountTransaction): string {
  const text = formatMoney(Math.abs(transaction.amount), transaction.currency);
  return transaction.amount > 0 ? `+${text}` : transaction.amount < 0 ? `−${text}` : text;
}

// A picture for each kind of transaction, from its second line.
function transactionIcon(transaction: AccountTransaction): IconName {
  if (transaction.detail !== null && CATEGORY_ICONS[transaction.detail]) {
    return CATEGORY_ICONS[transaction.detail];
  }

  // Brokerage activity: buys, sales, dividends.
  return /^(Bought|Sold)\b|dividend|reinvest/i.test(transaction.description) ? "chart" : "receipt";
}

// Money in and out this calendar month, once the loaded transactions reach
// back to its first day; null until then.
export function monthFlows(
  transactions: AccountTransaction[],
  reachedOldest: boolean,
): { in: number; out: number } | null {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const oldest = transactions.at(-1);

  if (!reachedOldest && (oldest === undefined || oldest.date.slice(0, 7) >= month)) {
    return null;
  }

  const flows = { in: 0, out: 0 };

  for (const transaction of transactions) {
    if (transaction.date.slice(0, 7) !== month) {
      continue;
    }

    if (transaction.amount > 0) {
      flows.in += transaction.amount;
    } else {
      flows.out -= transaction.amount;
    }
  }

  return flows;
}

// Money in and out this calendar month.
export function MonthFlows({ flows, currency }: { flows: { in: number; out: number }; currency: string }) {
  return (
    <dl className="acct-flows">
      <div>
        <span className="acct-flow-icon acct-flow-in" aria-hidden="true">
          <Icon name="arrowUp" size={16} strokeWidth={2.4} />
        </span>
        <dt>In this month</dt>
        <dd className={flows.in > 0 ? "stocks-up" : undefined}>
          {flows.in > 0 && "+"}
          {formatMoney(flows.in, currency)}
        </dd>
      </div>
      <div>
        <span className="acct-flow-icon" aria-hidden="true">
          <Icon name="arrowDown" size={16} strokeWidth={2.4} />
        </span>
        <dt>Out this month</dt>
        <dd>
          {flows.out > 0 && "−"}
          {formatMoney(flows.out, currency)}
        </dd>
      </div>
    </dl>
  );
}

// Transactions grouped under month headings, newest first.
export function TransactionMonths({ transactions }: { transactions: AccountTransaction[] }) {
  const byMonth = new Map<string, AccountTransaction[]>();

  for (const transaction of transactions) {
    const month = transaction.date.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(transaction);
    byMonth.set(month, list);
  }

  return [...byMonth.entries()].map(([month, list]) => (
    <section key={month} aria-label={monthHeading(list[0].date)}>
      <h4 className="acct-month">{monthHeading(list[0].date)}</h4>
      <ul className="acct-txns">
        {list.map((transaction) => (
          <li key={transaction.id} className="acct-txn">
            <span className="acct-txn-icon" aria-hidden="true">
              <Icon name={transactionIcon(transaction)} size={20} strokeWidth={1.9} />
            </span>
            <span className="acct-txn-main">
              <span className="acct-txn-name">{transaction.description}</span>
              <span className="acct-txn-detail">
                {shortDate(transaction.date)}
                {transaction.pending && " · Pending"}
              </span>
            </span>
            <span className="acct-txn-side">
              <span className={`acct-txn-amount ${transaction.amount > 0 ? "stocks-up" : ""}`}>
                {signedAmount(transaction)}
              </span>
              {transaction.detail && <span className="acct-txn-detail">{transaction.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  ));
}

export function isPage(value: unknown): value is AccountTransactionsPage {
  return isRecord(value) && Array.isArray(value.transactions) && typeof value.total === "number";
}

// An account's most recent transactions, grouped by month, with a link to
// the page that has all of them. Render with key={accountId} so another
// account starts fresh.
export default function AccountTransactions({ accountId, apiFetch }: { accountId: string; apiFetch: ApiFetch }) {
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  // State is only set once the request returns; loadPage marks it loading.
  const fetchPage = useCallback(
    async () => {
      try {
        const response = await apiFetch(`/api/accounts/transactions?account=${encodeURIComponent(accountId)}`);

        if (response === null || !mounted.current) {
          return;
        }

        const body = await readJson(response);

        if (!mounted.current) {
          return;
        }

        if (!response.ok || !isPage(body)) {
          setError(errorMessage(body, LOAD_FAILED_MESSAGE));
          return;
        }

        const { transactions: page, ...rest } = body;
        setTransactions(page);
        setLoaded(rest);
      } catch {
        if (mounted.current) {
          setError(LOAD_FAILED_MESSAGE);
        }
      } finally {
        if (mounted.current) {
          setIsLoading(false);
        }
      }
    },
    [accountId, apiFetch],
  );

  useEffect(() => {
    mounted.current = true;

    async function loadFirstPage() {
      await fetchPage();
    }

    void loadFirstPage();

    return () => {
      mounted.current = false;
    };
  }, [fetchPage]);

  function retry() {
    setIsLoading(true);
    setError("");
    void fetchPage();
  }

  const flows = loaded === null ? null : monthFlows(transactions, loaded.nextOffset === null);
  const currency = transactions[0]?.currency ?? "USD";

  return (
    <section className="acct-history" aria-labelledby="acct-history-heading" aria-busy={isLoading}>
      {flows !== null && <MonthFlows flows={flows} currency={currency} />}

      <h3 id="acct-history-heading" className="acct-history-title">Transactions</h3>

      {loaded?.notice && <p className="detail-note">{loaded.notice}</p>}

      {loaded === null && isLoading && (
        <ul className="acct-txns" aria-label="Loading transactions">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="acct-txn">
              <span className="acct-txn-icon" />
              <span className="acct-txn-main">
                <Skeleton width="130px" />
                <Skeleton width="70px" height="10px" />
              </span>
              <Skeleton width="64px" />
            </li>
          ))}
        </ul>
      )}

      {loaded !== null && transactions.length === 0 && <p className="dash-empty">No transactions yet.</p>}

      <TransactionMonths transactions={transactions.slice(0, RECENT_TRANSACTIONS)} />

      {error && (
        <div className="acct-history-error" role="alert">
          <p>{error}</p>
          <button type="button" className="pill-button" onClick={retry} disabled={isLoading}>
            Try again
          </button>
        </div>
      )}

      {transactions.length > 0 && (
        <Link href={accountPagePath(accountId)} className="pill-button pill-button-soft acct-history-more">
          View all transactions
        </Link>
      )}
    </section>
  );
}
