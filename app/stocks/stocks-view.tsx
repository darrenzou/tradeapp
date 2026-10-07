"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";

import AppHeader from "../app-header";
import DetailDialog from "../detail-dialog";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "../theme-ui";
import { formatMoney, formatTime, staleDataMessage, subscribeToLiveRefresh, useApiFetch } from "../client-api";
import { prefetchResource, refreshResource, useCachedResource } from "../client-cache";
import { estimateRisk } from "@/lib/allocation-targets";
import { ASSET_CLASSES, buildAllocation, type Allocation, type AssetClass } from "@/lib/asset-classes";
import type { CashPosition, IrrStatus, StockRow } from "@/lib/portfolio";
import type { StocksData } from "@/lib/stocks";
import type { StocksSummary } from "@/lib/portfolio";
import { useReturns } from "./use-returns";
import { nextSort, sortRows, type SortDirection, type SortState, type SortValue } from "./holdings-sort";

type StocksViewProps = {
  username: string;
  isSigningOut: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
};

const LOAD_FAILED_MESSAGE = "Holdings couldn't be loaded. Try again.";
// Holdings owned for only days can annualize to meaningless extremes.
const IRR_DISPLAY_LIMIT = 9.99;

const sharesFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const detailPercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

function formatSignedMoney(value: number | null): string {
  return value === null ? "—" : signed(value, formatMoney(Math.abs(value)));
}

function formatSignedPercent(value: number | null): string {
  return value === null ? "—" : signed(value, percentFormatter.format(Math.abs(value)));
}

const shortPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function formatShortPercent(value: number | null): string {
  return value === null ? "—" : signed(value, shortPercent.format(Math.abs(value)));
}

function formatIrr(value: number | null): string {
  if (value === null) {
    return "—";
  }

  if (value >= IRR_DISPLAY_LIMIT) {
    return ">999%";
  }

  return formatSignedPercent(value);
}

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const datedYearFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

// "May 6" this year, "May 6, 2025" before it.
function formatPurchaseDate(date: string | null): string {
  if (date === null) {
    return "—";
  }

  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  return year === new Date().getFullYear() ? dateFormatter.format(value) : datedYearFormatter.format(value);
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "" : value > 0 ? "stocks-up" : "stocks-down";
}

function IrrCell({ value, status, note }: { value: number | null; status: IrrStatus; note: string | null }) {
  return (
    <td className={`stocks-num ${tone(value)}`} title={note ?? undefined}>
      {formatIrr(value)}
      {status === "estimated" && value !== null && <span className="stocks-est"> est.</span>}
      {note && <span className="stocks-sr-only"> ({note})</span>}
    </td>
  );
}

const SOURCE_LABELS = { snaptrade: "SnapTrade", plaid: "Plaid", import: "bank file" } as const;

// The ticker, or the name for securities without one (some 401(k) funds).
function symbolLabel(row: StockRow): string {
  return row.ticker ?? row.name;
}

type Column = {
  id: string;
  label: ReactNode;
  // Plain-text name for the sort button's label.
  name: string;
  // Text columns sort A to Z first; the rest highest (or most recent) first.
  firstDirection: SortDirection;
  sortValue: (row: StockRow) => SortValue;
  cell: (row: StockRow) => ReactNode;
};

function numberCell(text: string, className = ""): ReactNode {
  return <td className={`stocks-num ${className}`.trim()}>{text}</td>;
}

// The Symbol column comes first and stays put while the rest scroll sideways.
const SYMBOL_COLUMN = {
  id: "symbol",
  name: "Symbol",
  firstDirection: "ascending",
  sortValue: (row: StockRow) => symbolLabel(row),
} as const;

