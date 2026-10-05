"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import AppHeader from "../app-header";
import DetailDialog from "../detail-dialog";
import { formatMoney, staleDataMessage, subscribeToReconnect, useApiFetch } from "../client-api";
import { refreshResource, useCachedResource } from "../client-cache";
import { PlaidLinkError, openPlaidLink, saveBankConnection } from "../plaid-link";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "../theme-ui";
import MonthList, { MonthListLoading, type MonthFlow } from "./month-list";
import {
  YEAR_RANK_COLORS,
  counterpartyLabel,
  dateLabel,
  depositFrequency,
  historyStartMonth,
  joinNames,
  monthLabel,
  signedMoney,
  tone,
  wholeMoney,
} from "./spending-format";
import { CategoryBreakdown, PeriodBar, SectionHeading, SummaryTiles, coveredRange, rankCategories } from "./spending-ui";
import { OTHER_INCOME_LABEL, type IncomeEntry, type MonthTotals } from "@/lib/cashflow";
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

// Which deposits the income dialog lists: a month (YYYY-MM) or a year (YYYY).
// A period's income deposits, or its dividends.
// With everything, dividends are listed along with the deposits.
type Breakdown = { period: string; dividends?: boolean; everything?: boolean };

const LOAD_FAILED_MESSAGE = "Spending couldn't be loaded. Try again.";

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
// Income sources the Income section groups specially.
const PAYCHECK_LABEL = "Paychecks";
const INTEREST_LABEL = "Interest";

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

type IncomeRow = { key: string; name: string; detail: string; amount: number };
type IncomeGroup = { title: string; total: number; rows: IncomeRow[] };

