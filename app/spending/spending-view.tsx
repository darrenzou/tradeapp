"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import AppHeader from "../app-header";
import DetailDialog from "../detail-dialog";
import { formatMoney, formatTime, useApiFetch } from "../client-api";
import { refreshResource, useCachedResource } from "../client-cache";
import { PlaidLinkError, openPlaidLink, saveBankConnection } from "../plaid-link";
import MonthBars from "./month-bars";
import { dateLabel, monthLabel, signedMoney, tone } from "./spending-format";
import type { IncomeEntry, MonthTotals } from "@/lib/cashflow";
import {
  DEFAULT_FILING_STATUS,
  FILING_STATUS_LABELS,
  estimateFederalTax,
  type FilingStatus,
} from "@/lib/federal-tax";
import type { SpendingData } from "@/lib/spending";

type SpendingViewProps = {
  username: string;
  isSigningOut: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
};

type ViewMode = "month" | "year";

// Which deposits a breakdown dialog lists: income or gifts, for a month
// (YYYY-MM) or a year (YYYY).
type Breakdown = { kind: "income" | "gifts"; period: string };

const LOAD_FAILED_MESSAGE = "Spending couldn't be loaded. Try again.";

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const wholeMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function sum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

function addCategories(months: MonthTotals[]): [string, number][] {
  const totals = new Map<string, number>();

  for (const month of months) {
    for (const [category, amount] of Object.entries(month.categories)) {
      totals.set(category, (totals.get(category) ?? 0) + amount);
    }
  }

  return [...totals.entries()]
    .map(([category, amount]): [string, number] => [category, Math.round(amount * 100) / 100])
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => b[1] - a[1]);
}

