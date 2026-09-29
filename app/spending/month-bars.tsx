"use client";

import Link from "next/link";

import { formatMoney } from "../client-api";
import { compactMoney, monthLabel, monthName } from "./spending-format";
import type { MonthTotals } from "@/lib/cashflow";

type MonthBarsProps = {
  year: number;
  // The page's months (any years); the ones in `year` are drawn.
  months: MonthTotals[];
  // First month with transactions, if any.
  firstDataMonth: string | null;
};

// Rounds up to 1, 2, 2.5, or 5 × a power of ten, for the axis top.
function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }

  const power = 10 ** Math.floor(Math.log10(value));

  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * power) {
      return step * power;
    }
  }

  return 10 * power;
}

// Monthly spending for one year, one bar per month. Each bar opens that
// month's transactions.
export default function MonthBars({ year, months, firstDataMonth }: MonthBarsProps) {
  const byMonth = new Map(months.map((totals) => [totals.month, totals]));
  const slots = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, "0")}`;
    const totals = byMonth.get(month);
    const hasData = totals !== undefined && firstDataMonth !== null && month >= firstDataMonth;
    return { month, spending: hasData ? Math.max(0, totals.spending) : null, available: totals !== undefined };
  });
  const values = slots.flatMap((slot) => slot.spending ?? []);
  const largest = Math.max(0, ...values);
  const top = niceCeiling(largest);
  const ticks = [top, top / 2, 0];
  const highlighted = values.length > 0 ? slots.findIndex((slot) => slot.spending === largest) : -1;
  const total = values.reduce((sum, value) => sum + value, 0);

  return (
    <section className="dash-card spend-chart-card" aria-labelledby="month-bars-heading">
      <div className="dash-card-header">
        <h2 id="month-bars-heading" className="dash-label">Spent each month in {year}</h2>
        <p className="dash-card-caption">{values.length > 0 ? `${formatMoney(total)} total · select a month` : ""}</p>
      </div>

      {values.length === 0 ? (
        <p className="dash-empty">No spending data from Plaid for {year}.</p>
      ) : (
        <div className="spend-chart">
          <div className="spend-chart-axis" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick}>{compactMoney(tick)}</span>
            ))}
          </div>
          <div className="spend-chart-plot">
            <div className="spend-chart-grid" aria-hidden="true">
              {ticks.map((tick) => (
                <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }} />
              ))}
            </div>
            <ol className="spend-chart-slots">
            {slots.map((slot, index) => {
              const height = slot.spending === null ? 0 : (slot.spending / top) * 100;
              const label = `${monthLabel(slot.month)}: ${
                slot.spending === null ? "no data" : `${formatMoney(slot.spending)} spent`
              }`;

              return (
                <li key={slot.month} className="spend-chart-slot">
                  {slot.spending !== null ? (
                    <Link
                      href={`/spending/${slot.month}`}
                      className="spend-chart-bar-hit"
                      aria-label={`${label}. Open transactions`}
                    >
                      <span className="spend-chart-tip" aria-hidden="true">
                        <strong>{monthLabel(slot.month, "short")}</strong> {formatMoney(slot.spending)}
                      </span>
                      {index === highlighted && (
                        <span className="spend-chart-value" style={{ bottom: `${height}%` }} aria-hidden="true">
                          {compactMoney(slot.spending)}
                        </span>
                      )}
                      <span className="spend-chart-bar" style={{ height: `${Math.max(height, 0.5)}%` }} />
                    </Link>
                  ) : (
                    <span className="spend-chart-empty" title={slot.available ? "No data from Plaid" : undefined}>
                      <span className="stocks-sr-only">{label}</span>
                    </span>
                  )}
                  <span className="spend-chart-label" aria-hidden="true">
                    <span className="spend-chart-label-long">{monthName(slot.month)}</span>
                    <span className="spend-chart-label-short">{monthName(slot.month).charAt(0)}</span>
                  </span>
                </li>
              );
            })}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
