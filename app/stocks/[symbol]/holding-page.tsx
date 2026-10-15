"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { errorMessage, formatMoney, isRecord, readJson, staleDataMessage } from "../../client-api";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import { useStocks } from "../use-stocks";
import type { StockActivity, StockRow } from "@/lib/portfolio";

type Range = "1D" | "1W" | "1M" | "6M" | "1Y" | "All";

const RANGES: Range[] = ["1D", "1W", "1M", "6M", "1Y", "All"];
const RANGE_LABELS: Record<Range, string> = {
  "1D": "Today",
  "1W": "Past week",
  "1M": "Past month",
  "6M": "Past 6 months",
  "1Y": "Past year",
  All: "All",
};

type Close = { date: string; close: number };
// estimatedFrom: the ETFs whose moves stand in for a fund or bond without
// market prices of its own; the closes then need scaling to its price.
type Chart = { closes: Close[]; estimatedFrom?: string[] };

// Account colors on this page, by size of holding.
const ACCOUNT_COLORS = ["#2e6a62", "#6e9a33", "#a9cf7f", "#6fb0a8", "#9fcbc6"];
const REST_COLOR = "#bdbdb5";
// The same colors dark enough for text on white.
const ACCOUNT_TEXT_COLORS = ["#2e6a62", "#4c7a1e", "#557a2c", "#2f6f68", "#3f6f6a"];

// Activity rows shown before "See all activity".
const RECENT_ACTIVITY = 4;

const sharesFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const sharePercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const listFormatter = new Intl.ListFormat("en-US");
const changePercent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Charts already fetched this visit, by holding and range.
const chartCache = new Map<string, Chart>();

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

function signedMoney(value: number): string {
  return signed(value, formatMoney(Math.abs(value)));
}

function signedPercent(value: number): string {
  return signed(value, percentFormatter.format(Math.abs(value)));
}

function signedChangePercent(value: number): string {
  return signed(value, changePercent.format(Math.abs(value)));
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "" : value > 0 ? "stocks-up" : "stocks-down";
}

