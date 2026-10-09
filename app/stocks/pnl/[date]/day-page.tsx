"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { errorMessage, formatMoney, isRecord, readJson, useApiFetch } from "../../../client-api";
import { HeroAmount, Icon, Skeleton } from "../../../theme-ui";
import { useSignedInUser } from "../../../use-signed-in-user";
import { HoldingsTable } from "../../stocks-view";
import type { DayHoldingsData } from "@/lib/day-holdings";

const LOAD_FAILED = "That day's holdings couldn't be worked out. Try again.";
// Holdings owned for only days can annualize to meaningless extremes.
const IRR_DISPLAY_LIMIT = 9.99;

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const shortPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Days already loaded this visit. A past day doesn't change.
const dayCache = new Map<string, DayHoldingsData>();

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

function signedMoney(value: number | null): string {
  return value === null ? "—" : signed(value, formatMoney(Math.abs(value)));
}

function signedPercent(value: number | null, formatter = percentFormatter): string {
  return value === null ? "—" : signed(value, formatter.format(Math.abs(value)));
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "" : value > 0 ? "stocks-up" : "stocks-down";
}

function fullDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function useDayHoldings(date: string, onSessionExpired: () => void) {
  const apiFetch = useApiFetch(onSessionExpired);
  const [loaded, setLoaded] = useState<{ date: string; data: DayHoldingsData | null; error: string } | null>(null);
  const cached = dayCache.get(date) ?? null;

  useEffect(() => {
    if (dayCache.has(date)) {
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const response = await apiFetch(`/api/stocks/pnl/${encodeURIComponent(date)}`);

        if (response === null || cancelled) {
          return;
        }

        const body = await readJson(response);

        if (!response.ok || !isRecord(body) || !Array.isArray(body.rows)) {
          setLoaded({ date, data: null, error: errorMessage(body, LOAD_FAILED) });
          return;
        }

        dayCache.set(date, body as DayHoldingsData);
        setLoaded({ date, data: body as DayHoldingsData, error: "" });
      } catch {
        if (!cancelled) {
          setLoaded({ date, data: null, error: LOAD_FAILED });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [apiFetch, date]);

  return {
    data: cached ?? (loaded?.date === date ? loaded.data : null),
    error: loaded?.date === date ? loaded.error : "",
  };
}

function DayView({ date, onSessionExpired }: { date: string; onSessionExpired: () => void }) {
  const { data, error } = useDayHoldings(date, onSessionExpired);
  const isLoading = data === null && !error;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const irrCaption =
    data === null || data.irrStatus === "unavailable"
      ? "Needs history"
      : data.irrStatus === "estimated"
        ? `Est. ${data.irrHoldings.included} of ${data.irrHoldings.total}`
        : "Annualized";

  return (
    <main className="dash-page hd-page stocks-page">
      <div className="dash-content stocks-content">
        <div className="hd-top">
          <Link href={validDate ? `/stocks/pnl?month=${date.slice(0, 7)}` : "/stocks/pnl"} className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            P&amp;L
          </Link>
        </div>

        {error && (
          <p className="dash-message" role="status" aria-live="polite">
            {error}
          </p>
        )}

        <section className="dash-hero" aria-labelledby="day-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="day-heading" className="dash-label">
              {validDate ? fullDate(date) : "Day"}
            </h1>
          </div>
          <p className="dash-hero-value">
            {data ? <HeroAmount value={data.holdingsValue} /> : error ? "—" : <Skeleton width="52%" height="44px" />}
          </p>
          <p className="dash-hero-breakdown">
            {data ? "Holdings at the close" : isLoading && <Skeleton width="40%" height="12px" />}
          </p>
          <dl className="stocks-stats">
            <div>
              <dt>Day</dt>
              <dd className={data ? tone(data.dayPnl) : undefined}>
                {data ? signedMoney(data.dayPnl) : <Skeleton width="80%" />}
              </dd>
              <dd className="stocks-stat-caption">
                {data ? signedPercent(data.dayPnlPercent) : <Skeleton width="40%" height="10px" />}
              </dd>
            </div>
            <div>
              <dt>IRR</dt>
              <dd className={data ? tone(data.irr) : undefined}>
                {data ? (
                  data.irr !== null && data.irr >= IRR_DISPLAY_LIMIT ? ">999%" : signedPercent(data.irr, shortPercent)
                ) : (
                  <Skeleton width="60%" />
                )}
              </dd>
              <dd className="stocks-stat-caption">{data ? irrCaption : <Skeleton width="80%" height="10px" />}</dd>
            </div>
            <div>
              <dt>Total P&amp;L</dt>
              <dd className={data ? tone(data.totalPnl) : undefined}>
                {data ? signedMoney(data.totalPnl) : <Skeleton width="90%" />}
              </dd>
              <dd className="stocks-stat-caption">
                {data ? (
                  signedPercent(data.totalCost > 0 ? data.totalPnl / data.totalCost : null, shortPercent)
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
            <p className="dash-empty">No holdings with market prices that day.</p>
          ) : (
            error === "" && <HoldingsTable summary={data} isLoading={isLoading} dayLabel="Day" />
          )}
        </section>

        <p className="stocks-footnote">
          Your holdings at that day&apos;s close, worked out from today&apos;s holdings and your brokerage
          transaction history, priced at each symbol&apos;s closing price. Cost and average price are rolled back
          the same way at average cost. Day P&amp;L is the change from the previous close plus sales, less
          purchases, plus dividends, as on the calendar. Cash that day isn&apos;t known, so % of portfolio is of
          the holdings shown.
          {data && data.missing > 0
            ? ` ${data.missing} ${data.missing === 1 ? "holding isn't" : "holdings aren't"} shown (no daily prices or history that far back, e.g. some funds and 401(k) trusts).`
            : ""}
          {data && data.indexed > 0
            ? ` ${data.indexed === 1 ? "A fund without market prices that tracks an index (like the S&P 500) is" : `${data.indexed} funds without market prices that track an index (like the S&P 500) are`} estimated from the daily moves of an ETF that tracks the same index (a target-date fund from a mix of US stock, international stock and bond ETFs), scaled to the fund's latest price.`
            : ""}
        </p>
      </div>
    </main>
  );
}

export default function DayPage({ date }: { date: string }) {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <DayView date={date} onSessionExpired={onSessionExpired} />;
}
