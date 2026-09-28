"use client";

import { useCallback, useEffect, useState } from "react";

import AppHeader from "../app-header";
import DetailDialog from "../detail-dialog";
import { formatMoney, formatTime, subscribeToLiveRefresh, useApiFetch } from "../client-api";
import { prefetchResource, refreshResource, useCachedResource } from "../client-cache";
import type { CashPosition, IrrStatus, StockRow } from "@/lib/portfolio";
import type { StocksData } from "@/lib/stocks";

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

function formatIrr(value: number | null): string {
  if (value === null) {
    return "—";
  }

  if (value >= IRR_DISPLAY_LIMIT) {
    return ">999%";
  }

  return formatSignedPercent(value);
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

const SOURCE_LABELS = { snaptrade: "SnapTrade", plaid: "Plaid" } as const;

// The ticker, or the name for securities without one (some 401(k) funds).
function symbolLabel(row: StockRow): string {
  return row.ticker ?? row.name;
}

function HoldingRow({ row, onSelect }: { row: StockRow; onSelect: (row: StockRow) => void }) {
  return (
    <tr>
      <th scope="row" className="stocks-symbol">
        <button
          type="button"
          className="stocks-ticker-button"
          onClick={() => onSelect(row)}
          title={row.name}
          aria-haspopup="dialog"
          aria-label={`${symbolLabel(row)}, ${row.name}: show accounts`}
        >
          {symbolLabel(row)}
        </button>
      </th>
      <td className="stocks-num">{sharesFormatter.format(row.shares)}</td>
      <td className="stocks-num">{row.averagePrice === null ? "—" : formatMoney(row.averagePrice)}</td>
      <td className="stocks-num">{row.price === null ? "—" : formatMoney(row.price)}</td>
      <td className={`stocks-num ${tone(row.dayChangePercent)}`}>{formatSignedPercent(row.dayChangePercent)}</td>
      <td className={`stocks-num ${tone(row.dayPnl)}`}>{formatSignedMoney(row.dayPnl)}</td>
      <td className="stocks-num stocks-strong">{formatMoney(row.marketValue)}</td>
      <td className={`stocks-num ${tone(row.totalPnl)}`}>{formatSignedMoney(row.totalPnl)}</td>
      <td className={`stocks-num ${tone(row.totalPnlPercent)}`}>{formatSignedPercent(row.totalPnlPercent)}</td>
      <IrrCell value={row.irr} status={row.irrStatus} note={row.irrNote} />
      <td className="stocks-num">{percentFormatter.format(row.portfolioPercent)}</td>
    </tr>
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
      <td colSpan={5} />
      <td className="stocks-num stocks-strong">{formatMoney(value)}</td>
      <td colSpan={3} />
      <td className="stocks-num">{total > 0 ? percentFormatter.format(value / total) : "—"}</td>
    </tr>
  );
}

function StockDialog({ row, onClose }: { row: StockRow; onClose: () => void }) {
  const subtitle = row.ticker ? row.name : row.securityType ?? undefined;

  return (
    <DetailDialog title={symbolLabel(row)} subtitle={subtitle} onClose={onClose}>
      <div className="detail-summary">
        <p className="detail-summary-value">{formatMoney(row.marketValue)}</p>
        <p className="detail-summary-caption">
          {sharesFormatter.format(row.shares)} shares
          {row.price !== null && ` at ${formatMoney(row.price)}`}
          {row.live && " · live price"}
        </p>
      </div>

      <table className="detail-table">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" className="detail-num">Shares</th>
            <th scope="col" className="detail-num">Value</th>
            <th scope="col" className="detail-num">%</th>
          </tr>
        </thead>
        <tbody>
          {row.positions.map((position) => (
            <tr key={position.accountId}>
              <th scope="row">
                <span className="detail-symbol">{position.accountName}</span>
                <span className="detail-name">
                  {position.institution} · via {SOURCE_LABELS[position.source]}
                </span>
              </th>
              <td className="detail-num">{sharesFormatter.format(position.shares)}</td>
              <td className="detail-num">{formatMoney(position.marketValue)}</td>
              <td className="detail-num">
                {row.marketValue > 0 ? detailPercent.format(position.marketValue / row.marketValue) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        {row.positions.length > 1 && (
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="detail-num">{sharesFormatter.format(row.shares)}</td>
              <td className="detail-num">{formatMoney(row.marketValue)}</td>
              <td className="detail-num">100%</td>
            </tr>
          </tfoot>
        )}
      </table>
    </DetailDialog>
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showCash, setShowCash] = useState(false);
  const [loadError, setLoadError] = useState("");
  const apiFetch = useApiFetch(onSessionExpired);

  const loadStocks = useCallback(async () => {
    try {
      await refreshResource("stocks", apiFetch);
      setLoadError("");
      // Warm the overview so switching back is instant too.
      prefetchResource("dashboard", apiFetch);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : LOAD_FAILED_MESSAGE);
    }
  }, [apiFetch]);

  useEffect(() => subscribeToLiveRefresh(loadStocks), [loadStocks]);

  // Looked up by key so the dialog follows live refreshes.
  const selectedRow = data?.rows.find((row) => row.key === selectedKey);
  const irrCaption =
    data === null || data.irrStatus === "unavailable"
      ? "Needs transaction history"
      : data.irrStatus === "estimated"
        ? `Estimated · ${data.irrHoldings.included} of ${data.irrHoldings.total} holdings`
        : "Money-weighted, annualized";

  return (
    <main className="dash-page stocks-page">
      <AppHeader username={username} active="stocks" busy={isSigningOut} onSignOut={onSignOut} />

      <div className="dash-content stocks-content">
        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? `Couldn't refresh your holdings. Showing data from ${formatTime(new Date(entry.fetchedAt).toISOString())}.`
              : loadError}
          </p>
        )}

        <section className="dash-hero" aria-labelledby="portfolio-heading">
          <p id="portfolio-heading" className="dash-label dash-hero-label">
            Total portfolio value
            <span className="dash-updating" aria-live="polite">{showUpdating ? " · Updating…" : ""}</span>
          </p>
          <p className="dash-hero-value">
            {data ? formatMoney(data.totalValue) : loadError ? "—" : "…"}
          </p>
          {data && (
            <p className="dash-hero-breakdown">
              {formatMoney(data.holdingsValue + data.otherInvestmentsValue)} invested + {formatMoney(data.cashValue)} cash · debts not included
            </p>
          )}
          {data && (
            <dl className="stocks-stats">
              <div>
                <dt>Today</dt>
                <dd className={tone(data.dayPnl)}>
                  {formatSignedMoney(data.dayPnl)} <span>({formatSignedPercent(data.dayPnlPercent)})</span>
                </dd>
              </div>
              <div>
                <dt>Portfolio IRR</dt>
                <dd className={tone(data.irr)}>
                  {formatIrr(data.irr)}
                  <span className="stocks-stat-caption">{irrCaption}</span>
                </dd>
              </div>
              <div>
                <dt>Total P&amp;L</dt>
                <dd className={tone(data.totalPnl)}>
                  {formatSignedMoney(data.totalPnl)}{" "}
                  <span>({formatSignedPercent(data.totalCost > 0 ? data.totalPnl / data.totalCost : null)})</span>
                </dd>
              </div>
            </dl>
          )}
          {data?.pricesAsOf && (
            <p className="stocks-hero-note">Live stock and ETF prices · last trade {formatTime(data.pricesAsOf)}</p>
          )}
        </section>

        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        <section className="dash-card stocks-card" aria-labelledby="holdings-heading">
          <div className="dash-card-header">
            <h2 id="holdings-heading" className="dash-label">Holdings</h2>
            <p className="dash-card-caption">
              {data ? `${data.rows.length} ${data.rows.length === 1 ? "holding" : "holdings"} across all accounts` : ""}
            </p>
          </div>

          {data && data.rows.length === 0 ? (
            <p className="dash-empty">
              {data.hasAccounts
                ? "No stock or fund holdings found in your connected accounts."
                : "Connect a brokerage on the Overview page to see your holdings."}
            </p>
          ) : (
            <div className="stocks-table-wrap" tabIndex={0} aria-label="Holdings table (scrolls sideways)">
              <table className="stocks-table">
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col" className="stocks-num">Shares</th>
                    <th scope="col" className="stocks-num">Avg. price</th>
                    <th scope="col" className="stocks-num">Price</th>
                    <th scope="col" className="stocks-num">Today %</th>
                    <th scope="col" className="stocks-num">Today P&amp;L</th>
                    <th scope="col" className="stocks-num">Market value</th>
                    <th scope="col" className="stocks-num">Total P&amp;L</th>
                    <th scope="col" className="stocks-num">Total P&amp;L %</th>
                    <th scope="col" className="stocks-num">IRR</th>
                    <th scope="col" className="stocks-num">% of portfolio</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((row) => <HoldingRow key={row.key} row={row} onSelect={(selected) => setSelectedKey(selected.key)} />)}
                  {data && data.otherInvestmentsValue > 0 && (
                    <SummaryRow
                      label="Other"
                      detail="Other investments: accounts without holdings detail"
                      value={data.otherInvestmentsValue}
                      total={data.totalValue}
                    />
                  )}
                  {data && (
                    <SummaryRow
                      label="Cash"
                      detail="Bank accounts and uninvested cash"
                      value={data.cashValue}
                      total={data.totalValue}
                      onSelect={() => setShowCash(true)}
                    />
                  )}
                </tbody>
                {data && (
                  <tfoot>
                    <tr>
                      <th scope="row" className="stocks-symbol">Total</th>
                      <td colSpan={4} />
                      <td className={`stocks-num ${tone(data.dayPnl)}`}>{formatSignedMoney(data.dayPnl)}</td>
                      <td className="stocks-num">{formatMoney(data.totalValue)}</td>
                      <td className={`stocks-num ${tone(data.totalPnl)}`}>{formatSignedMoney(data.totalPnl)}</td>
                      <td colSpan={2} />
                      <td className="stocks-num">{data.totalValue > 0 ? percentFormatter.format(1) : "—"}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          <p className="stocks-footnote">
            Holdings with the same symbol are combined across accounts; select a symbol, or Cash, to see which
            accounts hold it. Stocks and ETFs use live prices; funds, crypto, and other holdings use the
            last value your brokerage reported. IRR is the annualized money-weighted return from your
            transaction history; &ldquo;est.&rdquo; means part of the position isn&apos;t covered by that
            history.
          </p>
        </section>
      </div>

      {selectedRow && <StockDialog row={selectedRow} onClose={() => setSelectedKey(null)} />}
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
