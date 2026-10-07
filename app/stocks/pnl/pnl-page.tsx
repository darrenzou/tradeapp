"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatMoney, staleDataMessage, subscribeToReconnect, useApiFetch } from "../../client-api";
import { refreshResource, useCachedResource } from "../../client-cache";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import type { DailyPnlData, PnlDay, PnlPeriod } from "@/lib/daily-pnl";

type View = "days" | "months";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const LOAD_FAILED = "Your daily P&L couldn't be worked out. Try again.";

const onePercent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function sign(value: number): string {
  return value > 0 ? "+" : value < 0 ? "−" : "";
}

function signedPercent(rate: number | null): string {
  return rate === null ? "—" : `${sign(Math.round(rate * 1000))}${onePercent.format(Math.abs(rate))}`;
}

function wholeMoney(value: number): string {
  const rounded = Math.round(value);
  return `${sign(rounded)}${formatMoney(Math.abs(rounded)).replace(/\.00$/, "")}`;
}

// Short enough to fit under a day of the month on a phone: +$84, −$1.2K.
function compactMoney(value: number): string {
  const size = Math.abs(value);
  const text =
    size < 999.5
      ? `${Math.round(size)}`
      : size < 9_950
        ? `${(size / 1000).toFixed(1)}K`
        : size < 999_500
          ? `${Math.round(size / 1000)}K`
          : `${(size / 1_000_000).toFixed(1)}M`;
  return `${text === "0" ? "" : sign(value)}$${text}`;
}

function tone(value: number | null | undefined, zero = 0.005): string {
  return value === null || value === undefined || Math.abs(value) < zero ? "" : value > 0 ? "pnl-up" : "pnl-down";
}

// Returns are fractions shown to 0.1%, so only one that rounds to 0.0% is plain.
function rateTone(rate: number | null): string {
  return tone(rate, 0.0005);
}

// Today on this device, YYYY-MM-DD.
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthName(month: string, style: "long" | "short" = "long"): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
}

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  let [year, index] = first.split("-").map(Number);

  while (`${year}-${String(index).padStart(2, "0")}` <= last) {
    months.push(`${year}-${String(index).padStart(2, "0")}`);
    index += 1;
    if (index > 12) {
      index = 1;
      year += 1;
    }
  }

  return months;
}

