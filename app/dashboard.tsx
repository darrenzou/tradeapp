"use client";

import { useCallback, useEffect, useState } from "react";

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
import type { DashboardData } from "@/lib/dashboard";
import type { AccountBreakdown } from "@/lib/portfolio";
import { isLiability, type LinkedAccount } from "@/lib/net-worth";

type PlaidLinkHandler = { open: () => void; destroy: () => void };
type PlaidLinkMetadata = { institution?: { name?: string } | null };

declare global {
  interface Window {
    Plaid?: {
      create: (config: {
        token: string;
        onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
        onExit: () => void;
      }) => PlaidLinkHandler;
    };
  }
}

type DashboardProps = {
  username: string;
  notice: string;
  isSigningOut: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
};

const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const LOAD_FAILED_MESSAGE = "Accounts couldn't be loaded. Try again.";
const SOURCE_LABELS: Record<LinkedAccount["source"], string> = {
  snaptrade: "SnapTrade",
  plaid: "Plaid",
};

let plaidScriptPromise: Promise<void> | null = null;

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) {
    return Promise.resolve();
  }

  plaidScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      plaidScriptPromise = null;
      script.remove();
      reject(new Error("Plaid Link failed to load"));
    };
    document.head.appendChild(script);
  });

  return plaidScriptPromise;
}

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

