"use client";

import Link from "next/link";

import { compactMoney, monthLabel, signedMoney, tone } from "./spending-format";
import type { MonthAppreciation } from "@/lib/appreciation";
import type { MonthTotals } from "@/lib/cashflow";

type MonthListProps = {
  year: number;
  // The page's months (any years); the ones in `year` are listed.
  months: MonthTotals[];
  appreciation: MonthAppreciation[];
  // First month with bank transactions, if any.
  firstDataMonth: string | null;
};

function monthOnly(month: string): string {
  return monthLabel(month).split(" ")[0];
}

// One card per month of the year, newest first, with its net gain and what
// made it up. Each card opens that month's page.
export default function MonthList({ year, months, appreciation, firstDataMonth }: MonthListProps) {
  const stocksByMonth = new Map(appreciation.map((entry) => [entry.month, entry]));
  const rows = months.filter((totals) => totals.month.startsWith(`${year}-`)).reverse();

  return (
    <section className="spend-months" aria-labelledby="month-list-heading">
      <h2 id="month-list-heading" className="dash-label spend-months-heading">Months in {year}</h2>
      <ul>
        {rows.map((totals) => {
          const hasData = firstDataMonth !== null && totals.month >= firstDataMonth;
          const stocks = stocksByMonth.get(totals.month);
          const stockAmount = stocks?.amount ?? null;
          const moneyIn = totals.income + totals.other;
          // Stock gains show under the net gain but aren't part of it.
          const net = moneyIn + totals.dividends - totals.spending;

          if (!hasData) {
            return (
              <li key={totals.month} className="spend-month-row spend-month-empty">
                <span className="spend-month-name">{monthOnly(totals.month)}</span>
                <span className="spend-month-net">No bank data</span>
              </li>
            );
          }

          return (
            <li key={totals.month}>
              <Link
                href={`/spending/${totals.month}`}
                className="spend-month-row"
                aria-label={`${monthLabel(totals.month)}: net ${signedMoney(net)}. Open transactions`}
              >
                <span className="spend-month-name">{monthOnly(totals.month)}</span>
                <span className={`spend-month-net ${tone(net)}`}>
                  {signedMoney(net)} <span className="spend-month-chevron" aria-hidden="true">›</span>
                </span>
                <span className="spend-month-parts" aria-hidden="true">
                  <span>In {compactMoney(moneyIn)}</span>
                  <span>Div {compactMoney(totals.dividends)}</span>
                  <span className={tone(stockAmount)} title={stocks?.note ?? undefined}>
                    Stocks {stockAmount === null ? "—" : `${stockAmount > 0 ? "+" : ""}${compactMoney(stockAmount)}`}
                  </span>
                  <span>Spent {compactMoney(totals.spending)}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
