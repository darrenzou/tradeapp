"use client";

import { useCallback, useEffect, useState } from "react";

import AccountTransactions from "./account-transactions";
import AppHeader from "./app-header";
import DetailDialog from "./detail-dialog";
import {
  errorMessage,
  formatMoney,
  formatTime,
  isRecord,
  readJson,
  subscribeToLiveRefresh,
  useApiFetch,
} from "./client-api";
import { prefetchResource, refreshResource, useCachedResource } from "./client-cache";
import { PlaidLinkError, openPlaidLink, saveBankConnection, type PlaidLinkResult } from "./plaid-link";
import type { DashboardData } from "@/lib/dashboard";
import { isLiability, type LinkedAccount } from "@/lib/net-worth";

type DashboardProps = {
  username: string;
  notice: string;
  isSigningOut: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
};

const LOAD_FAILED_MESSAGE = "Accounts couldn't be loaded. Try again.";
const SOURCE_LABELS: Record<LinkedAccount["source"], string> = {
  snaptrade: "SnapTrade",
  plaid: "Plaid",
};

function DayChange({ value, currency = "USD" }: { value: number; currency?: string }) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const tone = value > 0 ? "dash-change-up" : value < 0 ? "dash-change-down" : "";

  return (
    <p className={`dash-change ${tone}`}>
      {sign}
      {formatMoney(Math.abs(value), currency)} today
    </p>
  );
}

function AccountSummary({ account }: { account: LinkedAccount }) {
  return (
    <>
      <div>
        <p className="dash-account-name">{account.name}</p>
        <p className="dash-account-institution">
          {account.institution}
          {/* Brokerages can link through either provider; show which, so a
              brokerage connected twice is easy to spot. */}
          {account.kind === "investment" && ` · via ${SOURCE_LABELS[account.source]}`}
          {account.live && " · Live"}
        </p>
      </div>
      <div className="dash-account-values">
        <p className="dash-account-balance">{formatMoney(account.balance, account.currency)}</p>
        {account.live && <DayChange value={account.live.dayChange} currency={account.currency} />}
      </div>
    </>
  );
}