// With onSelect, each account opens its breakdown when clicked.
function AccountList({
  accounts,
  emptyText,
  onSelect,
}: {
  accounts: LinkedAccount[];
  emptyText: string;
  onSelect?: (account: LinkedAccount) => void;
}) {
  if (accounts.length === 0) {
    return <p className="dash-empty">{emptyText}</p>;
  }

  return (
    <ul className="dash-accounts">
      {accounts.map((account) => (
        <li key={account.id}>
          {onSelect ? (
            <button
              type="button"
              className="dash-account-button"
              onClick={() => onSelect(account)}
              aria-haspopup="dialog"
            >
              <AccountSummary account={account} />
            </button>
          ) : (
            <div className="dash-account-row">
              <AccountSummary account={account} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const breakdownPercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const breakdownShares = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function AccountBreakdownDialog({
  account,
  breakdown,
  onClose,
}: {
  account: LinkedAccount;
  breakdown: AccountBreakdown | undefined;
  onClose: () => void;
}) {
  const holdings = breakdown?.holdings ?? [];
  const cash = breakdown?.cash ?? 0;
  const stocksValue = holdings.reduce((total, holding) => total + holding.marketValue, 0);
  const total = stocksValue + cash;
  const share = (value: number) => (total > 0 ? breakdownPercent.format(value / total) : "—");
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

      {breakdown?.holdingsAvailable === false ? (
        <p className="detail-note">
          This account&apos;s holdings aren&apos;t available from the brokerage, so only its balance is shown.
        </p>
      ) : (
        <>
          <dl className="detail-split">
            {account.kind === "investment" && (
              <div>
                <dt>Stocks &amp; funds</dt>
                <dd>{formatMoney(stocksValue)} <span>{share(stocksValue)}</span></dd>
              </div>
            )}
            <div>
              <dt>Cash</dt>
              <dd>{formatMoney(cash)} <span>{share(cash)}</span></dd>
            </div>
          </dl>

          {holdings.length > 0 && (
            <table className="detail-table">
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="detail-num">Shares</th>
                  <th scope="col" className="detail-num">Value</th>
                  <th scope="col" className="detail-num">%</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((holding) => (
                  <tr key={holding.key}>
                    <th scope="row" title={holding.name}>
                      <span className="detail-symbol">{holding.ticker ?? holding.name}</span>
                      {holding.ticker && <span className="detail-name">{holding.name}</span>}
                    </th>
                    <td className="detail-num">{breakdownShares.format(holding.shares)}</td>
                    <td className="detail-num">{formatMoney(holding.marketValue)}</td>
                    <td className="detail-num">{share(holding.marketValue)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row"><span className="detail-symbol">Cash</span></th>
                  <td className="detail-num">—</td>
                  <td className="detail-num">{formatMoney(cash)}</td>
                  <td className="detail-num">{share(cash)}</td>
                </tr>
              </tbody>
            </table>
          )}

          {(breakdown?.unreconciled ?? 0) > 0.005 && (
            <p className="detail-note">
              The brokerage reports positions worth {formatMoney(breakdown?.unreconciled ?? 0)} more than
              the account balance, so the breakdown total differs from the balance above.
            </p>
          )}
        </>
      )}
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
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  // Only rendered after the client has restored the session, so window exists.
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [message, setMessage] = useState(() =>
    new URLSearchParams(window.location.search).get("connected") === "brokerage"
      ? "Brokerage connected. New balances can take a few minutes to appear."
      : "",
  );

  const apiFetch = useApiFetch(onSessionExpired);

  const loadDashboard = useCallback(async () => {
    try {
      const response = await apiFetch("/api/dashboard");

      if (response === null) {
        return;
      }

      const body = await readJson(response);

      if (!response.ok || !isRecord(body)) {
        setMessage(errorMessage(body, LOAD_FAILED_MESSAGE));
        return;
      }

      setData(body as DashboardData);
    } catch {
      setMessage(LOAD_FAILED_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  }, [apiFetch]);

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

  async function saveBankConnection(publicToken: string, metadata: PlaidLinkMetadata) {
    setIsConnecting(true);

    try {
      const response = await apiFetch("/api/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicToken, institutionName: metadata.institution?.name ?? null }),
      });

      if (response === null) {
        return;
      }

      if (!response.ok) {
        setMessage(errorMessage(await readJson(response), "Bank connection couldn't be saved."));
        return;
      }

      setMessage("Account connected.");
      await loadDashboard();
    } catch {
      setMessage("Bank connection couldn't be saved.");
    } finally {
      setIsConnecting(false);
    }
  }

  async function connectBank() {
    setMessage("");
    setIsConnecting(true);

    try {
      const [response] = await Promise.all([
        apiFetch("/api/plaid/link-token", { method: "POST" }),
        loadPlaidScript(),
      ]);

      if (response === null) {
        return;
      }

      const body = await readJson(response);

      if (!response.ok || !isRecord(body) || typeof body.linkToken !== "string" || !window.Plaid) {
        setMessage(errorMessage(body, "Bank connection is unavailable."));
        return;
      }

      const handler = window.Plaid.create({
        token: body.linkToken,
        onSuccess: (publicToken, metadata) => {
          handler.destroy();
          void saveBankConnection(publicToken, metadata);
        },
        onExit: () => handler.destroy(),
      });
      handler.open();
    } catch {
      setMessage("Bank connection is unavailable.");
    } finally {
      setIsConnecting(false);
    }
  }

  const assetAccounts = data?.accounts.filter((account) => !isLiability(account.kind)) ?? [];
  const creditAccounts = data?.accounts.filter((account) => account.kind === "credit") ?? [];
  const loanAccounts = data?.accounts.filter((account) => account.kind === "loan") ?? [];
  const liveDayChange = data?.accounts.reduce((total, account) => total + (account.live?.dayChange ?? 0), 0) ?? 0;
  const hasAccounts = (data?.accounts.length ?? 0) + (data?.excludedAccounts.length ?? 0) > 0;
  const busy = isConnecting || isSigningOut;
  const selectedAccount = data?.accounts.find((account) => account.id === selectedAccountId);

  return (
    <main className="dash-page">
      <AppHeader username={username} active="overview" busy={busy} onSignOut={onSignOut} />

      <div className="dash-content">
        {(message || notice) && (
          <p className="dash-message" role="status" aria-live="polite">{notice || message}</p>
        )}

        <section className="dash-hero" aria-labelledby="net-worth-heading">
          <p id="net-worth-heading" className="dash-label dash-hero-label">Net worth</p>
          <p className="dash-hero-value">
            {data ? formatMoney(data.netWorth) : isLoading ? "…" : "—"}
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
              onSelect={(account) => setSelectedAccountId(account.id)}
            />
          </section>

          <section className="dash-card" aria-labelledby="expenses-heading">
            <div className="dash-card-header">
              <h2 id="expenses-heading" className="dash-label">Expenses</h2>
              <p className="dash-card-total dash-negative">{data ? formatMoney(data.creditCardBalance) : "…"}</p>
            </div>
            <p className="dash-card-caption">Current credit card balance</p>
            <AccountList accounts={creditAccounts} emptyText="No credit cards connected yet." />
          </section>

          {loanAccounts.length > 0 && (
            <section className="dash-card" aria-labelledby="loans-heading">
              <div className="dash-card-header">
                <h2 id="loans-heading" className="dash-label">Loans</h2>
                <p className="dash-card-total dash-negative">{formatMoney(data?.loanBalance ?? 0)}</p>
              </div>
              <AccountList accounts={loanAccounts} emptyText="" />
            </section>
          )}
        </div>

        {data && data.excludedAccounts.length > 0 && (
          <section className="dash-card" aria-labelledby="excluded-heading">
            <h2 id="excluded-heading" className="dash-label">Not included in totals</h2>
            <p className="dash-card-caption">These accounts use a currency other than US dollars.</p>
            <AccountList accounts={data.excludedAccounts} emptyText="" />
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
        <AccountBreakdownDialog
          account={selectedAccount}
          breakdown={data?.breakdowns[selectedAccount.id]}
          onClose={() => setSelectedAccountId(null)}
        />
      )}
    </main>
  );
}
