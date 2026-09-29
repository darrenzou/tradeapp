"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, formatMoney, isRecord, readJson } from "./client-api";
import type { AccountTransaction, AccountTransactionsPage } from "@/lib/account-history";

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response | null>;

type Loaded = Omit<AccountTransactionsPage, "transactions">;

const LOAD_FAILED_MESSAGE = "Transactions couldn't be loaded. Try again.";

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

function isPage(value: unknown): value is AccountTransactionsPage {
  return isRecord(value) && Array.isArray(value.transactions) && typeof value.total === "number";
}

// One account's transactions, newest first, grouped by month, 50 at a time.
// Render with key={accountId} so another account starts from its own first page.
export default function AccountTransactions({ accountId, apiFetch }: { accountId: string; apiFetch: ApiFetch }) {
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  // State is only set once the request returns; loadPage marks it loading.
  const fetchPage = useCallback(
    async (offset: number) => {
      try {
        const response = await apiFetch(
          `/api/accounts/transactions?account=${encodeURIComponent(accountId)}&offset=${offset}`,
        );

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
        setTransactions((current) => (offset === 0 ? page : [...current, ...page]));
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
      await fetchPage(0);
    }

    void loadFirstPage();

    return () => {
      mounted.current = false;
    };
  }, [fetchPage]);

  function loadPage(offset: number) {
    setIsLoading(true);
    setError("");
    void fetchPage(offset);
  }

  const byMonth = new Map<string, AccountTransaction[]>();

  for (const transaction of transactions) {
    const month = transaction.date.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(transaction);
    byMonth.set(month, list);
  }

  const nextOffset = loaded?.nextOffset ?? null;

  return (
    <section className="acct-history" aria-labelledby="acct-history-heading" aria-busy={isLoading}>
      <h3 id="acct-history-heading" className="dash-label">Transactions</h3>

      {loaded?.notice && <p className="detail-note">{loaded.notice}</p>}

      {loaded === null && isLoading && <p className="dash-empty">Loading transactions…</p>}

      {loaded !== null && transactions.length === 0 && <p className="dash-empty">No transactions yet.</p>}

      {[...byMonth.entries()].map(([month, list]) => (
        <section key={month} aria-label={monthHeading(list[0].date)}>
          <h4 className="spend-day">{monthHeading(list[0].date)}</h4>
          <ul className="spend-transactions">
            {list.map((transaction) => (
              <li key={transaction.id} className="acct-txn">
                <span className="spend-transaction-main">
                  <span className="spend-transaction-name">{transaction.description}</span>
                  <span className="detail-name">
                    {shortDate(transaction.date)}
                    {transaction.pending && " · Pending"}
                    {transaction.detail && ` · ${transaction.detail}`}
                  </span>
                </span>
                <span className={`spend-transaction-amount ${transaction.amount > 0 ? "stocks-up" : ""}`}>
                  {signedAmount(transaction)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {error && (
        <div className="acct-history-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="auth-switch"
            onClick={() => loadPage(transactions.length === 0 ? 0 : nextOffset ?? 0)}
            disabled={isLoading}
          >
            Try again
          </button>
        </div>
      )}

      {nextOffset !== null && !error && (
        <button
          type="button"
          className="auth-switch acct-history-more"
          onClick={() => loadPage(nextOffset)}
          disabled={isLoading}
        >
          {isLoading ? "Loading…" : "Show older transactions"}
        </button>
      )}

      {loaded !== null && (
        <p className="acct-history-coverage">
          {nextOffset !== null
            ? `Showing ${transactions.length} of ${loaded.total}.`
            : loaded.coverage}
        </p>
      )}
    </section>
  );
}