// Each account opens its transactions when clicked.
function AccountList({
  accounts,
  emptyText,
  onSelect,
}: {
  accounts: LinkedAccount[];
  emptyText: string;
  onSelect: (account: LinkedAccount) => void;
}) {
  if (accounts.length === 0) {
    return <p className="dash-empty">{emptyText}</p>;
  }

  return (
    <ul className="dash-accounts">
      {accounts.map((account) => (
        <li key={account.id}>
          <button
            type="button"
            className="dash-account-button"
            onClick={() => onSelect(account)}
            aria-haspopup="dialog"
          >
            <AccountSummary account={account} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function AccountDialog({
  account,
  apiFetch,
  onClose,
}: {
  account: LinkedAccount;
  apiFetch: ReturnType<typeof useApiFetch>;
  onClose: () => void;
}) {
  const subtitle =
    account.kind === "investment"
      ? `${account.institution} · via ${SOURCE_LABELS[account.source]}`
      : account.institution;

  return (
    <DetailDialog title={account.name} subtitle={subtitle} onClose={onClose}>
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(account.balance, account.currency)}</p>
        {account.live && <DayChange value={account.live.dayChange} currency={account.currency} />}
      </div>
      <AccountTransactions key={account.id} accountId={account.id} apiFetch={apiFetch} />
    </DetailDialog>
  );
}

export default function Dashboard({
  username,
  notice,
  isSigningOut,
  onSignOut,
  onSessionExpired,
}: DashboardProps) {
  // The last loaded data shows at once (e.g. when returning from Stocks)
  // while a fresh copy loads in the background.
  const { entry, showUpdating } = useCachedResource<DashboardData>("dashboard");
  const data = entry?.data ?? null;
  const [loadError, setLoadError] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  // Only rendered after the client has restored the session, so window exists.
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [message, setMessage] = useState(() =>
    new URLSearchParams(window.location.search).get("connected") === "brokerage"
      ? "Brokerage connected. New balances can take a few minutes to appear."
      : "",
  );

  const apiFetch = useApiFetch(onSessionExpired);

  const loadDashboard = useCallback(
    async (options?: { force?: boolean }) => {
      try {
        await refreshResource("dashboard", apiFetch, options);
        setLoadError("");
        // Warm the Stocks page so the first switch to it is instant too.
        prefetchResource("stocks", apiFetch);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : LOAD_FAILED_MESSAGE);
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    return subscribeToLiveRefresh(loadDashboard);
  }, [loadDashboard]);

  async function connectBrokerage() {
    setMessage("");
    setIsConnecting(true);

    try {
      const response = await apiFetch("/api/snaptrade/connect", { method: "POST" });

      if (response === null) {
        return;
      }

      const body = await readJson(response);

      if (!response.ok || !isRecord(body) || typeof body.url !== "string") {
        setMessage(errorMessage(body, "Brokerage connection is unavailable."));
        return;
      }

      window.location.assign(body.url);
    } catch {
      setMessage("Brokerage connection is unavailable.");
    } finally {
      setIsConnecting(false);
    }
  }

  async function saveBank(link: PlaidLinkResult) {
    setIsConnecting(true);

    try {
      const { saved, error } = await saveBankConnection(apiFetch, link);

      if (!saved) {
        setMessage(error ?? "");
        return;
      }

      setMessage("Account connected.");
      // New accounts change every page's data.
      await loadDashboard({ force: true });
      refreshResource("stocks", apiFetch, { force: true }).catch(() => undefined);
      refreshResource("spending", apiFetch, { force: true }).catch(() => undefined);
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectBank() {
    setMessage("");
    setIsConnecting(true);
    let link: PlaidLinkResult | null;

    try {
      link = await openPlaidLink(apiFetch);
    } catch (error) {
      setMessage(error instanceof PlaidLinkError ? error.message : "Bank connection is unavailable.");
      return;
    } finally {
      setIsConnecting(false);
    }

    if (link !== null) {
      await saveBank(link);
    }
  }

  const assetAccounts = data?.accounts.filter((account) => !isLiability(account.kind)) ?? [];
  const creditAccounts = data?.accounts.filter((account) => account.kind === "credit") ?? [];
  const loanAccounts = data?.accounts.filter((account) => account.kind === "loan") ?? [];
  const liveDayChange = data?.accounts.reduce((total, account) => total + (account.live?.dayChange ?? 0), 0) ?? 0;
  const hasAccounts = (data?.accounts.length ?? 0) + (data?.excludedAccounts.length ?? 0) > 0;
  const busy = isConnecting || isSigningOut;
  const selectedAccount = [...(data?.accounts ?? []), ...(data?.excludedAccounts ?? [])].find(
    (account) => account.id === selectedAccountId,
  );
  const selectAccount = (account: LinkedAccount) => setSelectedAccountId(account.id);

  return (
    <main className="dash-page">
      <AppHeader
        username={username}
        active="overview"
        busy={busy}
        onSignOut={onSignOut}
        onSessionExpired={onSessionExpired}
      />

      <div className="dash-content">
        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? `Couldn't refresh your accounts. Showing data from ${formatTime(new Date(entry.fetchedAt).toISOString())}.`
              : loadError}
          </p>
        )}

        {(message || notice) && (
          <p className="dash-message" role="status" aria-live="polite">{notice || message}</p>
        )}

        <section className="dash-hero" aria-labelledby="net-worth-heading">
          <p id="net-worth-heading" className="dash-label dash-hero-label">
            Net worth
            <span className="dash-updating" aria-live="polite">{showUpdating ? " · Updating…" : ""}</span>
          </p>
          <p className="dash-hero-value">
            {data ? formatMoney(data.netWorth) : loadError ? "—" : "…"}
          </p>
          {data && (
            <p className="dash-hero-breakdown">
              {formatMoney(data.assets)} in assets − {formatMoney(data.creditCardBalance)} in credit card balances
              {data.loanBalance > 0 && <> − {formatMoney(data.loanBalance)} in loans</>}
            </p>
          )}
          {data?.pricesAsOf && (
            <div className="dash-hero-live">
              <DayChange value={liveDayChange} />
              <p>Live stock and ETF prices · last trade {formatTime(data.pricesAsOf)}</p>
            </div>
          )}
        </section>

        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        <div className="dash-grid">
          <section className="dash-card" aria-labelledby="assets-heading">
            <div className="dash-card-header">
              <h2 id="assets-heading" className="dash-label">Assets</h2>
              <p className="dash-card-total">{data ? formatMoney(data.assets) : "…"}</p>
            </div>
            <AccountList
              accounts={assetAccounts}
              emptyText="No brokerage, bank, or savings accounts yet."
              onSelect={selectAccount}
            />
          </section>

          <section className="dash-card" aria-labelledby="expenses-heading">
            <div className="dash-card-header">
              <h2 id="expenses-heading" className="dash-label">Expenses</h2>
              <p className="dash-card-total dash-negative">{data ? formatMoney(data.creditCardBalance) : "…"}</p>
            </div>
            <p className="dash-card-caption">Current credit card balance</p>
            <AccountList accounts={creditAccounts} emptyText="No credit cards connected yet." onSelect={selectAccount} />
          </section>

          {loanAccounts.length > 0 && (
            <section className="dash-card" aria-labelledby="loans-heading">
              <div className="dash-card-header">
                <h2 id="loans-heading" className="dash-label">Loans</h2>
                <p className="dash-card-total dash-negative">{formatMoney(data?.loanBalance ?? 0)}</p>
              </div>
              <AccountList accounts={loanAccounts} emptyText="" onSelect={selectAccount} />
            </section>
          )}
        </div>

        {data && data.excludedAccounts.length > 0 && (
          <section className="dash-card" aria-labelledby="excluded-heading">
            <h2 id="excluded-heading" className="dash-label">Not included in totals</h2>
            <p className="dash-card-caption">These accounts use a currency other than US dollars.</p>
            <AccountList accounts={data.excludedAccounts} emptyText="" onSelect={selectAccount} />
          </section>
        )}

        <section className="dash-card dash-connect" aria-labelledby="connect-heading">
          <div>
            <h2 id="connect-heading" className="dash-connect-title">
              {hasAccounts ? "Add another account" : "Connect your accounts"}
            </h2>
            <p className="dash-card-caption">
              Most brokerages connect read-only through SnapTrade. Banks, credit cards, and brokerages
              SnapTrade doesn&apos;t support, such as Merrill, connect through Plaid.
            </p>
          </div>
          <div className="dash-connect-actions">
            <button type="button" className="auth-submit" onClick={() => void connectBrokerage()} disabled={busy}>
              Connect brokerage
            </button>
            <button type="button" className="auth-switch" onClick={() => void connectBank()} disabled={busy}>
              Connect bank or card
            </button>
          </div>
        </section>
      </div>

      {selectedAccount && (
        <AccountDialog account={selectedAccount} apiFetch={apiFetch} onClose={() => setSelectedAccountId(null)} />
      )}
    </main>
  );
}