const COLUMNS: Column[] = [
  {
    id: "price",
    label: "Price",
    name: "Price",
    firstDirection: "descending",
    sortValue: (row) => row.price,
    cell: (row) => numberCell(row.price === null ? "—" : formatMoney(row.price)),
  },
  {
    id: "dayChangePercent",
    label: "Today %",
    name: "Today %",
    firstDirection: "descending",
    sortValue: (row) => row.dayChangePercent,
    cell: (row) => numberCell(formatSignedPercent(row.dayChangePercent), tone(row.dayChangePercent)),
  },
  {
    id: "dayPnl",
    label: <>Today P&amp;L</>,
    name: "Today P&L",
    firstDirection: "descending",
    sortValue: (row) => row.dayPnl,
    cell: (row) => numberCell(formatSignedMoney(row.dayPnl), tone(row.dayPnl)),
  },
  {
    id: "marketValue",
    label: "Market value",
    name: "Market value",
    firstDirection: "descending",
    sortValue: (row) => row.marketValue,
    cell: (row) => numberCell(formatMoney(row.marketValue), "stocks-strong"),
  },
  {
    id: "totalPnl",
    label: <>Total P&amp;L</>,
    name: "Total P&L",
    firstDirection: "descending",
    sortValue: (row) => row.totalPnl,
    cell: (row) => numberCell(formatSignedMoney(row.totalPnl), tone(row.totalPnl)),
  },
  {
    id: "totalPnlPercent",
    label: <>Total P&amp;L %</>,
    name: "Total P&L %",
    firstDirection: "descending",
    sortValue: (row) => row.totalPnlPercent,
    cell: (row) => numberCell(formatSignedPercent(row.totalPnlPercent), tone(row.totalPnlPercent)),
  },
  {
    id: "irr",
    label: "IRR",
    name: "IRR",
    firstDirection: "descending",
    sortValue: (row) => row.irr,
    cell: (row) => <IrrCell value={row.irr} status={row.irrStatus} note={row.irrNote} />,
  },
  {
    id: "portfolioPercent",
    label: "% of portfolio",
    name: "% of portfolio",
    firstDirection: "descending",
    sortValue: (row) => row.portfolioPercent,
    cell: (row) => numberCell(percentFormatter.format(row.portfolioPercent)),
  },
  {
    id: "lastPurchase",
    label: "Last purchase",
    name: "Last purchase",
    firstDirection: "descending",
    // ISO dates sort as text.
    sortValue: (row) => row.lastPurchase,
    cell: (row) => numberCell(formatPurchaseDate(row.lastPurchase)),
  },
  {
    id: "shares",
    label: "Shares",
    name: "Shares",
    firstDirection: "descending",
    sortValue: (row) => row.shares,
    cell: (row) => numberCell(sharesFormatter.format(row.shares)),
  },
  {
    id: "averagePrice",
    label: "Avg. price",
    name: "Avg. price",
    firstDirection: "descending",
    sortValue: (row) => row.averagePrice,
    cell: (row) => numberCell(row.averagePrice === null ? "—" : formatMoney(row.averagePrice)),
  },
];

// "Today %" and "Today P&L" become "Day %" and "Day P&L" on a past day.
function columnLabel(column: Column, dayLabel: string): ReactNode {
  if (dayLabel === "Today") {
    return column.label;
  }
  if (column.id === "dayChangePercent") {
    return `${dayLabel} %`;
  }
  return column.id === "dayPnl" ? <>{dayLabel} P&amp;L</> : column.label;
}

// Two stacked triangles: both faint in the default order, one filled when
// the column is sorted (up for lowest first, down for highest first).
function SortIcon({ direction }: { direction: SortDirection | null }) {
  return (
    <svg className="stocks-sort-icon" viewBox="0 0 8 12" width="8" height="12" aria-hidden="true">
      <path d="M4 0 8 5H0z" className={direction === "ascending" ? "stocks-sort-on" : undefined} />
      <path d="M4 12 0 7h8z" className={direction === "descending" ? "stocks-sort-on" : undefined} />
    </svg>
  );
}