function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// 1D chart points are full timestamps; the rest are dates.
function pointLabel(date: string): string {
  return date.length > 10
    ? new Date(date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    : longDate(date);
}

// A change with its percent underneath.
function ChangeStat({ label, amount, percent }: { label: string; amount: number | null; percent: number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone(amount)}>{amount === null ? "—" : signedMoney(amount)}</dd>
      <dd className="stocks-stat-caption">{percent === null ? "" : signedChangePercent(percent)}</dd>
    </div>
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function activityLabel(activity: StockActivity): string {
  const shares = sharesFormatter.format(Math.abs(activity.shares));
  const noun = Math.abs(activity.shares) === 1 ? "share" : "shares";

  if (activity.amount === null) {
    return `${activity.shares > 0 ? "Received" : "Moved out"} ${shares} ${noun}`;
  }

  return `${activity.shares > 0 ? "Bought" : "Sold"} ${shares} ${noun}`;
}

// The price line for a range, with a reference price (the average price, or
// the previous close on 1D) dashed across it.
function PriceChart({ closes, reference }: { closes: Close[]; reference: number | null }) {
  const width = 360;
  const height = 150;
  const pad = 6;
  const values = closes.map((close) => close.close);
  const low = Math.min(...values, reference ?? Infinity);
  const high = Math.max(...values, reference ?? -Infinity);
  const spread = high - low || 1;
  const x = (index: number) => (closes.length < 2 ? width : (index / (closes.length - 1)) * width);
  const y = (value: number) => pad + (1 - (value - low) / spread) * (height - pad * 2);
  const line = closes.map((close, index) => `${x(index).toFixed(1)},${y(close.close).toFixed(1)}`).join(" ");
  const first = closes[0];
  const last = closes.at(-1)!;
  const change = (last.close - first.close) / first.close;

  return (
    <div className="hd-chart">
      <svg
        className="hd-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Price from ${formatMoney(first.close)} at ${pointLabel(first.date)} to ${formatMoney(last.close)} at ${pointLabel(last.date)}, ${signedPercent(change)}`}
      >
        <polygon points={`0,${height} ${line} ${width},${height}`} className="hd-chart-area" />
        {reference !== null && (
          <line x1="0" x2={width} y1={y(reference)} y2={y(reference)} className="hd-chart-average" vectorEffect="non-scaling-stroke" />
        )}
        <polyline points={line} className="hd-chart-line" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Drawn outside the stretched SVG so it stays round. */}
      <span className="hd-chart-dot" style={{ top: `${(y(last.close) / height) * 100}%` }} aria-hidden="true" />
    </div>
  );
}

function HoldingView({
  holdingKey,
  onSessionExpired,
}: {
  holdingKey: string;
  onSessionExpired: () => void;
}) {
  const { entry, data, showUpdating, loadError, apiFetch } = useStocks(onSessionExpired);
  const [range, setRange] = useState<Range>("1D");
  const [chart, setChart] = useState<{ key: string; chart: Chart | null; error: string } | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const row: StockRow | undefined = data?.rows.find(
    (candidate) => candidate.key === holdingKey || candidate.key === safeDecode(holdingKey),
  );
  const chartKey = row ? `${row.key}:${range}` : null;
  const chartQuery = row
    ? new URLSearchParams({ symbol: row.ticker ?? "", name: row.name, type: row.securityType ?? "", range }).toString()
    : null;
  const loaded = chartKey === null ? null : (chartCache.get(chartKey) ?? (chart?.key === chartKey ? chart.chart : null));
  const chartError = chart?.key === chartKey ? chart.error : "";
  const lastClose = loaded?.closes.at(-1)?.close;
  // Estimated charts follow their ETFs' moves, ending at the holding's price.
  const closes =
    loaded?.estimatedFrom && row?.price != null && lastClose
      ? loaded.closes.map((close) => ({ date: close.date, close: (close.close * row.price!) / lastClose }))
      : (loaded?.closes ?? null);

  useEffect(() => {
    if (chartQuery === null || chartKey === null || chartCache.has(chartKey)) {
      return;
    }

    let cancelled = false;

    async function loadChart(query: string, key: string) {
      try {
        const response = await apiFetch(`/api/stocks/history?${query}`);

        if (response === null || cancelled) {
          return;
        }

        const body = await readJson(response);

        if (!response.ok || !isRecord(body) || !Array.isArray(body.closes)) {
          setChart({ key, chart: null, error: errorMessage(body, "Price history couldn't be loaded.") });
          return;
        }

        const loadedChart: Chart = {
          closes: body.closes as Close[],
          estimatedFrom: Array.isArray(body.estimatedFrom) ? (body.estimatedFrom as string[]) : undefined,
        };
        // 1D keeps moving, so it is fetched again on each visit to it.
        if (range !== "1D") {
          chartCache.set(key, loadedChart);
        }
        setChart({ key, chart: loadedChart, error: "" });
      } catch {
        if (!cancelled) {
          setChart({ key, chart: null, error: "Price history couldn't be loaded." });
        }
      }
    }

    void loadChart(chartQuery, chartKey);

    return () => {
      cancelled = true;
    };
  }, [apiFetch, chartKey, chartQuery, range]);

  const isLoading = data === null && !loadError;
  const colorFor = (index: number) => ACCOUNT_COLORS[index] ?? REST_COLOR;
  const accountColors = new Map(
    row?.positions.map((position, index) => [position.accountId, ACCOUNT_TEXT_COLORS[index] ?? "var(--muted)"]) ?? [],
  );
  const accountNames = new Map(row?.positions.map((position) => [position.accountId, position.accountName]) ?? []);
  const costBasis = row && row.averagePrice !== null ? row.averagePrice * row.shares : null;
  const thisYear = new Date().getFullYear();
  const activity = row ? (showAllActivity ? row.activity : row.activity.slice(0, RECENT_ACTIVITY)) : [];
  const previousClose =
    row?.price != null && row.dayChangePercent != null ? row.price / (1 + row.dayChangePercent) : null;
  const reference = range === "1D" ? previousClose : (row?.averagePrice ?? null);
  // The range's change for the shares held now, from its first close to today's price.
  const start = range === "1D" ? undefined : closes?.[0];
  const rangeChange = start !== undefined && row?.price != null ? row.price - start.close : null;

  return (
    <main className="dash-page hd-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href="/stocks" className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            Stocks
          </Link>
          <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
        </div>

        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? staleDataMessage("your holdings", entry.fetchedAt)
              : loadError}
          </p>
        )}

        {data && !row && (
          <p className="dash-message">
            You don&apos;t hold {safeDecode(holdingKey)} in any connected account. <Link href="/stocks">Back to Stocks</Link>
          </p>
        )}

        <section className="dash-hero" aria-labelledby="holding-heading" aria-busy={isLoading}>
          <h1 id="holding-heading" className="hd-title">
            <span className="hd-symbol">{row ? (row.ticker ?? row.name) : safeDecode(holdingKey)}</span>
            {row?.ticker && <span className="hd-name">{row.name}</span>}
          </h1>
          <p className="dash-hero-value">
            {row ? (
              row.price === null ? "—" : <HeroAmount value={row.price} />
            ) : isLoading ? (
              <Skeleton width="50%" height="44px" />
            ) : (
              "—"
            )}
          </p>
          {row &&
            (range === "1D" ? (
              <dl className="stocks-stats hd-change">
                <ChangeStat label="Today" amount={row.dayPnl} percent={row.dayChangePercent} />
                {row.extendedPnl != null && (
                  <ChangeStat
                    label={data?.extendedLabel ?? "After hours"}
                    amount={row.extendedPnl}
                    percent={row.extendedChangePercent ?? null}
                  />
                )}
              </dl>
            ) : (
              <dl className="stocks-stats hd-change">
                {start === undefined ? (
                  <div>
                    <dt>{RANGE_LABELS[range]}</dt>
                    <dd>{closes ? "—" : <Skeleton width="60%" />}</dd>
                  </div>
                ) : (
                  <ChangeStat
                    label={range === "All" ? `Since ${longDate(start.date)}` : RANGE_LABELS[range]}
                    amount={rangeChange === null ? null : rangeChange * row.shares}
                    percent={rangeChange === null ? null : rangeChange / start.close}
                  />
                )}
              </dl>
            ))}
        </section>

        {row && (
          <div className="hd-chart-block">
            {closes && closes.length > 1 ? (
              <PriceChart closes={closes} reference={reference} />
            ) : chartError ? (
              <p className="hd-chart-note">{chartError}</p>
            ) : closes ? (
              <p className="hd-chart-note">No prices for this range.</p>
            ) : (
              <Skeleton width="100%" height="150px" className="hd-chart-skeleton" />
            )}
            {reference !== null && (
              <p className="hd-chart-key">
                <span className="hd-dash" aria-hidden="true" />
                {range === "1D" ? "Previous close" : "Your average price"} {formatMoney(reference)}
              </p>
            )}
            {loaded?.estimatedFrom && closes && closes.length > 1 && (
              <p className="hd-chart-key">Estimated from {listFormatter.format(loaded.estimatedFrom)}</p>
            )}
            <div className="hd-ranges" role="group" aria-label="Chart range">
              {RANGES.map((option) => (
                <button key={option} type="button" aria-pressed={range === option} onClick={() => setRange(option)}>
                  {option}
                </button>
              ))}
            </div>
          </div>
        )}

        {row && (
          <>
            <div className="sp-tiles">
              <div className="sp-tile sp-tile-out">
                <span className="sp-tile-label">Shares owned</span>
                <span className="sp-tile-value">{sharesFormatter.format(row.shares)}</span>
                <span className="sp-tile-note">
                  {row.averagePrice === null ? "No cost from your brokerage" : `Avg price ${formatMoney(row.averagePrice)}`}
                </span>
              </div>
              <div className="sp-tile hd-tile-plain">
                <span className="sp-tile-label">Total P&amp;L</span>
                <span className={`sp-tile-value ${tone(row.totalPnl)}`}>
                  {row.totalPnl === null ? "—" : signedMoney(row.totalPnl)}
                </span>
                <span className="sp-tile-note">
                  {[
                    row.totalPnlPercent === null ? null : signedPercent(row.totalPnlPercent),
                    row.irr === null ? null : `IRR ${signedPercent(row.irr)}${row.irrStatus === "estimated" ? " est." : ""}`,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Needs cost from your brokerage"}
                </span>
              </div>
            </div>

            <section className="dash-card sp-section" aria-labelledby="position-heading">
              <h2 id="position-heading" className="sp-card-title">Your position</h2>
              <dl className="hd-facts">
                <div>
                  <dt>Market value</dt>
                  <dd>{formatMoney(row.marketValue)}</dd>
                </div>
                <div>
                  <dt>Portfolio share</dt>
                  <dd>{percentFormatter.format(row.portfolioPercent)}</dd>
                </div>
                <div>
                  <dt>Cost basis</dt>
                  <dd>{costBasis === null ? "—" : formatMoney(costBasis)}</dd>
                </div>
                <div>
                  <dt>Today&apos;s P&amp;L</dt>
                  <dd className={tone(row.dayPnl)}>{row.dayPnl === null ? "—" : signedMoney(row.dayPnl)}</dd>
                </div>
                <div>
                  <dt>Last purchased</dt>
                  <dd>{row.lastPurchase ? longDate(row.lastPurchase) : "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="dash-card sp-section" aria-labelledby="accounts-heading">
              <h2 id="accounts-heading" className="sp-card-title">
                Held in {row.positions.length} {row.positions.length === 1 ? "account" : "accounts"}
              </h2>
              {row.positions.length > 1 && (
                <div className="sp-stack" aria-hidden="true">
                  {row.positions.map((position, index) => (
                    <span key={position.accountId} style={{ flexGrow: Math.max(position.marketValue, 0), background: colorFor(index) }} />
                  ))}
                </div>
              )}
              <ul className="sp-list">
                {row.positions.map((position, index) => (
                  <li key={position.accountId} className="sp-list-row hd-account">
                    <span className="sp-swatch" style={{ background: colorFor(index) }} aria-hidden="true" />
                    <span className="sp-list-main">
                      <span className="sp-list-name">{position.accountName}</span>
                      <span className="sp-list-detail">
                        {sharesFormatter.format(position.shares)} {position.shares === 1 ? "share" : "shares"}
                        {position.costBasis !== null && position.shares !== 0
                          ? ` · avg ${formatMoney(position.costBasis / position.shares)}`
                          : ` · ${position.institution}`}
                      </span>
                    </span>
                    <span className="hd-account-values">
                      <span className="sp-list-amount">{formatMoney(position.marketValue)}</span>
                      <span className="sp-list-detail">
                        {row.marketValue > 0 ? sharePercent.format(position.marketValue / row.marketValue) : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="dash-card sp-section" aria-labelledby="activity-heading">
              <div className="dash-card-header">
                <h2 id="activity-heading" className="sp-card-title">Activity</h2>
                {row.activity.length > 0 && (
                  <span className="sp-card-note">
                    {showAllActivity ? `All ${row.activity.length}` : `Last ${Math.min(RECENT_ACTIVITY, row.activity.length)}`}
                  </span>
                )}
              </div>
              {row.activity.length === 0 ? (
                <p className="dash-empty">No buys or sales in the history your brokerage shares.</p>
              ) : (
                <ul className="sp-list">
                  {activity.map((item, index) => {
                    const [year, month, day] = item.date.split("-");
                    const monthName = new Date(Date.UTC(2000, Number(month) - 1, 1)).toLocaleDateString("en-US", {
                      month: "short",
                      timeZone: "UTC",
                    });

                    return (
                      <li key={`${item.date}-${item.accountId}-${index}`} className="sp-list-row hd-activity">
                        <span className="hd-date" aria-label={longDate(item.date)}>
                          <span>
                            {monthName}
                            {Number(year) === thisYear ? "" : ` ’${year.slice(2)}`}
                          </span>
                          <b>{Number(day)}</b>
                        </span>
                        <span className="sp-list-main">
                          <span className="sp-list-name">{activityLabel(item)}</span>
                          <span className="hd-activity-account" style={{ color: accountColors.get(item.accountId) ?? "var(--muted)" }}>
                            {accountNames.get(item.accountId) ?? "Closed account"}
                          </span>
                        </span>
                        {item.amount !== null && (
                          <span className="hd-account-values">
                            <span className="sp-list-amount">{formatMoney(item.amount)}</span>
                            <span className="sp-list-detail">
                              {formatMoney(item.amount / Math.abs(item.shares))}/share
                            </span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {row.activity.length > RECENT_ACTIVITY && (
                <button
                  type="button"
                  className="pill-button pill-button-soft sp-more"
                  onClick={() => setShowAllActivity((shown) => !shown)}
                  aria-expanded={showAllActivity}
                >
                  {showAllActivity ? "Show recent activity" : "See all activity"}
                  <Icon name={showAllActivity ? "chevronDown" : "chevronRight"} size={16} strokeWidth={2.4} />
                </button>
              )}
            </section>

            <p className="stocks-footnote spend-page-note">
              Combined across your accounts. Average price and P&amp;L come from the buys your brokerage shares; the
              chart&apos;s dashed line is your average price (the previous close on 1D). The 1D chart is 5-minute
              prices, pre-market and after hours included, 15 minutes behind; other ranges are daily closes. Funds and
              Treasury bonds without market prices of their own are charted from the moves of ETFs that track the
              same index or maturity, ending at the price your brokerage reported (moved with those ETFs today). A
              range&apos;s P&amp;L is for the shares you hold now.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

export default function HoldingPage({ holdingKey }: { holdingKey: string }) {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <HoldingView holdingKey={holdingKey} onSessionExpired={onSessionExpired} />;
}
