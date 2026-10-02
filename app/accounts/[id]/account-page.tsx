"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { MonthFlows, TransactionMonths, isPage, monthFlows } from "../../account-transactions";
import { errorMessage, formatMoney, isRecord, readJson, useApiFetch } from "../../client-api";
import { refreshResource, useCachedResource } from "../../client-cache";
import { BALANCE_LABELS, displayName } from "../../overview-layout";
import { HeroAmount, Icon, Skeleton } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import type { AccountTransaction, AccountTransactionsPage } from "@/lib/account-history";
import type { DashboardData } from "@/lib/dashboard";
import { DEFAULT_OVERVIEW_SETTINGS } from "@/lib/overview-settings";

const LOAD_FAILED_MESSAGE = "Transactions couldn't be loaded. Try again.";
// Rows rendered at a time; "Show more" adds the next batch.
const BATCH = 100;

type Loaded = Pick<AccountTransactionsPage, "transactions" | "notice" | "coverage" | "imported">;
type ApiFetch = ReturnType<typeof useApiFetch>;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// What a search matches: the name, the second line, the month and the
// amount as typed ("12.5", "12.50" or "$12.50").
function searchText(transaction: AccountTransaction): string {
  const amount = Math.abs(transaction.amount);
  const month = new Date(`${transaction.date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return [
    transaction.description,
    transaction.detail ?? "",
    month,
    amount.toFixed(2),
    String(amount),
    formatMoney(amount, transaction.currency),
  ]
    .join(" ")
    .toLowerCase();
}

function count(value: number): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? "transaction" : "transactions"}`;
}

function AccountView({ accountId, onSessionExpired }: { accountId: string; onSessionExpired: () => void }) {
  const apiFetch = useApiFetch(onSessionExpired);
  const { entry } = useCachedResource<DashboardData>("dashboard");
  const data = entry?.data ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(BATCH);

  // The account's name and balance come from the Overview's data.
  useEffect(() => {
    refreshResource("dashboard", apiFetch).catch(() => undefined);
  }, [apiFetch]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`/api/accounts/transactions?account=${encodeURIComponent(accountId)}&all=1`);

        if (response === null || cancelled) {
          return;
        }

        const body = await readJson(response);

        if (cancelled) {
          return;
        }

        if (!response.ok || !isPage(body)) {
          setError(errorMessage(body, LOAD_FAILED_MESSAGE));
          return;
        }

        setLoaded({
          transactions: body.transactions,
          notice: body.notice,
          coverage: body.coverage,
          imported: body.imported ?? null,
        });
      } catch {
        if (!cancelled) {
          setError(LOAD_FAILED_MESSAGE);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [accountId, apiFetch, attempt]);

  const account =
    [...(data?.accounts ?? []), ...(data?.excludedAccounts ?? []), ...(data?.removedAccounts ?? [])].find(
      (candidate) => candidate.id === accountId,
    ) ?? null;
  const name = account ? displayName(account, data?.settings ?? DEFAULT_OVERVIEW_SETTINGS) : null;
  // With a nickname, the bank's own account name follows the bank.
  const subtitle = account
    ? [account.institution, name === account.name ? null : account.name].filter(Boolean).join(" · ")
    : null;
  const transactions = loaded?.transactions ?? [];
  const search = query.trim().toLowerCase();
  const matches =
    search === "" ? transactions : transactions.filter((transaction) => searchText(transaction).includes(search));
  const flows = loaded === null ? null : monthFlows(transactions, true);
  const currency = account?.currency ?? transactions[0]?.currency ?? "USD";

  return (
    <main className="dash-page hd-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href="/" className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            Overview
          </Link>
        </div>

        <section className="dash-hero" aria-labelledby="account-heading">
          <h1 id="account-heading" className="hd-title at-title">
            <span className="hd-symbol at-name">{name ?? <Skeleton width="160px" height="22px" />}</span>
            {subtitle && <span className="hd-name">{subtitle}</span>}
          </h1>
          <p className="dash-hero-value">
            {account ? <HeroAmount value={account.balance} /> : <Skeleton width="50%" height="44px" />}
          </p>
          {account && <p className="dash-label at-balance-label">{BALANCE_LABELS[account.kind]}</p>}
        </section>

        {flows !== null && <MonthFlows flows={flows} currency={currency} />}

        {loaded?.notice && <p className="detail-note">{loaded.notice}</p>}

        <section
          className="dash-card sp-section"
          aria-labelledby="all-transactions-heading"
          aria-busy={loaded === null && !error}
        >
          <div className="dash-card-header">
            <h2 id="all-transactions-heading" className="sp-card-title">
              {loaded === null
                ? "Transactions"
                : search === ""
                  ? count(transactions.length)
                  : `${count(matches.length)} found`}
            </h2>
            <span className="sp-card-note">Newest first</span>
          </div>
          <label className="sp-search">
            <Icon name="search" size={18} strokeWidth={2.2} />
            <span className="stocks-sr-only">Search transactions</span>
            <input
              type="search"
              value={query}
              placeholder="Search name, category or amount"
              onChange={(event) => {
                setQuery(event.target.value);
                setShown(BATCH);
              }}
            />
          </label>

          <div className="at-list">
            {loaded === null && !error && (
              <ul className="acct-txns" aria-label="Loading transactions">
                {[0, 1, 2, 3, 4, 5].map((row) => (
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

            {error && (
              <div className="acct-history-error" role="alert">
                <p>{error}</p>
                <button
                  type="button"
                  className="pill-button"
                  onClick={() => {
                    setError("");
                    setAttempt((value) => value + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            )}

            {loaded !== null && transactions.length === 0 && <p className="dash-empty">No transactions yet.</p>}
            {loaded !== null && transactions.length > 0 && matches.length === 0 && (
              <p className="dash-empty">Nothing matches &ldquo;{query.trim()}&rdquo;.</p>
            )}

            <TransactionMonths transactions={matches.slice(0, shown)} />

            {matches.length > shown && (
              <button
                type="button"
                className="pill-button pill-button-soft acct-history-more"
                onClick={() => setShown((value) => value + BATCH)}
              >
                Show more ({matches.length - shown} left)
              </button>
            )}
          </div>
        </section>

        {loaded !== null && loaded.imported !== null && (
          <ImportOlder
            accountId={accountId}
            bank={account?.institution ?? null}
            coverage={loaded.coverage}
            imported={loaded.imported}
            apiFetch={apiFetch}
            onChanged={() => setAttempt((value) => value + 1)}
          />
        )}
      </div>
    </main>
  );
}

// Plaid shares only so much history (some banks give it a few months), so
// older transactions can be imported from a CSV downloaded from the bank.
function ImportOlder({
  accountId,
  bank,
  coverage,
  imported,
  apiFetch,
  onChanged,
}: {
  accountId: string;
  bank: string | null;
  coverage: string | null;
  imported: number;
  apiFetch: ApiFetch;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // Added from a bank file rather than linked: the file is all it has.
  const fileOnly = accountId.startsWith("import:");

  async function send(method: "POST" | "DELETE", body: Record<string, unknown>, done: (result: unknown) => string) {
    setBusy(true);
    setMessage("");

    try {
      const response = await apiFetch("/api/accounts/import", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: accountId, ...body }),
      });

      if (response === null) {
        return;
      }

      const result = await readJson(response);

      if (!response.ok) {
        setMessage(errorMessage(result, "That didn't work. Try again."));
        return;
      }

      setMessage(done(result));
      // Spending counts imported transactions too, and a file-only account's
      // balance comes from its file.
      refreshResource("spending", apiFetch, { force: true }).catch(() => undefined);
      refreshResource("dashboard", apiFetch, { force: true }).catch(() => undefined);

      if (fileOnly && method === "DELETE") {
        router.push("/");
        return;
      }

      onChanged();
    } catch {
      setMessage("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    let csv: string;

    try {
      csv = await file.text();
    } catch {
      setMessage("That file couldn't be read.");
      return;
    }

    await send("POST", { csv }, (result) => {
      const added = isRecord(result) && typeof result.imported === "number" ? result.imported : 0;
      const skipped = isRecord(result) && typeof result.skipped === "number" ? result.skipped : 0;
      return `Imported ${count(added)}${skipped > 0 ? `, skipped ${skipped} rows without a date or amount` : ""}.${
        fileOnly ? "" : " Ones Plaid already has aren't counted twice."
      }`;
    });
  }

  return (
    <section className="dash-card sp-section at-import" aria-labelledby="import-heading">
      <div className="dash-card-header">
        <h2 id="import-heading" className="sp-card-title">
          {fileOnly ? "Bank file" : "Older transactions"}
        </h2>
      </div>
      {coverage && <p className="at-import-text">{coverage}</p>}
      <p className="at-import-text">
        {fileOnly
          ? `This account isn't linked, so it updates only when you import a newer download from ${bank ?? "your bank"}. The new file replaces the old one.`
          : imported > 0
            ? `You imported ${count(imported)} from a bank file. Importing another file replaces them.`
            : `Download your transactions as a CSV file from ${bank ?? "your bank"}'s website and import it here to see older history.`}
      </p>
      <div className="at-import-actions">
        <button
          type="button"
          className="pill-button pill-button-primary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Icon name="upload" size={18} strokeWidth={2.2} />
          {busy ? "Working…" : imported > 0 || fileOnly ? "Import a new file" : "Import a CSV file"}
        </button>
        {fileOnly ? (
          <button
            type="button"
            className={confirmDelete ? "pill-button at-import-danger" : "pill-button"}
            disabled={busy}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }

              void send("DELETE", {}, () => "Deleted the account.");
            }}
          >
            {confirmDelete ? "Tap again to delete" : "Delete account"}
          </button>
        ) : (
          imported > 0 && (
            <button
              type="button"
              className="pill-button"
              disabled={busy}
              onClick={() => void send("DELETE", {}, () => "Removed the imported transactions.")}
            >
              Remove
            </button>
          )
        )}
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="stocks-sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";

            if (file !== undefined) {
              void importFile(file);
            }
          }}
        />
      </div>
      {message && (
        <p className="at-import-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

// Every transaction for one account, with search. Opened from the account's
// sheet on the Overview.
export default function AccountPage({ accountParam }: { accountParam: string }) {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <AccountView key={accountParam} accountId={safeDecode(accountParam)} onSessionExpired={onSessionExpired} />;
}