function bySource(entries: IncomeEntry[]): [string, number][] {
  const totals = new Map<string, number>();

  for (const entry of entries) {
    totals.set(entry.source, (totals.get(entry.source) ?? 0) + entry.amount);
  }

  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

function PeriodStepper({
  label,
  onPrevious,
  onNext,
}: {
  label: string;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  return (
    <div className="spend-stepper">
      <button type="button" onClick={onPrevious ?? undefined} disabled={onPrevious === null} aria-label="Previous">
        <span aria-hidden="true">‹</span>
      </button>
      <span className="spend-stepper-label" aria-live="polite">{label}</span>
      <button type="button" onClick={onNext ?? undefined} disabled={onNext === null} aria-label="Next">
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

function CategoryBars({ categories, total }: { categories: [string, number][]; total: number }) {
  if (categories.length === 0) {
    return <p className="dash-empty">No spending recorded.</p>;
  }

  const largest = Math.max(...categories.map(([, amount]) => amount), 0);

  return (
    <ul className="spend-bars">
      {categories.map(([category, amount]) => (
        <li key={category}>
          <div className="spend-bar-row">
            <span className="spend-bar-label">{category}</span>
            <span className="spend-bar-value">
              {formatMoney(amount)}
              <span>{total > 0 && amount > 0 ? percentFormatter.format(amount / total) : ""}</span>
            </span>
          </div>
          <div className="spend-bar-track" aria-hidden="true">
            <div
              className="spend-bar-fill"
              style={{ width: largest > 0 ? `${Math.max(0, (amount / largest) * 100)}%` : "0%" }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SourceList({
  sources,
  onOpen,
  openLabel,
  empty,
}: {
  sources: [string, number][];
  onOpen: () => void;
  openLabel: string;
  empty: string;
}) {
  return (
    <>
      {sources.length === 0 ? (
        <p className="dash-empty">{empty}</p>
      ) : (
        <ul className="spend-sources">
          {sources.map(([source, amount]) => (
            <li key={source}>
              <span>{source}</span>
              <span className="spend-bar-value">{formatMoney(amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <button type="button" className="dash-link-button spend-open" onClick={onOpen} aria-haspopup="dialog">
          {openLabel}
        </button>
      )}
    </>
  );
}

function BreakdownDialog({
  breakdown,
  entries,
  onClose,
}: {
  breakdown: Breakdown;
  entries: IncomeEntry[];
  onClose: () => void;
}) {
  const period = breakdown.period.length === 4 ? breakdown.period : monthLabel(breakdown.period);
  const total = sum(entries.map((entry) => entry.amount));
  const isGifts = breakdown.kind === "gifts";

  return (
    <DetailDialog
      title={`${isGifts ? "Gifts" : "Income"} · ${period}`}
      subtitle={isGifts ? "Deposits with no identified source" : "Each deposit counted as income"}
      onClose={onClose}
    >
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(total)}</p>
        <p className="detail-summary-caption">
          {entries.length} {entries.length === 1 ? "deposit" : "deposits"}
        </p>
      </div>

      {isGifts && (
        <p className="detail-note">
          Money that arrived without a paycheck, interest, dividend, or other income label, and that
          didn&apos;t match a transfer out of another linked account. Transfers from accounts you haven&apos;t
          linked can show up here too.
        </p>
      )}

      {entries.length === 0 ? (
        <p className="dash-empty">Nothing received in this period.</p>
      ) : (
        <table className="detail-table">
          <thead>
            <tr>
              <th scope="col">Received</th>
              <th scope="col">From</th>
              <th scope="col" className="detail-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="spend-date">{dateLabel(entry.date)}</td>
                <th scope="row">
                  <span className="detail-symbol">{entry.name}</span>
                  <span className="detail-name">
                    {isGifts ? entry.accountName : `${entry.source} · ${entry.accountName}`}
                  </span>
                </th>
                <td className="detail-num">{formatMoney(entry.amount)}</td>
              </tr>
            ))}
          </tbody>
          {entries.length > 1 && (
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>Total</th>
                <td className="detail-num">{formatMoney(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </DetailDialog>
  );
}

function CoverageNotice({
  data,
  reconnecting,
  onReconnect,
}: {
  data: SpendingData;
  reconnecting: string | null;
  onReconnect: (itemId: string) => void;
}) {
  const { coverage } = data;

  if (!data.hasBanks) {
    return null;
  }

  if (coverage.earliest === null) {
    return (
      <p className="dash-issue">
        {coverage.stillLoading
          ? "Plaid is still fetching your transaction history. Check back in a few minutes."
          : "No bank or card transactions have come through from Plaid yet."}
      </p>
    );
  }

  const short = coverage.institutions.filter((institution) => institution.canFetchMore);

  if (coverage.earliest <= coverage.windowStart && !coverage.stillLoading && short.length === 0) {
    return null;
  }

  const byBank = coverage.institutions
    .filter((institution) => institution.earliest !== null)
    .map((institution) => `${institution.name} from ${monthLabel(institution.earliest!.slice(0, 7))}`)
    .join(", ");

  return (
    <div className="dash-issue spend-coverage">
      <p>
        This page covers 3 years, but Plaid provides at most {coverage.maxPlaidMonths} months of bank and card
        history, and only what each bank shares. Your transactions start in{" "}
        {monthLabel(coverage.earliest.slice(0, 7))}
        {coverage.institutions.length > 1 ? ` (${byBank})` : ""}, so earlier months show no data.
        {coverage.stillLoading && " Plaid is still fetching older history for at least one bank."}
      </p>
      {short.length > 0 && (
        <>
          <p>
            {short.length === 1 ? `${short[0].name} was` : "These banks were"} connected when the app asked Plaid
            for only 6 months. Reconnect to fetch up to {coverage.maxPlaidMonths} months: you&apos;ll sign in to the
            bank again, and the old connection is removed once the new one is saved.
          </p>
          <div className="spend-reconnect">
            {short.map((institution) => (
              <button
                key={institution.itemId}
                type="button"
                className="spend-reconnect-button"
                onClick={() => onReconnect(institution.itemId)}
                disabled={reconnecting !== null}
              >
                {reconnecting === institution.itemId ? "Reconnecting…" : `Reconnect ${institution.name}`}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function SpendingView({ username, isSigningOut, onSignOut, onSessionExpired }: SpendingViewProps) {
  const { entry, showUpdating } = useCachedResource<SpendingData>("spending");
  const data = entry?.data ?? null;
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<ViewMode>("year");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [showTaxes, setShowTaxes] = useState(false);
  const [filingStatus, setFilingStatus] = useState<FilingStatus>(DEFAULT_FILING_STATUS);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [reconnectMessage, setReconnectMessage] = useState("");
  const apiFetch = useApiFetch(onSessionExpired);

  async function reconnect(itemId: string) {
    setReconnectMessage("");
    setReconnecting(itemId);

    try {
      const link = await openPlaidLink(apiFetch);

      if (link === null) {
        return;
      }

      const { saved, error } = await saveBankConnection(apiFetch, link, itemId);

      if (!saved) {
        setReconnectMessage(error ?? "");
        return;
      }

      setReconnectMessage("Reconnected. Plaid can take a few minutes to fetch the older history.");
      await refreshResource("spending", apiFetch, { force: true }).catch(() => undefined);
      refreshResource("dashboard", apiFetch, { force: true }).catch(() => undefined);
      refreshResource("stocks", apiFetch, { force: true }).catch(() => undefined);
    } catch (error) {
      setReconnectMessage(error instanceof PlaidLinkError ? error.message : "Bank connection is unavailable.");
    } finally {
      setReconnecting(null);
    }
  }

  const loadSpending = useCallback(async () => {
    try {
      await refreshResource("spending", apiFetch);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : LOAD_FAILED_MESSAGE);
    }
  }, [apiFetch]);

  // Transactions change a few times a day at most, so the page loads once
  // rather than joining the once-a-minute live price refresh.
  useEffect(() => {
    async function loadInitial() {
      await loadSpending();
    }

    void loadInitial();
  }, [loadSpending]);

  const months = useMemo(() => data?.months ?? [], [data]);
  const firstDataMonth = data?.coverage.earliest?.slice(0, 7) ?? null;
  const month = months.find((totals) => totals.month === selectedMonth) ?? months.at(-1) ?? null;
  const monthIndex = month === null ? -1 : months.indexOf(month);
  const monthHasData = month !== null && firstDataMonth !== null && month.month >= firstDataMonth;

  const years = useMemo(() => {
    if (data === null) {
      return [];
    }

    return data.years.map((appreciation) => {
      const yearKey = String(appreciation.year);
      const inYear = data.months.filter((totals) => totals.month.startsWith(yearKey));
      const income = sum(inYear.map((totals) => totals.income));
      const gifts = sum(inYear.map((totals) => totals.gifts));
      const spending = sum(inYear.map((totals) => totals.spending));
      const taxableIncome = sum(
        data.income.filter((entry) => entry.taxable && entry.date.startsWith(yearKey)).map((entry) => entry.amount),
      );
      const tax = estimateFederalTax(taxableIncome, appreciation.year, filingStatus);
      const net = income + gifts + (appreciation.amount ?? 0) - spending;
      const firstMonth = inYear[0]?.month ?? `${yearKey}-01`;
      const coveredFrom =
        firstDataMonth === null ? null : firstDataMonth > firstMonth ? firstDataMonth : firstMonth;

      return {
        year: appreciation.year,
        appreciation,
        months: inYear,
        income,
        gifts,
        spending,
        taxableIncome,
        tax,
        net,
        netAfterTax: net - tax.tax,
        // Months of the year before the data starts, or the window starts.
        partialFrom: coveredFrom !== null && coveredFrom > `${yearKey}-01` ? coveredFrom : null,
        hasData: firstDataMonth !== null && firstDataMonth <= `${yearKey}-12`,
        inProgress: data.today.startsWith(yearKey),
      };
    });
  }, [data, filingStatus, firstDataMonth]);

  const year = years.find((row) => row.year === selectedYear) ?? years.at(-1) ?? null;
  const yearIndex = year === null ? -1 : years.indexOf(year);

  const monthIncome = useMemo(
    () => (month === null || data === null ? [] : data.income.filter((income) => income.date.startsWith(month.month))),
    [data, month],
  );
  const monthGifts = useMemo(
    () => (month === null || data === null ? [] : data.gifts.filter((gift) => gift.date.startsWith(month.month))),
    [data, month],
  );
  const yearIncome = useMemo(
    () => (year === null || data === null ? [] : data.income.filter((income) => income.date.startsWith(String(year.year)))),
    [data, year],
  );
  const yearGifts = useMemo(
    () => (year === null || data === null ? [] : data.gifts.filter((gift) => gift.date.startsWith(String(year.year)))),
    [data, year],
  );

  const breakdownEntries =
    breakdown === null || data === null
      ? []
      : (breakdown.kind === "income" ? data.income : data.gifts).filter((item) => item.date.startsWith(breakdown.period));

  const updating = <span className="dash-updating" aria-live="polite">{showUpdating ? " · Updating…" : ""}</span>;

  return (
    <main className="dash-page spend-page">
      <AppHeader username={username} active="spending" busy={isSigningOut} onSignOut={onSignOut} />

      <div className="dash-content">
        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? `Couldn't refresh your spending. Showing data from ${formatTime(new Date(entry.fetchedAt).toISOString())}.`
              : loadError}
          </p>
        )}

        <div className="spend-toolbar">
          <div className="spend-toggle" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === "month"} onClick={() => setMode("month")}>Monthly</button>
            <button type="button" aria-pressed={mode === "year"} onClick={() => setMode("year")}>Yearly</button>
          </div>
          {mode === "month" && month !== null && (
            <PeriodStepper
              label={monthLabel(month.month)}
              onPrevious={monthIndex > 0 ? () => setSelectedMonth(months[monthIndex - 1].month) : null}
              onNext={monthIndex < months.length - 1 ? () => setSelectedMonth(months[monthIndex + 1].month) : null}
            />
          )}
          {mode === "year" && year !== null && (
            <PeriodStepper
              label={String(year.year)}
              onPrevious={yearIndex > 0 ? () => setSelectedYear(years[yearIndex - 1].year) : null}
              onNext={yearIndex < years.length - 1 ? () => setSelectedYear(years[yearIndex + 1].year) : null}
            />
          )}
        </div>

        {reconnectMessage && (
          <p className="dash-message" role="status" aria-live="polite">{reconnectMessage}</p>
        )}
        {data && <CoverageNotice data={data} reconnecting={reconnecting} onReconnect={(itemId) => void reconnect(itemId)} />}
        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        {data && !data.hasBanks && (
          <p className="dash-message">Connect a bank or credit card on the Overview page to see your spending.</p>
        )}

        {mode === "month" && (
          <>
            <section className="dash-hero" aria-labelledby="month-heading">
              <p id="month-heading" className="dash-label dash-hero-label">
                Spent in {month ? monthLabel(month.month) : "…"}
                {updating}
              </p>
              <p className="dash-hero-value spend-hero-value">
                {month ? (monthHasData ? formatMoney(month.spending) : "No data") : loadError ? "—" : "…"}
              </p>
              {month && monthHasData && (
                <dl className="stocks-stats spend-stats">
                  <div>
                    <dt>Income</dt>
                    <dd>
                      <button
                        type="button"
                        className="spend-stat-button"
                        onClick={() => setBreakdown({ kind: "income", period: month.month })}
                        aria-haspopup="dialog"
                      >
                        {formatMoney(month.income)}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>Gifts</dt>
                    <dd>
                      <button
                        type="button"
                        className="spend-stat-button"
                        onClick={() => setBreakdown({ kind: "gifts", period: month.month })}
                        aria-haspopup="dialog"
                      >
                        {formatMoney(month.gifts)}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>Left over</dt>
                    <dd className={tone(month.income + month.gifts - month.spending)}>
                      {signedMoney(month.income + month.gifts - month.spending)}
                      <span className="stocks-stat-caption">Income and gifts minus spending</span>
                    </dd>
                  </div>
                </dl>
              )}
              {month && monthHasData && (
                <Link href={`/spending/${month.month}`} className="spend-hero-link">
                  See every transaction <span aria-hidden="true">›</span>
                </Link>
              )}
            </section>

            {month && monthHasData && (
              <div className="dash-grid">
                <section className="dash-card" aria-labelledby="categories-heading">
                  <div className="dash-card-header">
                    <h2 id="categories-heading" className="dash-label">Where it went</h2>
                  </div>
                  <CategoryBars categories={Object.entries(month.categories)} total={month.spending} />
                </section>

                <div className="spend-stack">
                  <section className="dash-card" aria-labelledby="income-heading">
                    <div className="dash-card-header">
                      <h2 id="income-heading" className="dash-label">Income</h2>
                      <p className="dash-card-total">{formatMoney(month.income)}</p>
                    </div>
                    <SourceList
                      sources={bySource(monthIncome)}
                      onOpen={() => setBreakdown({ kind: "income", period: month.month })}
                      openLabel="See each deposit"
                      empty="No income this month."
                    />
                  </section>

                  <section className="dash-card" aria-labelledby="gifts-heading">
                    <div className="dash-card-header">
                      <h2 id="gifts-heading" className="dash-label">Gifts</h2>
                      <p className="dash-card-total">{formatMoney(month.gifts)}</p>
                    </div>
                    <p className="dash-card-caption">Money in with no identified source</p>
                    <SourceList
                      sources={monthGifts.length > 0 ? [["Unexplained deposits", sum(monthGifts.map((gift) => gift.amount))]] : []}
                      onOpen={() => setBreakdown({ kind: "gifts", period: month.month })}
                      openLabel="See each deposit"
                      empty="No gifts this month."
                    />
                  </section>
                </div>
              </div>
            )}

            <section className="dash-card stocks-card" aria-labelledby="months-heading">
              <div className="dash-card-header">
                <h2 id="months-heading" className="dash-label">Month by month</h2>
                <p className="dash-card-caption">Past 3 years · select a month</p>
              </div>
              <div className="stocks-table-wrap" tabIndex={0} aria-label="Monthly totals (scrolls sideways)">
                <table className="stocks-table spend-table">
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      <th scope="col" className="stocks-num">Income</th>
                      <th scope="col" className="stocks-num">Gifts</th>
                      <th scope="col" className="stocks-num">Spent</th>
                      <th scope="col" className="stocks-num">Left over</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...months].reverse().map((totals) => {
                      const hasData = firstDataMonth !== null && totals.month >= firstDataMonth;
                      const net = totals.income + totals.gifts - totals.spending;

                      return (
                        <tr key={totals.month} className={totals.month === month?.month ? "spend-selected" : undefined}>
                          <th scope="row">
                            <button
                              type="button"
                              className="stocks-ticker-button"
                              onClick={() => {
                                setSelectedMonth(totals.month);
                                window.scrollTo({ top: 0, behavior: "smooth" });
                              }}
                            >
                              {monthLabel(totals.month, "short")}
                            </button>
                          </th>
                          {hasData ? (
                            <>
                              <td className="stocks-num">{formatMoney(totals.income)}</td>
                              <td className="stocks-num">{formatMoney(totals.gifts)}</td>
                              <td className="stocks-num">{formatMoney(totals.spending)}</td>
                              <td className={`stocks-num ${tone(net)}`}>{signedMoney(net)}</td>
                            </>
                          ) : (
                            <td colSpan={4} className="stocks-num spend-muted">No data from Plaid</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {mode === "year" && (
          <>
            <section className="dash-hero" aria-labelledby="year-heading">
              <p id="year-heading" className="dash-label dash-hero-label">
                {year ? `Net gain in ${year.year}${year.inProgress ? " so far" : ""}` : "Net gain"}
                {updating}
              </p>
              <p className={`dash-hero-value spend-hero-value ${year ? tone(showTaxes ? year.netAfterTax : year.net) : ""}`}>
                {year
                  ? year.hasData
                    ? signedMoney(showTaxes ? year.netAfterTax : year.net)
                    : "No data"
                  : loadError
                    ? "—"
                    : "…"}
              </p>
              {year && year.hasData && (
                <p className="dash-hero-breakdown">
                  Income + gifts + stock appreciation − spending{showTaxes ? " − estimated federal tax" : ""}
                  {year.partialFrom && ` · covers ${monthLabel(year.partialFrom, "short")} onward`}
                </p>
              )}
              {year && year.hasData && (
                <dl className="stocks-stats spend-stats spend-stats-wide">
                  <div>
                    <dt>Income</dt>
                    <dd>
                      <button
                        type="button"
                        className="spend-stat-button"
                        onClick={() => setBreakdown({ kind: "income", period: String(year.year) })}
                        aria-haspopup="dialog"
                      >
                        {formatMoney(year.income)}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>Gifts</dt>
                    <dd>
                      <button
                        type="button"
                        className="spend-stat-button"
                        onClick={() => setBreakdown({ kind: "gifts", period: String(year.year) })}
                        aria-haspopup="dialog"
                      >
                        {formatMoney(year.gifts)}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>Stock appreciation</dt>
                    <dd className={tone(year.appreciation.amount)} title={year.appreciation.note ?? undefined}>
                      {year.appreciation.amount === null ? "—" : signedMoney(year.appreciation.amount)}
                      {year.appreciation.status === "partial" && <span className="stocks-stat-caption">Partial</span>}
                      {year.appreciation.status === "unavailable" && (
                        <span className="stocks-stat-caption">No history</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Spent</dt>
                    <dd>{formatMoney(year.spending)}</dd>
                  </div>
                  {showTaxes && (
                    <div>
                      <dt>Est. federal tax</dt>
                      <dd>
                        {formatMoney(year.tax.tax)}
                        <span className="stocks-stat-caption">
                          {year.tax.effectiveRate === null ? "No taxable income" : `${percentFormatter.format(year.tax.effectiveRate)} of income`}
                        </span>
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </section>

            {year && <MonthBars year={year.year} months={year.months} firstDataMonth={firstDataMonth} />}

            <section className="dash-card stocks-card" aria-labelledby="years-heading">
              <div className="dash-card-header spend-years-header">
                <h2 id="years-heading" className="dash-label">Year by year</h2>
                <div className="spend-tax-controls">
                  <label className="spend-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={showTaxes}
                      onChange={(event) => setShowTaxes(event.target.checked)}
                    />
                    <span>Estimated federal taxes</span>
                  </label>
                  {showTaxes && (
                    <label className="spend-select">
                      <span className="stocks-sr-only">Filing status</span>
                      <select
                        value={filingStatus}
                        onChange={(event) => setFilingStatus(event.target.value as FilingStatus)}
                      >
                        {(Object.keys(FILING_STATUS_LABELS) as FilingStatus[]).map((status) => (
                          <option key={status} value={status}>{FILING_STATUS_LABELS[status]}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </div>

              <div className="stocks-table-wrap" tabIndex={0} aria-label="Yearly totals (scrolls sideways)">
                <table className="stocks-table spend-table">
                  <thead>
                    <tr>
                      <th scope="col">Year</th>
                      <th scope="col" className="stocks-num">Income</th>
                      <th scope="col" className="stocks-num">Gifts</th>
                      <th scope="col" className="stocks-num">Stock appreciation</th>
                      <th scope="col" className="stocks-num">Spent</th>
                      <th scope="col" className="stocks-num">Net gain</th>
                      {showTaxes && <th scope="col" className="stocks-num">Est. federal tax</th>}
                      {showTaxes && <th scope="col" className="stocks-num">Net after tax</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {[...years].reverse().map((row) => (
                      <tr key={row.year} className={row.year === year?.year ? "spend-selected" : undefined}>
                        <th scope="row">
                          <button type="button" className="stocks-ticker-button" onClick={() => setSelectedYear(row.year)}>
                            {row.year}
                          </button>
                          {(row.partialFrom || row.inProgress) && row.hasData && (
                            <span className="stocks-est">
                              {" "}
                              {row.partialFrom ? `from ${monthLabel(row.partialFrom, "short").split(" ")[0]}` : "so far"}
                            </span>
                          )}
                        </th>
                        {row.hasData ? (
                          <>
                            <td className="stocks-num">
                              <button
                                type="button"
                                className="stocks-ticker-button spend-num-button"
                                onClick={() => setBreakdown({ kind: "income", period: String(row.year) })}
                                aria-haspopup="dialog"
                                aria-label={`${formatMoney(row.income)} income in ${row.year}: show each deposit`}
                              >
                                {formatMoney(row.income)}
                              </button>
                            </td>
                            <td className="stocks-num">
                              <button
                                type="button"
                                className="stocks-ticker-button spend-num-button"
                                onClick={() => setBreakdown({ kind: "gifts", period: String(row.year) })}
                                aria-haspopup="dialog"
                                aria-label={`${formatMoney(row.gifts)} in gifts in ${row.year}: show each deposit`}
                              >
                                {formatMoney(row.gifts)}
                              </button>
                            </td>
                            <td className={`stocks-num ${tone(row.appreciation.amount)}`} title={row.appreciation.note ?? undefined}>
                              {row.appreciation.amount === null ? "—" : signedMoney(row.appreciation.amount)}
                              {row.appreciation.status === "partial" && <span className="stocks-est"> partial</span>}
                              {row.appreciation.note && <span className="stocks-sr-only"> ({row.appreciation.note})</span>}
                            </td>
                            <td className="stocks-num">{formatMoney(row.spending)}</td>
                            <td className={`stocks-num stocks-strong ${tone(row.net)}`}>{signedMoney(row.net)}</td>
                            {showTaxes && <td className="stocks-num">{formatMoney(row.tax.tax)}</td>}
                            {showTaxes && (
                              <td className={`stocks-num stocks-strong ${tone(row.netAfterTax)}`}>{signedMoney(row.netAfterTax)}</td>
                            )}
                          </>
                        ) : (
                          <td colSpan={showTaxes ? 7 : 5} className="stocks-num spend-muted">No data from Plaid</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {showTaxes && year && (
                <p className="stocks-footnote">
                  Federal tax is a rough estimate: {FILING_STATUS_LABELS[filingStatus].toLowerCase()} filer,
                  standard deduction ({wholeMoney.format(year.tax.standardDeduction)} for {year.tax.bracketYear}),
                  ordinary {year.tax.bracketYear} brackets, no credits. It is based on deposits counted as income,
                  which are usually take-home pay after withholding and retirement contributions, so your real
                  gross income and tax are likely higher. Gifts, tax refunds, and unsold stock gains aren&apos;t taxed
                  here. Partial years only include the months with data.
                </p>
              )}
              <p className="stocks-footnote">
                Stock appreciation is the change in value of your stocks and ETFs over the year, after taking
                out money you added or withdrew, from your brokerage transaction history and daily closing
                prices. Dividends aren&apos;t included, and mutual funds or 401(k) trusts without market prices
                are left out. Plaid brokerage history covers 24 months.
              </p>
            </section>

            {year && year.hasData && (
              <div className="dash-grid">
                <section className="dash-card" aria-labelledby="year-categories-heading">
                  <div className="dash-card-header">
                    <h2 id="year-categories-heading" className="dash-label">Where it went in {year.year}</h2>
                  </div>
                  <CategoryBars categories={addCategories(year.months)} total={year.spending} />
                </section>

                <div className="spend-stack">
                  <section className="dash-card" aria-labelledby="year-income-heading">
                    <div className="dash-card-header">
                      <h2 id="year-income-heading" className="dash-label">Income in {year.year}</h2>
                      <p className="dash-card-total">{formatMoney(year.income)}</p>
                    </div>
                    <SourceList
                      sources={bySource(yearIncome)}
                      onOpen={() => setBreakdown({ kind: "income", period: String(year.year) })}
                      openLabel="See each deposit"
                      empty="No income this year."
                    />
                  </section>

                  <section className="dash-card" aria-labelledby="year-gifts-heading">
                    <div className="dash-card-header">
                      <h2 id="year-gifts-heading" className="dash-label">Gifts in {year.year}</h2>
                      <p className="dash-card-total">{formatMoney(year.gifts)}</p>
                    </div>
                    <p className="dash-card-caption">Money in with no identified source</p>
                    <SourceList
                      sources={yearGifts.length > 0 ? [["Unexplained deposits", year.gifts]] : []}
                      onOpen={() => setBreakdown({ kind: "gifts", period: String(year.year) })}
                      openLabel="See each deposit"
                      empty="No gifts this year."
                    />
                  </section>
                </div>
              </div>
            )}
          </>
        )}

        <p className="stocks-footnote spend-page-note">
          Categories are Plaid&apos;s personal finance categories across your linked credit cards and bank
          accounts. Card payments and transfers between your own linked accounts aren&apos;t counted as spending
          or income; refunds reduce spending in their category. Pending transactions are left out.
        </p>
      </div>

      {breakdown && <BreakdownDialog breakdown={breakdown} entries={breakdownEntries} onClose={() => setBreakdown(null)} />}
    </main>
  );
}