function SortHeader({
  id,
  name,
  label,
  numeric,
  sort,
  firstDirection,
  onSort,
}: {
  id: string;
  name: string;
  label: ReactNode;
  numeric: boolean;
  sort: SortState;
  firstDirection: SortDirection;
  onSort: (id: string, firstDirection: SortDirection) => void;
}) {
  const direction = sort?.column === id ? sort.direction : null;
  const nextDirection = nextSort(sort, id, firstDirection)?.direction ?? null;
  const hint =
    nextDirection === null
      ? "restore default order"
      : id === "symbol"
        ? nextDirection === "ascending" ? "sort A to Z" : "sort Z to A"
        : id === "lastPurchase"
          ? nextDirection === "descending" ? "sort most recent first" : "sort oldest first"
          : nextDirection === "descending" ? "sort highest first" : "sort lowest first";

  return (
    <th
      scope="col"
      className={`${numeric ? "stocks-num" : ""} ${id === "symbol" ? "stocks-symbol" : ""}`.trim() || undefined}
      aria-sort={direction ?? undefined}
    >
      <button
        type="button"
        className={`stocks-sort-button${direction ? " stocks-sort-active" : ""}`}
        onClick={() => onSort(id, firstDirection)}
        aria-label={`${name}: ${hint}`}
      >
        {label}
        <SortIcon direction={direction} />
      </button>
    </th>
  );
}

function HoldingRow({ row }: { row: StockRow }) {
  return (
    <tr>
      <th scope="row" className="stocks-symbol">
        <Link
          href={`/stocks/${encodeURIComponent(row.key)}`}
          className="stocks-ticker-button"
          title={row.name}
          aria-label={`${symbolLabel(row)}, ${row.name}: show details`}
        >
          <span className="stocks-ticker">{symbolLabel(row)}</span>
          <Icon name="chevronRight" size={12} strokeWidth={3} />
        </Link>
      </th>
      {COLUMNS.map((column) => (
        <Fragment key={column.id}>{column.cell(row)}</Fragment>
      ))}
    </tr>
  );
}

// Cells for rows other than holdings (Other, Cash, and the total), by column;
// columns without one are left blank.
function OtherCells({ cells }: { cells: Partial<Record<string, ReactNode>> }) {
  return (
    <>
      {COLUMNS.map((column) => (
        <Fragment key={column.id}>{cells[column.id] ?? <td />}</Fragment>
      ))}
    </>
  );
}

function SummaryRow({
  label,
  detail,
  value,
  total,
  onSelect,
}: {
  label: string;
  detail: string;
  value: number;
  total: number;
  // With onSelect, the label opens a breakdown.
  onSelect?: () => void;
}) {
  return (
    <tr className="stocks-summary-row">
      <th scope="row" className="stocks-symbol" title={detail}>
        {onSelect ? (
          <button
            type="button"
            className="stocks-ticker-button"
            onClick={onSelect}
            aria-haspopup="dialog"
            aria-label={`${label}, ${detail}: show accounts`}
          >
            {label}
          </button>
        ) : (
          <>
            <span className="stocks-ticker">{label}</span>
            <span className="stocks-sr-only"> ({detail})</span>
          </>
        )}
      </th>
      <OtherCells
        cells={{
          marketValue: numberCell(formatMoney(value), "stocks-strong"),
          portfolioPercent: numberCell(total > 0 ? percentFormatter.format(value / total) : "—"),
        }}
      />
    </tr>
  );
}