// Blank cells before the 1st, then each day of the month as YYYY-MM-DD.
function calendarCells(month: string): (string | null)[] {
  const [year, index] = month.split("-").map(Number);
  const offset = new Date(Date.UTC(year, index - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, index, 0)).getUTCDate();

  return [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length }, (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`),
  ];
}

function dayLabel(date: string, day: PnlDay | undefined): string {
  const name = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  if (day === undefined) {
    return name;
  }

  return `${name}: ${day.pnl >= 0 ? "up" : "down"} ${formatMoney(Math.abs(day.pnl))}${
    day.rate === null ? "" : `, ${signedPercent(day.rate)}`
  }`;
}

// The P&L calendar's data: the last loaded copy at once, refreshed in the
// background when the page opens.
function usePnl(onSessionExpired: () => void) {
  const { entry, showUpdating } = useCachedResource<DailyPnlData>("pnl");
  const [loadError, setLoadError] = useState("");
  const apiFetch = useApiFetch(onSessionExpired);

  useEffect(() => {
    const load = () =>
      refreshResource("pnl", apiFetch)
        .then(() => setLoadError(""))
        .catch((error) => setLoadError(error instanceof Error ? error.message : LOAD_FAILED));

    void load();
    return subscribeToReconnect(load);
  }, [apiFetch]);

  return { entry, data: entry?.data ?? null, showUpdating, loadError };
}

function MonthCalendar({
  month,
  days,
  period,
  today,
  loading,
  onOpenYear,
}: {
  month: string;
  days: Map<string, PnlDay>;
  period: PnlPeriod | undefined;
  today: string;
  loading: boolean;
  onOpenYear: () => void;
}) {
  const [year] = month.split("-");

  return (
    <section className="pnl-month" data-month={month} aria-label={`${monthName(month)} ${year}`}>
      {/* Tapping the month shows its whole year. */}
      <button type="button" className="pnl-month-head" onClick={onOpenYear} aria-label={`Show all of ${year}`}>
        <span className="pnl-month-name">
          {monthName(month)} <span>{year}</span>
          <Icon name="chevronRight" size={14} strokeWidth={2.6} />
        </span>
        {period ? (
          <span className="pnl-month-total">
            <span className={rateTone(period.rate)}>{signedPercent(period.rate)}</span>
            <b className={tone(period.pnl)}>{wholeMoney(period.pnl)}</b>
          </span>
        ) : (
          loading && <Skeleton width="72px" height="12px" />
        )}
      </button>
      <ol className="pnl-grid">
        {calendarCells(month).map((date, index) => {
          if (date === null) {
            return <li key={`blank-${index}`} className="pnl-cell" aria-hidden="true" />;
          }

          const day = days.get(date);
          const isToday = date === today;
          const content = (
            <>
              <span className={`pnl-day-num ${isToday ? "pnl-today" : ""}`} aria-hidden="true">
                {Number(date.slice(8))}
              </span>
              {day && (
                <span className={`pnl-day-value ${tone(day.pnl)}`} aria-hidden="true">
                  {compactMoney(day.pnl)}
                </span>
              )}
            </>
          );

          // A day with a figure opens its holdings; today's are the Stocks page.
          return day ? (
            <li key={date} className="pnl-cell" aria-current={isToday ? "date" : undefined}>
              <Link
                href={isToday ? "/stocks" : `/stocks/pnl/${date}`}
                className="pnl-cell-link"
                aria-label={dayLabel(date, day)}
              >
                {content}
              </Link>
            </li>
          ) : (
            <li
              key={date}
              className="pnl-cell pnl-cell-quiet"
              aria-label={dayLabel(date, day)}
              aria-current={isToday ? "date" : undefined}
            >
              {content}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function MiniMonth({
  month,
  days,
  period,
  today,
  onOpen,
  disabled,
}: {
  month: string;
  days: Map<string, PnlDay>;
  period: PnlPeriod | undefined;
  today: string;
  onOpen: () => void;
  disabled: boolean;
}) {
  // Whole dollars fit beside the return up to $9,999; past that, +$12K.
  const gain = period ? (Math.abs(period.pnl) < 9_999.5 ? wholeMoney(period.pnl) : compactMoney(period.pnl)) : "";

  return (
    <button
      type="button"
      className="pnl-mini"
      onClick={onOpen}
      disabled={disabled}
      aria-label={`${monthName(month)}${period ? `: ${signedPercent(period.rate)}, ${wholeMoney(period.pnl)}` : ""}. Show days`}
    >
      <span className="pnl-mini-head">
        <span className="pnl-mini-name">{monthName(month, "short")}</span>
        {period && (
          <span className="pnl-mini-figures">
            <span className={rateTone(period.rate)}>{signedPercent(period.rate)}</span>
            <span className={tone(period.pnl)}>{gain}</span>
          </span>
        )}
      </span>
      <span className="pnl-mini-grid" aria-hidden="true">
        {calendarCells(month).map((date, index) => {
          if (date === null) {
            return <span key={`blank-${index}`} />;
          }

          const day = days.get(date);
          const dot = day === undefined ? "" : tone(day.pnl) === "pnl-up" ? "pnl-dot-up" : tone(day.pnl) ? "pnl-dot-down" : "pnl-dot-flat";

          return (
            <span key={date} className={`pnl-mini-day ${dot} ${date === today ? "pnl-mini-today" : ""}`}>
              {Number(date.slice(8))}
            </span>
          );
        })}
      </span>
    </button>
  );
}

function Footnote({ data }: { data: DailyPnlData }) {
  return (
    <p className="stocks-footnote pnl-footnote">
      Each day is your holdings&apos; change in value from the previous close, plus dividends they paid, worked out
      from your brokerage transaction history and daily closing prices. Money you add or take out doesn&apos;t count.
      Monthly and yearly returns chain the daily returns together.
      {data.missing > 0
        ? ` ${data.missing} ${data.missing === 1 ? "position isn't" : "positions aren't"} included (no market prices or history, e.g. some funds and 401(k) trusts).`
        : ""}
      {data.indexed > 0
        ? ` ${data.indexed === 1 ? "A fund without market prices that tracks an index (like the S&P 500) is" : `${data.indexed} funds without market prices that track an index (like the S&P 500) are`} estimated from the daily moves of an ETF that tracks the same index.`
        : ""}
      {data.partial ? " Some accounts' history starts later, so early days count only the accounts covered then." : ""}
    </p>
  );
}

function PnlView({ initialMonth, onSessionExpired }: { initialMonth: string | null; onSessionExpired: () => void }) {
  const { entry, data, showUpdating, loadError } = usePnl(onSessionExpired);
  const isLoading = data === null && !loadError;
  const today = localToday();
  const currentMonth = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));
  const [view, setView] = useState<View>("days");
  // The year the months open on, and a count bumped each time they open so
  // they scroll to it again.
  const [yearFocus, setYearFocus] = useState({ year: currentYear, request: 0 });
  // The month the days open on (this month when null), and a count bumped
  // by Today so it scrolls back even when already on the days.
  const [focus, setFocus] = useState<{ month: string | null; request: number }>({
    month: initialMonth,
    request: 0,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const yearsRef = useRef<HTMLDivElement>(null);

  const days = useMemo(() => new Map((data?.days ?? []).map((day) => [day.date, day])), [data]);
  const months = useMemo(() => new Map((data?.months ?? []).map((month) => [month.key, month])), [data]);
  const years = useMemo(() => new Map((data?.years ?? []).map((item) => [item.key, item])), [data]);

  const firstMonth = data?.months[0]?.key ?? currentMonth;
  const calendarMonths = monthsBetween(firstMonth < currentMonth ? firstMonth : currentMonth, currentMonth);
  const firstYear = Math.min(Number(firstMonth.slice(0, 4)), currentYear);
  const yearList = Array.from({ length: currentYear - firstYear + 1 }, (_, index) => firstYear + index);
  const thisMonth = months.get(currentMonth);

  // Opens on this month at the bottom; scroll up for earlier months.
  const scrolledFor = useRef("");
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const target = `${view}|${focus.month}|${focus.request}|${calendarMonths.length}`;

    if (view !== "days" || box === null || scrolledFor.current === target) {
      return;
    }

    scrolledFor.current = target;
    const month = focus.month === null ? null : box.querySelector<HTMLElement>(`[data-month="${focus.month}"]`);

    if (month !== null && focus.month !== currentMonth) {
      const weekdays = box.querySelector<HTMLElement>(".pnl-weekdays")?.offsetHeight ?? 0;
      box.scrollTop = month.offsetTop - weekdays;
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }, [view, focus, calendarMonths.length, currentMonth]);

  // The months open on the chosen year; earlier years are above it and later
  // ones below.
  const yearsScrolledFor = useRef("");
  useLayoutEffect(() => {
    const box = yearsRef.current;
    const target = `${view}|${yearFocus.year}|${yearFocus.request}|${yearList.length}`;

    if (view !== "months" || box === null || yearsScrolledFor.current === target) {
      return;
    }

    yearsScrolledFor.current = target;
    const section = box.querySelector<HTMLElement>(`[data-year="${yearFocus.year}"]`);
    box.scrollTop = section?.offsetTop ?? 0;
  }, [view, yearFocus, yearList.length]);

  function showYear(month: string) {
    setYearFocus((current) => ({ year: Number(month.slice(0, 4)), request: current.request + 1 }));
    setView("months");
  }

  function showDays(month: string | null) {
    setFocus((current) => ({ month, request: current.request + 1 }));
    setView("days");
  }

  return (
    <main className="dash-page hd-page pnl-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href="/stocks" className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            Stocks
          </Link>
          <button type="button" className="pnl-today-button" onClick={() => showDays(null)}>
            Today
          </button>
        </div>

        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry ? staleDataMessage("your daily P&L", entry.fetchedAt) : loadError}
          </p>
        )}

        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}

        {view === "days" ? (
          <section className="dash-hero pnl-hero" aria-labelledby="pnl-heading" aria-busy={isLoading}>
            <div className="dash-hero-top">
              <h1 id="pnl-heading" className="dash-label">
                {monthName(currentMonth)} P&amp;L
              </h1>
              <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
            </div>
            <p className="pnl-hero-figures">
              {data ? (
                thisMonth ? (
                  <>
                    <span className={`dash-hero-value ${tone(thisMonth.pnl)}`}>
                      <HeroAmount value={thisMonth.pnl} signed />
                    </span>
                    <span className={`pnl-hero-rate ${rateTone(thisMonth.rate)}`}>{signedPercent(thisMonth.rate)}</span>
                  </>
                ) : (
                  <span className="dash-hero-value">—</span>
                )
              ) : (
                <Skeleton width="56%" height="36px" />
              )}
            </p>
          </section>
        ) : (
          <>
            <h1 id="pnl-heading" className="sr-only">
              Monthly P&amp;L
            </h1>
            <ul className="pnl-legend" aria-label="Key">
              <li>
                <span className="pnl-mini-day pnl-dot-up" aria-hidden="true">#</span> Up day
              </li>
              <li>
                <span className="pnl-mini-day pnl-dot-down" aria-hidden="true">#</span> Down day
              </li>
              <li>
                <span className="pnl-mini-day" aria-hidden="true">#</span> Market closed
              </li>
            </ul>
          </>
        )}

        {view === "days" ? (
          <div className="dash-card pnl-calendar" ref={scrollRef}>
            <div className="pnl-weekdays" aria-hidden="true">
              {WEEKDAYS.map((name, index) => (
                <span key={index}>{name}</span>
              ))}
            </div>
            {data && data.days.length === 0 && (
              <p className="dash-empty pnl-empty">
                No daily P&amp;L yet. It&apos;s worked out from your brokerage transaction history, so connect a
                brokerage on the Overview page.
              </p>
            )}
            {data && data.days.length > 0 && (
              <p className="pnl-start">
                Your history starts in {monthName(firstMonth)} {firstMonth.slice(0, 4)}.
              </p>
            )}
            {calendarMonths.map((month) => (
              <MonthCalendar
                key={month}
                month={month}
                days={days}
                period={months.get(month)}
                today={today}
                loading={isLoading}
                onOpenYear={() => showYear(month)}
              />
            ))}
            {data && <Footnote data={data} />}
          </div>
        ) : (
          <div className="pnl-years" ref={yearsRef}>
            {yearList.map((year) => {
              const total = years.get(String(year));

              return (
                <section key={year} className="pnl-year-block" data-year={year} aria-labelledby={`pnl-year-${year}`}>
                  <div className="pnl-year-head">
                    <h2 id={`pnl-year-${year}`}>{year}</h2>
                    <p className="pnl-year-return" aria-label={`Return for ${year}`}>
                      {data ? (
                        total ? (
                          <>
                            <b className={rateTone(total.rate)}>{signedPercent(total.rate)}</b>
                            <span className={tone(total.pnl)}>{wholeMoney(total.pnl)}</span>
                          </>
                        ) : (
                          "—"
                        )
                      ) : (
                        <Skeleton width="110px" height="18px" />
                      )}
                    </p>
                  </div>
                  <div className="pnl-year">
                    {Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`).map(
                      (month) => (
                        <MiniMonth
                          key={month}
                          month={month}
                          days={days}
                          period={months.get(month)}
                          today={today}
                          onOpen={() => showDays(month)}
                          disabled={month > currentMonth || month < firstMonth}
                        />
                      ),
                    )}
                  </div>
                </section>
              );
            })}
            <p className="stocks-footnote pnl-tip">Tap a month to see its days.</p>
            {data && <Footnote data={data} />}
          </div>
        )}
      </div>
    </main>
  );
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export default function PnlPage() {
  const { username, onSessionExpired } = useSignedInUser();
  // ?month=YYYY-MM opens the days on that month, e.g. coming back from a
  // day's holdings.
  const month = useSearchParams().get("month");
  const initialMonth = month !== null && MONTH_PATTERN.test(month) ? month : null;

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <PnlView initialMonth={initialMonth} onSessionExpired={onSessionExpired} />;
}