// The year's money in, as the Income section lists it: pay and other income
// first (paychecks by employer), then interest and dividends.
function incomeGroups(entries: IncomeEntry[], dividends: IncomeEntry[]): IncomeGroup[] {
  const paychecks = new Map<string, IncomeEntry[]>();
  const sources = new Map<string, IncomeEntry[]>();
  const interest: IncomeEntry[] = [];

  for (const entry of entries) {
    if (entry.source === INTEREST_LABEL) {
      interest.push(entry);
    } else if (entry.source === PAYCHECK_LABEL) {
      const payer = counterpartyLabel(entry.name);
      paychecks.set(payer, [...(paychecks.get(payer) ?? []), entry]);
    } else {
      sources.set(entry.source, [...(sources.get(entry.source) ?? []), entry]);
    }
  }

  const total = (list: IncomeEntry[]) => sum(list.map((entry) => entry.amount));
  const earned: IncomeRow[] = [
    ...[...paychecks.entries()].map(([payer, list]) => ({
      key: `pay:${payer}`,
      name: payer,
      detail: `Paycheck · ${depositFrequency(list.map((entry) => entry.date))}`,
      amount: total(list),
    })),
    ...[...sources.entries()].map(([source, list]) => ({
      key: `source:${source}`,
      name: source,
      detail:
        source === OTHER_INCOME_LABEL
          ? "Money in with no identified source"
          : depositFrequency(list.map((entry) => entry.date)),
      amount: total(list),
    })),
  ].sort((a, b) => b.amount - a.amount);
  const passive: IncomeRow[] = [];

  if (interest.length > 0) {
    passive.push({ key: "interest", name: "Interest", detail: joinNames(interest.map((entry) => entry.accountName)), amount: total(interest) });
  }

  if (dividends.length > 0) {
    passive.push({
      key: "dividends",
      name: "Dividends",
      detail: `Paid into ${joinNames(dividends.map((entry) => entry.accountName))}`,
      amount: total(dividends),
    });
  }

  const earnedTitle = paychecks.size > 0 ? (sources.size > 0 ? "Pay & other income" : "Paychecks") : "Other income";

  return [
    { title: earnedTitle, total: sum(earned.map((row) => row.amount)), rows: earned },
    { title: "Interest & dividends", total: sum(passive.map((row) => row.amount)), rows: passive },
  ].filter((group) => group.rows.length > 0);
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
  const hasOther = entries.some((entry) => entry.source === OTHER_INCOME_LABEL);
  const noun = breakdown.dividends ? ["payment", "payments"] : ["deposit", "deposits"];

  return (
    <DetailDialog
      title={`${breakdown.dividends ? "Dividends" : "Income"} · ${period}`}
      subtitle={breakdown.dividends ? "Each dividend paid into your linked accounts" : "Each deposit counted as income"}
      onClose={onClose}
    >
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(total)}</p>
        <p className="detail-summary-caption">
          {entries.length} {entries.length === 1 ? noun[0] : noun[1]}
        </p>
      </div>

      {hasOther && (
        <p className="detail-note">
          {OTHER_INCOME_LABEL} is money that arrived without a paycheck, interest, dividend, or other income
          label from Plaid, and that didn&apos;t match a transfer out of another linked account. Contractor or
          rental payments sent by Zelle or Venmo, and transfers from accounts you haven&apos;t linked, usually
          land here.
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
                    {entry.source} · {entry.accountName}
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

  if (!coverage.stillLoading && short.length === 0) {
    return null;
  }

  return (
    <div className="dash-issue spend-coverage">
      {coverage.stillLoading && <p>Plaid is still fetching older history for at least one bank.</p>}
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
  // A year picked from a month page's year menu arrives as ?year=2025.
  const [selectedYear, setSelectedYear] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("year"));
    return Number.isInteger(requested) && requested > 0 ? requested : null;
  });
  const [showAllCategories, setShowAllCategories] = useState(false);
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
  // rather than joining the once-a-minute live price refresh (and again when
  // the device comes back online).
  useEffect(() => {
    async function loadInitial() {
      await loadSpending();
    }

    void loadInitial();
    return subscribeToReconnect(loadSpending);
  }, [loadSpending]);

  // Only the months with bank history, at most the last 24.
  const firstDataMonth = data ? historyStartMonth(data.coverage.earliest, data.today) : null;

  const years = useMemo(() => {
    if (data === null) {
      return [];
    }

    return data.years.map((appreciation) => {
      const yearKey = String(appreciation.year);
      const inYear = data.months.filter(
        (totals) => totals.month.startsWith(yearKey) && firstDataMonth !== null && totals.month >= firstDataMonth,
      );
      const income = sum(inYear.map((totals) => totals.income));
      const other = sum(inYear.map((totals) => totals.other));
      const dividends = sum(inYear.map((totals) => totals.dividends));
      const spending = sum(inYear.map((totals) => totals.spending));
      const taxableIncome = sum(
        [...data.income, ...data.dividends]
          .filter(
            (entry) =>
              entry.taxable &&
              entry.date.startsWith(yearKey) &&
              firstDataMonth !== null &&
              entry.date.slice(0, 7) >= firstDataMonth,
          )
          .map((entry) => entry.amount),
      );
      const tax = estimateFederalTax(taxableIncome, appreciation.year, filingStatus);
      // Stock appreciation is shown beside it but isn't part of net gain.
      const net = income + other + dividends - spending;
      const firstMonth = inYear[0]?.month ?? `${yearKey}-01`;
      const thisMonth = data.today.slice(0, 7);
      // Months with bank data, through this month.
      const dataMonths = inYear.filter(
        (totals) => firstDataMonth !== null && totals.month >= firstDataMonth && totals.month <= thisMonth,
      );
      const interestByMonth = new Map<string, number>();

      for (const entry of data.income) {
        if (entry.source === INTEREST_LABEL && entry.date.startsWith(yearKey)) {
          const month = entry.date.slice(0, 7);
          interestByMonth.set(month, (interestByMonth.get(month) ?? 0) + entry.amount);
        }
      }

      const flows: MonthFlow[] = dataMonths.map((totals) => {
        const interest = interestByMonth.get(totals.month) ?? 0;
        return {
          month: totals.month,
          pay: totals.income - interest + totals.other,
          interest: interest + totals.dividends,
          spending: totals.spending,
        };
      });
      const coveredFrom =
        firstDataMonth === null ? null : firstDataMonth > firstMonth ? firstDataMonth : firstMonth;

      return {
        year: appreciation.year,
        appreciation,
        months: inYear,
        dataMonths,
        flows,
        // The year's months up to this one, for the period bar.
        periodMonths: inYear
          .filter((totals) => totals.month <= thisMonth)
          .map((totals) => ({
            month: totals.month,
            hasData: firstDataMonth !== null && totals.month >= firstDataMonth,
          })),
        // Everything that came in, interest and dividends included.
        incomeTotal: income + other + dividends,
        interestTotal: sum(flows.map((flow) => flow.interest)),
        // All money in except dividends, including other income.
        moneyIn: income + other,
        other,
        dividends,
        spending,
        taxableIncome,
        tax,
        net,
        netAfterTax: net - tax.tax,
        // Months of the year before the data starts, or the window starts.
        partialFrom: coveredFrom !== null && coveredFrom > `${yearKey}-01` ? coveredFrom : null,
        hasData: dataMonths.length > 0,
        inProgress: data.today.startsWith(yearKey),
      };
    }).filter((row) => row.hasData);
  }, [data, filingStatus, firstDataMonth]);

  const year = years.find((row) => row.year === selectedYear) ?? years.at(-1) ?? null;

  // Every deposit counted as income, other income included, oldest first.
  const allIncome = useMemo(
    () =>
      data === null
        ? []
        : [...data.income, ...(data.other ?? [])].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount),
    [data],
  );
  const yearIncome = useMemo(
    () => (year === null ? [] : allIncome.filter((entry) => entry.date.startsWith(String(year.year)))),
    [allIncome, year],
  );

  const breakdownEntries =
    breakdown === null
      ? []
      : (breakdown.dividends
          ? data?.dividends ?? []
          : breakdown.everything
            ? [...allIncome, ...(data?.dividends ?? [])].sort((a, b) => a.date.localeCompare(b.date))
            : allIncome
        ).filter((entry) => entry.date.startsWith(breakdown.period));

  const isLoading = data === null && !loadError;
  const yearShares = year === null ? [] : rankCategories(addCategories(year.dataMonths), YEAR_RANK_COLORS, showAllCategories ? undefined : 4);
  const groups = year === null ? [] : incomeGroups(yearIncome, (data?.dividends ?? []).filter((entry) => entry.date.startsWith(String(year.year))));

  return (
    <main className="dash-page spend-page">
      <AppHeader
        username={username}
        active="spending"
        busy={isSigningOut}
        onSignOut={onSignOut}
        onSessionExpired={onSessionExpired}
      />

      <div className="dash-content">
        {year !== null && (
          <PeriodBar
            years={years.map((row) => row.year)}
            year={year.year}
            months={year.periodMonths}
            selectedMonth={null}
            onSelectYear={setSelectedYear}
          />
        )}

        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? staleDataMessage("your spending", entry.fetchedAt)
              : loadError}
          </p>
        )}

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

        <section className="dash-hero" aria-labelledby="year-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="year-heading" className="dash-label">
              {year ? `Saved in ${year.year}${year.inProgress ? " so far" : ""}` : "Saved"}
            </h1>
            {year && !showUpdating && !isLoading ? (
              <span className="hero-updated">{coveredRange(year.dataMonths.map((totals) => totals.month))}</span>
            ) : (
              <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
            )}
          </div>
          <p className="dash-hero-value">
            {year ? (
              year.hasData ? <HeroAmount value={year.net} signed /> : "No data"
            ) : loadError ? (
              "—"
            ) : (
              <Skeleton width="62%" height="44px" />
            )}
          </p>
          {year && year.hasData && year.incomeTotal > 0 && (
            <p className={`sp-hero-note ${year.net < 0 ? "sp-over" : ""}`}>
              {year.net >= 0
                ? `You kept ${percentFormatter.format(year.net / year.incomeTotal)} of the ${wholeMoney(year.incomeTotal)} that came in`
                : `You spent ${wholeMoney(-year.net)} more than came in`}
            </p>
          )}
        </section>

        {(isLoading || (year && year.hasData)) && (
          <SummaryTiles
            income={year ? formatMoney(year.incomeTotal) : <Skeleton width="80%" height="20px" />}
            incomeNote={
              year ? (
                year.interestTotal > 0 ? (
                  <button
                    type="button"
                    className="sp-tile-link"
                    onClick={() => setBreakdown({ period: String(year.year), everything: true })}
                    aria-haspopup="dialog"
                  >
                    Incl. {wholeMoney(year.interestTotal)} interest &amp; dividends
                  </button>
                ) : (
                  <button
                    type="button"
                    className="sp-tile-link"
                    onClick={() => setBreakdown({ period: String(year.year), everything: true })}
                    aria-haspopup="dialog"
                  >
                    See each deposit
                  </button>
                )
              ) : (
                <Skeleton width="60%" height="10px" />
              )
            }
            spent={year ? formatMoney(year.spending) : <Skeleton width="80%" height="20px" />}
            spentNote={
              year ? (
                year.dataMonths.length > 0 ? `About ${wholeMoney(year.spending / year.dataMonths.length)} a month` : ""
              ) : (
                <Skeleton width="60%" height="10px" />
              )
            }
          />
        )}

        {isLoading && <MonthListLoading />}

        {year && year.hasData && (
          <>
            <MonthList year={year.year} months={year.flows} />

            <SectionHeading id="year-spending-heading" title="Spending" total={signedMoney(-year.spending)} tone="spending" />
            <section className="dash-card sp-section" aria-labelledby="year-spending-heading">
              {yearShares.length === 0 ? (
                <p className="dash-empty">No spending recorded.</p>
              ) : (
                <CategoryBreakdown shares={yearShares} total={year.spending} />
              )}
              {addCategories(year.dataMonths).length > 5 && (
                <button
                  type="button"
                  className="pill-button pill-button-soft sp-more"
                  onClick={() => setShowAllCategories((shown) => !shown)}
                  aria-expanded={showAllCategories}
                >
                  {showAllCategories ? "Show top categories" : "See all spending"}
                  <Icon name={showAllCategories ? "chevronDown" : "chevronRight"} size={16} strokeWidth={2.4} />
                </button>
              )}
            </section>

            <SectionHeading id="year-income-heading" title="Income" total={signedMoney(year.incomeTotal)} tone="income" />
            <section className="dash-card sp-section" aria-labelledby="year-income-heading">
              {groups.length === 0 ? (
                <p className="dash-empty">No income this year.</p>
              ) : (
                groups.map((group) => (
                  <div key={group.title} className="sp-income-group">
                    <h3 className="sp-group-title">
                      <span>{group.title}</span>
                      <span>{formatMoney(group.total)}</span>
                    </h3>
                    <ul className="sp-list">
                      {group.rows.map((row) => (
                        <li key={row.key} className="sp-list-row">
                          <span className="sp-list-main">
                            <span className="sp-list-name">{row.name}</span>
                            <span className="sp-list-detail">{row.detail}</span>
                          </span>
                          <span className="sp-list-amount">{formatMoney(row.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              {groups.length > 0 && (
                <button
                  type="button"
                  className="pill-button pill-button-soft sp-more"
                  onClick={() => setBreakdown({ period: String(year.year), everything: true })}
                  aria-haspopup="dialog"
                >
                  See all income
                  <Icon name="chevronRight" size={16} strokeWidth={2.4} />
                </button>
              )}
            </section>
          </>
        )}

        {years.length > 0 && (
          <section className="dash-card stocks-card sp-years" aria-labelledby="years-heading">
            <div className="dash-card-header spend-years-header">
              <h2 id="years-heading" className="sp-card-title">Year by year</h2>
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
                    <th scope="col" className="stocks-num">Dividends</th>
                    <th scope="col" className="stocks-num">Stock gains</th>
                    <th scope="col" className="stocks-num">Spent</th>
                    <th scope="col" className="stocks-num">Saved</th>
                    {showTaxes && <th scope="col" className="stocks-num">Est. federal tax</th>}
                    {showTaxes && <th scope="col" className="stocks-num">Saved after tax</th>}
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
                              onClick={() => setBreakdown({ period: String(row.year) })}
                              aria-haspopup="dialog"
                              aria-label={`${formatMoney(row.moneyIn)} income in ${row.year}: show each deposit`}
                            >
                              {formatMoney(row.moneyIn)}
                            </button>
                          </td>
                          <td className="stocks-num">
                            <button
                              type="button"
                              className="stocks-ticker-button spend-num-button"
                              onClick={() => setBreakdown({ period: String(row.year), dividends: true })}
                              aria-haspopup="dialog"
                              aria-label={`${formatMoney(row.dividends)} dividends in ${row.year}: show each payment`}
                            >
                              {formatMoney(row.dividends)}
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
                        <td colSpan={showTaxes ? 7 : 5} className="spend-muted">No data from Plaid</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {showTaxes && year && (
              <p className="stocks-footnote">
                Federal tax is a rough estimate: {FILING_STATUS_LABELS[filingStatus].toLowerCase()} filer,
                standard deduction ({wholeMoney(year.tax.standardDeduction)} for {year.tax.bracketYear}),
                ordinary {year.tax.bracketYear} brackets, no credits. It is based on deposits counted as income,
                which are usually take-home pay after withholding and retirement contributions, so your real
                gross income and tax are likely higher. Other income, tax refunds, and unsold stock gains aren&apos;t
                taxed here. Partial years only include the months with data.
              </p>
            )}
            <p className="stocks-footnote">
              Stock gains are the change in value of your stocks and ETFs over the year, after taking out money
              you added or withdrew, from your brokerage transaction history and daily closing prices. They
              aren&apos;t counted in what you saved; mutual funds or 401(k) trusts without market prices are left
              out. Plaid brokerage history covers 24 months.
            </p>
          </section>
        )}

        <p className="stocks-footnote spend-page-note">
          Transfers between your own accounts and credit card payments aren&apos;t counted as spending or income.
          Categories are Plaid&apos;s, from your linked credit cards and bank accounts; refunds reduce spending in
          their category in the month they post. Interest and dividends count as income, including those paid into
          linked brokerage accounts, while money moved between a brokerage and a bank counts as a transfer.
          Pending transactions are left out.
        </p>
      </div>

      {breakdown && <BreakdownDialog breakdown={breakdown} entries={breakdownEntries} onClose={() => setBreakdown(null)} />}
    </main>
  );
}
