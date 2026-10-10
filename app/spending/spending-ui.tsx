"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { formatMoney } from "../client-api";
import { Icon } from "../theme-ui";
import { REST_COLOR, monthLabel, monthName } from "./spending-format";

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

export type PeriodMonth = {
  // YYYY-MM
  month: string;
  // Months before the bank history starts have nothing to show.
  hasData: boolean;
};

// The year menu and a row of the year's months, newest on the right, that
// swipes sideways for earlier ones. On the yearly page no month is selected;
// on a month page that month is.
export function PeriodBar({
  years,
  year,
  months,
  selectedMonth,
  onSelectYear,
}: {
  years: number[];
  year: number;
  months: PeriodMonth[];
  selectedMonth: string | null;
  // On the yearly page picking a year stays on the page; elsewhere the menu
  // links to the yearly page for that year.
  onSelectYear?: (year: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedMonth]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function close(event: PointerEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  return (
    <nav className="sp-period" aria-label="Period">
      <div className="sp-year" ref={menuRef}>
        <button
          type="button"
          className={`sp-year-button ${selectedMonth === null ? "sp-year-current" : ""}`}
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          aria-label={`${year}, choose a year`}
        >
          {year}
          <Icon name="chevronDown" size={12} strokeWidth={3} />
        </button>
        {menuOpen && (
          <ul className="sp-year-menu">
            {[...years].reverse().map((option) => (
              <li key={option}>
                {onSelectYear ? (
                  <button
                    type="button"
                    aria-current={option === year ? "true" : undefined}
                    onClick={() => {
                      setMenuOpen(false);
                      onSelectYear(option);
                    }}
                  >
                    {option}
                  </button>
                ) : (
                  <Link href={`/spending?year=${option}`} aria-current={option === year ? "true" : undefined}>
                    {option}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="sp-period-rule" aria-hidden="true" />
      <div className="sp-months-wrap">
        <ul className="sp-months" aria-label={`Months of ${year}, swipe for earlier`}>
          {[...months].reverse().map(({ month, hasData }) => (
            <li key={month}>
              {hasData ? (
                <Link
                  href={`/spending/${month}`}
                  ref={month === selectedMonth ? selectedRef : undefined}
                  className={month === selectedMonth ? "sp-month sp-month-selected" : "sp-month"}
                  aria-current={month === selectedMonth ? "page" : undefined}
                  aria-label={monthLabel(month)}
                >
                  {monthName(month)}
                </Link>
              ) : (
                <span className="sp-month sp-month-empty" title={`No bank data for ${monthLabel(month)}`}>
                  {monthName(month)}
                </span>
              )}
            </li>
          ))}
        </ul>
        <span className="sp-months-fade" aria-hidden="true" />
      </div>
    </nav>
  );
}

// The Income and Spent tiles under a headline.
export function SummaryTiles({
  income,
  incomeNote,
  spent,
  spentNote,
}: {
  income: ReactNode;
  incomeNote: ReactNode;
  spent: ReactNode;
  spentNote: ReactNode;
}) {
  return (
    <div className="sp-tiles">
      <div className="sp-tile sp-tile-in">
        <span className="sp-tile-label">
          <Icon name="arrowUp" size={14} strokeWidth={2.6} />
          Income
        </span>
        <span className="sp-tile-value">{income}</span>
        <span className="sp-tile-note">{incomeNote}</span>
      </div>
      <div className="sp-tile sp-tile-out">
        <span className="sp-tile-label">
          <Icon name="arrowDown" size={14} strokeWidth={2.6} />
          Spent
        </span>
        <span className="sp-tile-value">{spent}</span>
        <span className="sp-tile-note">{spentNote}</span>
      </div>
    </div>
  );
}

// A big section title on the grey, with a colored rule above it and the
// section's total on the right.
export function SectionHeading({
  id,
  title,
  total,
  tone,
}: {
  id: string;
  title: string;
  total: string;
  tone: "spending" | "income";
}) {
  return (
    <div className={`sp-heading sp-heading-${tone}`}>
      <span className="sp-heading-title">
        <span className="sp-heading-rule" aria-hidden="true" />
        <h2 id={id}>{title}</h2>
      </span>
      <span className="sp-heading-total">{total}</span>
    </div>
  );
}

export type CategoryShare = { name: string; amount: number; color: string };

// Colors categories by rank; with `limit`, the smallest are folded into one
// "Other categories" row.
export function rankCategories(
  categories: [string, number][],
  palette: string[],
  limit?: number,
): CategoryShare[] {
  const positive = categories.filter(([, amount]) => amount > 0);
  const shown = limit !== undefined && positive.length > limit + 1 ? positive.slice(0, limit) : positive;
  const rest = positive.slice(shown.length).reduce((total, [, amount]) => total + amount, 0);
  const shares = shown.map(([name, amount], index) => ({ name, amount, color: palette[index] ?? REST_COLOR }));

  return rest > 0 ? [...shares, { name: "Other categories", amount: rest, color: REST_COLOR }] : shares;
}

// A stacked bar of every category (unless `stacked` is false), then one row
// per category with its own bar scaled to the largest. Rows open `onSelect`
// when given.
export function CategoryBreakdown({
  shares,
  total,
  onSelect,
  stacked = true,
}: {
  shares: CategoryShare[];
  total: number;
  onSelect?: (name: string) => void;
  stacked?: boolean;
}) {
  const largest = Math.max(0, ...shares.map((share) => share.amount));

  return (
    <>
      {stacked && (
        <div
          className="sp-stack"
          role="img"
          aria-label={`Spending by category: ${shares
            .map((share) => `${share.name} ${total > 0 ? percentFormatter.format(share.amount / total) : ""}`)
            .join(", ")}`}
        >
          {shares.map((share) => (
            <span key={share.name} style={{ flexGrow: share.amount, background: share.color }} />
          ))}
        </div>
      )}
      <ul className="sp-bars">
        {shares.map((share) => {
          const clickable = onSelect !== undefined && share.name !== "Other categories";
          const content = (
            <>
              <span className="sp-bar-head">
                <span className="sp-swatch" style={{ background: share.color }} aria-hidden="true" />
                <span className="sp-bar-name">{share.name}</span>
                <span className="sp-bar-amount">{formatMoney(share.amount)}</span>
                <span className="sp-bar-share">{total > 0 ? percentFormatter.format(share.amount / total) : ""}</span>
                {onSelect && (
                  <span className="sp-bar-chevron" aria-hidden="true">
                    {clickable && <Icon name="chevronRight" size={16} strokeWidth={2.4} />}
                  </span>
                )}
              </span>
              <span className="sp-bar-track" aria-hidden="true">
                <span
                  className="sp-bar-fill"
                  style={{ width: largest > 0 ? `${(share.amount / largest) * 100}%` : "0%", background: share.color }}
                />
              </span>
            </>
          );

          return (
            <li key={share.name}>
              {clickable ? (
                <button type="button" className="sp-bar" onClick={() => onSelect(share.name)}>
                  {content}
                </button>
              ) : (
                <div className="sp-bar">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// "Mar – Sep": the months a year's figures cover.
export function coveredRange(months: string[]): string {
  if (months.length === 0) {
    return "";
  }

  const first = monthName(months[0]);
  const last = monthName(months.at(-1)!);
  return first === last ? first : `${first} – ${last}`;
}