// Placeholder rows while the first load is in flight.
function LoadingRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <tr key={row} aria-hidden="true">
          <th scope="row" className="stocks-symbol">
            <Skeleton width="40px" />
          </th>
          {COLUMNS.map((column) => (
            <td key={column.id} className="stocks-num">
              <Skeleton width="64px" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// The holdings table: one sortable row per symbol and a total. The Stocks
// page shows today's; the P&L calendar shows a past day's, with dayLabel
// "Day" in place of "Today" in the column names.
export function HoldingsTable({
  summary,
  isLoading,
  dayLabel = "Today",
}: {
  summary: StocksSummary | null;
  isLoading: boolean;
  dayLabel?: string;
}) {
  const [sort, setSort] = useState<SortState>(null);

  const sortedRows = useMemo(() => {
    const rows = summary?.rows ?? [];
    if (sort === null) {
      return rows;
    }

    const valueOf =
      sort.column === SYMBOL_COLUMN.id
        ? SYMBOL_COLUMN.sortValue
        : COLUMNS.find((column) => column.id === sort.column)?.sortValue;
    return valueOf ? sortRows(rows, sort.direction, valueOf) : rows;
  }, [summary, sort]);

  const handleSort = useCallback((column: string, firstDirection: SortDirection) => {
    setSort((current) => nextSort(current, column, firstDirection));
  }, []);

  const investedValue = summary ? summary.holdingsValue + summary.otherInvestmentsValue : 0;

  return (
    <div className="stocks-table-wrap" tabIndex={0} aria-label="Holdings table (scrolls sideways)">
      <table className="stocks-table">
        <thead>
          <tr>
            <SortHeader
              id={SYMBOL_COLUMN.id}
              name={SYMBOL_COLUMN.name}
              label={SYMBOL_COLUMN.name}
              numeric={false}
              sort={sort}
              firstDirection={SYMBOL_COLUMN.firstDirection}
              onSort={handleSort}
            />
            {COLUMNS.map((column) => (
              <SortHeader
                key={column.id}
                id={column.id}
                name={column.name}
                label={columnLabel(column, dayLabel)}
                numeric
                sort={sort}
                firstDirection={column.firstDirection}
                onSort={handleSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading && <LoadingRows />}
          {sortedRows.map((row) => <HoldingRow key={row.key} row={row} />)}
          {summary && summary.otherInvestmentsValue > 0 && (
            <SummaryRow
              label="Other"
              detail="Other investments: accounts without holdings detail"
              value={summary.otherInvestmentsValue}
              total={summary.totalValue}
            />
          )}
        </tbody>
        {summary && (
          <tfoot>
            <tr>
              <th scope="row" className="stocks-symbol">Total</th>
              <OtherCells
                cells={{
                  dayPnl: numberCell(formatSignedMoney(summary.dayPnl), tone(summary.dayPnl)),
                  marketValue: numberCell(formatMoney(investedValue)),
                  totalPnl: numberCell(formatSignedMoney(summary.totalPnl), tone(summary.totalPnl)),
                  portfolioPercent: numberCell(
                    summary.totalValue > 0 ? percentFormatter.format(investedValue / summary.totalValue) : "—",
                  ),
                }}
              />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

const viewPercent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

const CLASS_SHORT_NAMES: Record<AssetClass, string> = { us: "US", intl: "Intl", bonds: "Bonds", cash: "Cash", other: "Other" };

// Links to the pages that look at the whole portfolio.
function PortfolioViews({ allocation, yearReturn }: { allocation: Allocation; yearReturn: number | null | undefined }) {
  const largest = allocation.classes.reduce((best, item) => (item.value > best.value ? item : best));
  const risk = estimateRisk(Object.fromEntries(allocation.classes.map((item) => [item.id, item.share])));

  return (
    <nav className="dash-card st-views" aria-label="Portfolio views">
      <Link href="/stocks/allocation" className="st-view">
        <span className="st-view-label">
          Allocation
          <Icon name="chevronRight" size={16} strokeWidth={2.4} />
        </span>
        <span className="st-view-value">
          {viewPercent.format(largest.share)} <small>{CLASS_SHORT_NAMES[largest.id]}</small>
        </span>
        <span className="al-stack" aria-hidden="true">
          {allocation.classes
            .filter((item) => item.value > 0)
            .map((item) => (
              <span
                key={item.id}
                style={{ flexGrow: item.value, background: ASSET_CLASSES.find((info) => info.id === item.id)!.color }}
              />
            ))}
        </span>
      </Link>
      <Link href="/stocks/risk" className="st-view">
        <span className="st-view-label">
          Risk &amp; return
          <Icon name="chevronRight" size={16} strokeWidth={2.4} />
        </span>
        <span className={`st-view-value ${yearReturn != null && yearReturn < 0 ? "st-view-down" : ""}`}>
          {yearReturn === undefined ? (
            <Skeleton width="70%" height="26px" />
          ) : yearReturn === null ? (
            "—"
          ) : (
            <>
              {yearReturn > 0 ? "+" : yearReturn < 0 ? "−" : ""}
              {viewPercent.format(Math.abs(yearReturn))} <small>1Y</small>
            </>
          )}
        </span>
        <span className="st-view-note">Volatility {risk.volatility.toFixed(1)}%</span>
      </Link>
    </nav>
  );
}

function CashDialog({
  positions,
  total,
  portfolioValue,
  onClose,
}: {
  positions: CashPosition[];
  total: number;
  portfolioValue: number;
  onClose: () => void;
}) {
  return (
    <DetailDialog
      title="Cash"
      subtitle="Bank balances, uninvested brokerage cash, and money-market funds and other cash equivalents"
      onClose={onClose}
    >
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(total)}</p>
        <p className="detail-summary-caption">
          {portfolioValue > 0 && `${detailPercent.format(total / portfolioValue)} of your portfolio · `}
          {positions.length} {positions.length === 1 ? "account" : "accounts"}
        </p>
      </div>

      {positions.length === 0 ? (
        <p className="detail-note">No cash in your connected accounts.</p>
      ) : (
        <table className="detail-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="detail-num">Amount</th>
              <th scope="col" className="detail-num">%</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.accountId}>
                <th scope="row">
                  <span className="detail-symbol">{position.accountName}</span>
                  <span className="detail-name">
                    {position.institution} · via {SOURCE_LABELS[position.source]}
                  </span>
                  <span className="detail-name">{position.sources.join(" + ")}</span>
                </th>
                <td className="detail-num">{formatMoney(position.amount)}</td>
                <td className="detail-num">{total > 0 ? detailPercent.format(position.amount / total) : "—"}</td>
              </tr>
            ))}
          </tbody>
          {positions.length > 1 && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="detail-num">{formatMoney(total)}</td>
                <td className="detail-num">100%</td>
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </DetailDialog>
  );
}

export default function StocksView({ username, isSigningOut, onSignOut, onSessionExpired }: StocksViewProps) {
  // The last loaded data shows at once (e.g. when returning from the
  // overview) while a fresh copy loads in the background.
  const { entry, showUpdating } = useCachedResource<StocksData>("stocks");
  const data = entry?.data ?? null;
  const [showCash, setShowCash] = useState(false);
  const [loadError, setLoadError] = useState("");
  const apiFetch = useApiFetch(onSessionExpired);

  const loadStocks = useCallback(async () => {
    try {
      await refreshResource("stocks", apiFetch);
      setLoadError("");
      // Warm the overview so switching back is instant too, and the P&L
      // calendar behind Total P&L.
      prefetchResource("dashboard", apiFetch);
      prefetchResource("pnl", apiFetch);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : LOAD_FAILED_MESSAGE);
    }
  }, [apiFetch]);

  useEffect(() => subscribeToLiveRefresh(loadStocks), [loadStocks]);

  const yearReturns = useReturns("1Y", apiFetch);
  const allocation = useMemo(
    () => (data ? buildAllocation(data.rows, data.cashValue, data.otherInvestmentsValue) : null),
    [data],
  );

  const irrCaption =
    data === null || data.irrStatus === "unavailable"
      ? "Needs history"
      : data.irrStatus === "estimated"
        ? `Est. ${data.irrHoldings.included} of ${data.irrHoldings.total}`
        : "Annualized";
  const irrTitle =
    data?.irrStatus === "estimated"
      ? `Estimated: ${data.irrHoldings.included} of ${data.irrHoldings.total} holdings are fully covered by your transaction history`
      : "Money-weighted, annualized";
  const investedValue = data ? data.holdingsValue + data.otherInvestmentsValue : 0;
  const isLoading = data === null && !loadError;

  return (
    <main className="dash-page stocks-page">
      <AppHeader
        username={username}
        active="stocks"
        busy={isSigningOut}
        onSignOut={onSignOut}
        onSessionExpired={onSessionExpired}
      />

      <div className="dash-content stocks-content">
        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? staleDataMessage("your holdings", entry.fetchedAt)
              : loadError}
          </p>
        )}

        <section className="dash-hero" aria-labelledby="portfolio-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="portfolio-heading" className="dash-label">Portfolio value</h1>
            <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
          </div>
          <p className="dash-hero-value">
            {data ? <HeroAmount value={data.totalValue} /> : loadError ? "—" : <Skeleton width="52%" height="44px" />}
          </p>
          <p className="dash-hero-breakdown">
            {data ? (
              <>
                {formatMoney(investedValue)} invested · {formatMoney(data.cashValue)} cash
              </>
            ) : (
              isLoading && <Skeleton width="62%" height="12px" />
            )}
          </p>
          <dl className="stocks-stats">
            <div>
              <dt>Today</dt>
              <dd className={data ? tone(data.dayPnl) : undefined}>
                {data ? formatSignedMoney(data.dayPnl) : <Skeleton width="80%" />}
              </dd>
              <dd className="stocks-stat-caption">
                {data ? formatSignedPercent(data.dayPnlPercent) : <Skeleton width="40%" height="10px" />}
              </dd>
            </div>
            <div>
              <dt>IRR</dt>
              <dd className={data ? tone(data.irr) : undefined} title={irrTitle}>
                {data ? (data.irr !== null && data.irr >= IRR_DISPLAY_LIMIT ? ">999%" : formatShortPercent(data.irr)) : <Skeleton width="60%" />}
              </dd>
              <dd className="stocks-stat-caption">{data ? irrCaption : <Skeleton width="80%" height="10px" />}</dd>
            </div>
            <div className="stocks-stat-tap">
              <dt>
                {/* Covers the whole figure (see .stocks-stat-link::after). */}
                <Link href="/stocks/pnl" className="stocks-stat-link">
                  Total P&amp;L
                  <Icon name="chevronRight" size={11} strokeWidth={3} />
                </Link>
              </dt>
              <dd className={data ? tone(data.totalPnl) : undefined}>
                {data ? formatSignedMoney(data.totalPnl) : <Skeleton width="90%" />}
              </dd>
              <dd className="stocks-stat-caption">
                {data ? (
                  formatShortPercent(data.totalCost > 0 ? data.totalPnl / data.totalCost : null)
                ) : (
                  <Skeleton width="40%" height="10px" />
                )}
              </dd>
            </div>
          </dl>
        </section>

        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        <section className="dash-card stocks-card" aria-labelledby="holdings-heading">
          <div className="dash-card-header">
            <h2 id="holdings-heading" className="dash-card-title">Holdings</h2>
            <p className="dash-card-caption">
              {data ? `${data.rows.length} across all accounts` : isLoading && <Skeleton width="120px" height="10px" />}
            </p>
          </div>

          {data && data.rows.length === 0 ? (
            <p className="dash-empty">
              {data.hasAccounts
                ? "No stock or fund holdings found in your connected accounts."
                : "Connect a brokerage on the Overview page to see your holdings."}
            </p>
          ) : (
            <HoldingsTable summary={data} isLoading={isLoading} />
          )}

          {data && (
            <button type="button" className="stocks-cash-row" onClick={() => setShowCash(true)} aria-haspopup="dialog">
              <span className="stocks-cash-label">
                Cash
                <Icon name="chevronRight" size={12} strokeWidth={3} />
              </span>
              <span className="stocks-cash-values">
                <span className="stocks-strong">{formatMoney(data.cashValue)}</span>
                <span className="stocks-cash-share">
                  {data.totalValue > 0 ? `${detailPercent.format(data.cashValue / data.totalValue)} of portfolio` : "—"}
                </span>
              </span>
            </button>
          )}
        </section>

        {allocation && allocation.total > 0 && (
          <PortfolioViews allocation={allocation} yearReturn={yearReturns.error ? null : yearReturns.returns?.rate} />
        )}

        <p className="stocks-footnote">
          Holdings with the same symbol are combined across accounts; select a symbol for its chart, accounts
          and activity, or Cash to see which accounts hold it. Select a column heading to sort by it; select it again to reverse the order, and a
          third time to go back. Stocks and ETFs use live prices{data?.pricesAsOf ? ` (last trade ${formatTime(data.pricesAsOf)})` : ""};
          funds, crypto, and other holdings use the last value your brokerage reported. IRR is the annualized
          money-weighted return from your transaction history; &ldquo;est.&rdquo; means part of the position
          isn&apos;t covered by that history. Last purchase is the most recent buy in any account, including
          recurring buys and reinvested dividends; &ldquo;—&rdquo; means there&apos;s none in the history your
          brokerage shares. Debts aren&apos;t subtracted from the portfolio value.
        </p>
      </div>
      {showCash && data && (
        <CashDialog
          positions={data.cashPositions}
          total={data.cashValue}
          portfolioValue={data.totalValue}
          onClose={() => setShowCash(false)}
        />
      )}
    </main>
  );
}
