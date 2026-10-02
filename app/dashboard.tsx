"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import AccountTransactions from "./account-transactions";
import AppHeader from "./app-header";
import DetailDialog from "./detail-dialog";
import EditAccounts from "./edit-accounts";
import { displayName, groupAccounts, isHidden, type Section } from "./overview-layout";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "./theme-ui";
import {
  errorMessage,
  formatMoney,
  formatTime,
  isRecord,
  readJson,
  subscribeToLiveRefresh,
  useApiFetch,
} from "./client-api";
import { prefetchResource, refreshResource, setCachedResource, useCachedResource } from "./client-cache";
import { PlaidLinkError, openPlaidLink, saveBankConnection, type PlaidLinkResult } from "./plaid-link";
import type { DashboardData } from "@/lib/dashboard";
import type { LinkedAccount } from "@/lib/net-worth";
import { DEFAULT_OVERVIEW_SETTINGS, type OverviewSettings } from "@/lib/overview-settings";

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

function signedMoney(value: number, currency = "USD"): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatMoney(Math.abs(value), currency)}`;
}

function DayChange({ value, currency = "USD" }: { value: number; currency?: string }) {
  const tone = value > 0 ? "dash-change-up" : value < 0 ? "dash-change-down" : "";

  return <span className={`dash-change ${tone}`}>{signedMoney(value, currency)} today</span>;
}

// With a nickname, the bank's own account name follows the bank.
function accountDetail(account: LinkedAccount, name = account.name): string {
  return [
    account.institution,
    name === account.name ? null : account.name,
    // Brokerages can link through either provider; show which, so a
    // brokerage connected twice is easy to spot.
    account.kind === "investment" ? `via ${SOURCE_LABELS[account.source]}` : null,
    account.live ? "Live" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function AccountRow({
  account,
  name,
  onSelect,
}: {
  account: LinkedAccount;
  name: string;
  onSelect: (account: LinkedAccount) => void;
}) {
  return (
    <li>
      <button type="button" className="dash-account-button" onClick={() => onSelect(account)} aria-haspopup="dialog">
        <span className="dash-account-text">
          <span className="dash-account-name">{name}</span>
          <span className="dash-account-institution">{accountDetail(account, name)}</span>
        </span>
        <span className="dash-account-values">
          <span className="dash-account-balance">{formatMoney(account.balance, account.currency)}</span>
          {account.live && <DayChange value={account.live.dayChange} currency={account.currency} />}
        </span>
      </button>
    </li>
  );
}

// One group of accounts, folding away under its heading. Each account opens
// its transactions when selected. Hidden accounts count in the total but
// aren't listed.
function AccountSection({
  section,
  accounts,
  settings,
  onSelect,
}: {
  section: Section;
  accounts: LinkedAccount[];
  settings: OverviewSettings;
  onSelect: (account: LinkedAccount) => void;
}) {
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  const headingId = `section-${section.id}`;

  return (
    <details
      className="dash-section"
      open
      style={{ "--section-tint": section.tint, "--section-ink": section.ink } as CSSProperties}
    >
      <summary className="dash-section-summary">
        <h2 id={headingId} className="dash-section-title">
          <Icon name={section.icon} size={18} strokeWidth={2.2} />
          {section.title}
        </h2>
        <span className="dash-section-total">
          {formatMoney(total)}
          <Icon name="chevronDown" size={16} strokeWidth={2.4} />
        </span>
      </summary>
      <ul className="dash-accounts" aria-labelledby={headingId}>
        {accounts
          .filter((account) => !isHidden(account, settings))
          .map((account) => (
            <AccountRow key={account.id} account={account} name={displayName(account, settings)} onSelect={onSelect} />
          ))}
      </ul>
    </details>
  );
}

// Placeholder sections while the first load is in flight.
function LoadingSections() {
  return (
    <>
      {[3, 3, 2].map((rows, index) => (
        <div key={index} className="dash-section" aria-hidden="true">
          <div className="dash-section-summary">
            <Skeleton width="150px" height="22px" />
            <Skeleton width="96px" />
          </div>
          <ul className="dash-accounts">
            {Array.from({ length: rows }, (_, row) => (
              <li key={row} className="dash-account-button">
                <span className="dash-account-text">
                  <Skeleton width="140px" />
                  <Skeleton width="90px" height="10px" />
                </span>
                <Skeleton width="84px" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

const BALANCE_LABELS: Record<LinkedAccount["kind"], string> = {
  cash: "Balance",
  investment: "Account value",
  other: "Balance",
  credit: "Balance owed",
  loan: "Balance owed",
};

function AccountDialog({
  account,
  name,
  apiFetch,
  onClose,
}: {
  account: LinkedAccount;
  name: string;
  apiFetch: ReturnType<typeof useApiFetch>;
  onClose: () => void;
}) {
  const subtitle =
    account.kind === "investment"
      ? `${account.institution} · via ${SOURCE_LABELS[account.source]}`
      : account.institution;

  return (
    <DetailDialog title={name} subtitle={subtitle} onClose={onClose}>
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(account.balance, account.currency)}</p>
        <p className="detail-summary-label">
          {BALANCE_LABELS[account.kind]}
          {account.live && (
            <>
              {" · "}
              <DayChange value={account.live.dayChange} currency={account.currency} />
            </>
          )}
        </p>
      </div>
      <AccountTransactions key={account.id} accountId={account.id} apiFetch={apiFetch} />
    </DetailDialog>
  );
}

function AddAccountDialog({
  busy,
  onBrokerage,
  onBank,
  onClose,
}: {
  busy: boolean;
  onBrokerage: () => void;
  onBank: () => void;
  onClose: () => void;
}) {
  return (
    <DetailDialog title="Add an account" onClose={onClose}>
      <p className="detail-caption">
        Most brokerages connect read-only through SnapTrade. Banks, credit cards, and brokerages SnapTrade
        doesn&apos;t support, such as Merrill, connect through Plaid.
      </p>
      <div className="dash-connect-actions">
        <button type="button" className="pill-button pill-button-primary" onClick={onBrokerage} disabled={busy}>
          Connect brokerage
        </button>
        <button type="button" className="pill-button" onClick={onBank} disabled={busy}>
          Connect bank or card
        </button>
      </div>
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
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
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

  const liveDayChange = data?.accounts.reduce((total, account) => total + (account.live?.dayChange ?? 0), 0) ?? 0;
  const hasAccounts =
    (data?.accounts.length ?? 0) + (data?.excludedAccounts.length ?? 0) + (data?.removedAccounts?.length ?? 0) > 0;
  const busy = isConnecting || isSigningOut;
  const selectedAccount = [...(data?.accounts ?? []), ...(data?.excludedAccounts ?? [])].find(
    (account) => account.id === selectedAccountId,
  );
  const selectAccount = (account: LinkedAccount) => setSelectedAccountId(account.id);
  // Data cached before Edit accounts existed has no settings.
  const settings = data?.settings ?? DEFAULT_OVERVIEW_SETTINGS;
  const removedAccounts = data?.removedAccounts ?? [];
  const sections = groupAccounts(data?.accounts ?? [], settings);
  const accountCount = data?.accounts.length ?? 0;
  const hiddenCount = data?.accounts.filter((account) => isHidden(account, settings)).length ?? 0;
  const isLoading = data === null && !loadError;

  function saveSettings(saved: OverviewSettings) {
    setShowEdit(false);

    if (data) {
      setCachedResource("dashboard", { ...data, settings: saved });
    }

    // Removing or restoring an account changes the totals.
    void loadDashboard({ force: true });
  }

  function startConnect(connect: () => Promise<void>) {
    setShowAdd(false);
    void connect();
  }

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

        <section className="dash-hero" aria-labelledby="net-worth-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="net-worth-heading" className="dash-label">Net worth</h1>
            <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
          </div>
          <p className="dash-hero-value">
            {data ? <HeroAmount value={data.netWorth} /> : loadError ? "—" : <Skeleton width="62%" height="44px" />}
          </p>
          {data?.pricesAsOf ? (
            <p
              className={`hero-pill ${liveDayChange < 0 ? "hero-pill-down" : ""}`}
              title={`Live stock and ETF prices · last trade ${formatTime(data.pricesAsOf)}`}
            >
              <Icon name={liveDayChange < 0 ? "trendDown" : "trendUp"} size={16} strokeWidth={2.4} />
              {signedMoney(liveDayChange)} today
            </p>
          ) : (
            isLoading && <Skeleton width="168px" height="32px" className="skeleton-pill" />
          )}
        </section>

        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        <div className="dash-toolbar">
          <div>
            <h2 className="dash-toolbar-title">Accounts</h2>
            <p className="dash-toolbar-caption">
              {data
                ? hasAccounts
                  ? `${hiddenCount > 0 ? `${hiddenCount} hidden` : `${accountCount} ${accountCount === 1 ? "account" : "accounts"}`} · counted in totals`
                  : "None connected yet"
                : isLoading && <Skeleton width="120px" height="10px" />}
            </p>
          </div>
          <div className="dash-toolbar-actions">
            <button
              type="button"
              className="pill-button"
              onClick={() => setShowAdd(true)}
              disabled={busy}
              aria-haspopup="dialog"
            >
              <Icon name="plus" size={16} strokeWidth={2.4} />
              Add
            </button>
            {data && accountCount + removedAccounts.length > 0 && (
              <button
                type="button"
                className="pill-button"
                onClick={() => setShowEdit(true)}
                disabled={busy}
                aria-haspopup="dialog"
                aria-label="Edit accounts"
              >
                <Icon name="pencil" size={15} strokeWidth={2.2} />
                Edit
              </button>
            )}
          </div>
        </div>

        {isLoading && (
          <div className="dash-sections">
            <LoadingSections />
          </div>
        )}

        {data && !hasAccounts && (
          <section className="dash-card dash-connect" aria-labelledby="connect-heading">
            <h2 id="connect-heading" className="dash-connect-title">Connect your accounts</h2>
            <p className="dash-card-caption">
              Most brokerages connect read-only through SnapTrade. Banks, credit cards, and brokerages
              SnapTrade doesn&apos;t support, such as Merrill, connect through Plaid.
            </p>
            <div className="dash-connect-actions">
              <button type="button" className="pill-button pill-button-primary" onClick={() => void connectBrokerage()} disabled={busy}>
                Connect brokerage
              </button>
              <button type="button" className="pill-button" onClick={() => void connectBank()} disabled={busy}>
                Connect bank or card
              </button>
            </div>
          </section>
        )}

        {sections.length > 0 && (
          <div className="dash-sections">
            {sections.map(({ section, accounts }) => (
              <AccountSection
                key={section.id}
                section={section}
                accounts={accounts}
                settings={settings}
                onSelect={selectAccount}
              />
            ))}
          </div>
        )}

        {data && data.excludedAccounts.length > 0 && (
          <section className="dash-card" aria-labelledby="excluded-heading">
            <h2 id="excluded-heading" className="dash-card-title">Not included in totals</h2>
            <p className="dash-card-caption">These accounts use a currency other than US dollars.</p>
            <ul className="dash-accounts">
              {data.excludedAccounts.map((account) => (
                <AccountRow key={account.id} account={account} name={account.name} onSelect={selectAccount} />
              ))}
            </ul>
          </section>
        )}
      </div>

      {selectedAccount && (
        <AccountDialog
          account={selectedAccount}
          name={displayName(selectedAccount, settings)}
          apiFetch={apiFetch}
          onClose={() => setSelectedAccountId(null)}
        />
      )}

      {showEdit && data && (
        <EditAccounts
          accounts={data.accounts}
          removedAccounts={removedAccounts}
          settings={settings}
          apiFetch={apiFetch}
          onSaved={saveSettings}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showAdd && (
        <AddAccountDialog
          busy={busy}
          onBrokerage={() => startConnect(connectBrokerage)}
          onBank={() => startConnect(connectBank)}
          onClose={() => setShowAdd(false)}
        />
      )}
    </main>
  );
}
