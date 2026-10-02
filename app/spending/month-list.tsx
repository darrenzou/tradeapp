"use client";

import Link from "next/link";

import { formatMoney } from "../client-api";
import { Skeleton } from "../theme-ui";
import { monthLabel, signedMoney, wholeMoney } from "./spending-format";

export type MonthFlow = {
  // YYYY-MM
  month: string;
  // Paychecks and every other income except interest and dividends.
  pay: number;
  // Interest and dividends.
  interest: number;
  spending: number;
};

type MonthListProps = {
  year: number;
  // The year's months with bank data, oldest first.
  months: MonthFlow[];
};

function monthOnly(month: string): string {
  return monthLabel(month).split(" ")[0];
}

function percent(value: number, scale: number): string {
  return `${scale > 0 ? (value / scale) * 100 : 0}%`;
}

// One row per month, newest first: a bar of the month's income (pay, then
// interest and dividends) with its spending hatched over it from the left,
// and any spending past the income in red. Each row opens that month's page.
export default function MonthList({ year, months }: MonthListProps) {
  const rows = [...months].reverse();
  const scale = Math.max(0, ...months.map((row) => Math.max(row.pay + row.interest, row.spending)));
  const nets = months.map((row) => row.pay + row.interest - row.spending);
  const average = nets.length > 0 ? nets.reduce((total, net) => total + net, 0) / nets.length : 0;

  return (
    <section className="dash-card sp-months-card" aria-labelledby="month-list-heading">
      <div className="dash-card-header">
        <h2 id="month-list-heading" className="sp-card-title">Months in {year}</h2>
        {months.length > 0 && (
          <span className="sp-card-total">Avg. {signedMoney(Math.round(average)).replace(".00", "")}</span>
        )}
      </div>

      {months.length === 0 ? (
        <p className="dash-empty">No bank data for {year}.</p>
      ) : (
        <>
          <ul className="sp-legend" aria-label="Key">
            <li><span className="sp-key sp-key-pay" />Non-interest income</li>
            <li><span className="sp-key sp-key-interest" />Interest &amp; dividends</li>
            <li><span className="sp-key sp-key-line" />Total income</li>
            <li><span className="sp-key sp-key-spent" />Spending</li>
            <li><span className="sp-key sp-key-over" />Spent over income</li>
          </ul>

          <ul className="sp-month-rows">
            {rows.map((row) => {
              const income = row.pay + row.interest;
              const net = income - row.spending;
              const over = Math.max(0, row.spending - income);

              return (
                <li key={row.month}>
                  <Link
                    href={`/spending/${row.month}`}
                    className="sp-month-row"
                    aria-label={`${monthLabel(row.month)}: ${net >= 0 ? `saved ${formatMoney(net)}` : `${formatMoney(-net)} over income`}. Income ${formatMoney(income)}, spent ${formatMoney(row.spending)}. Open the month`}
                  >
                    <span className="sp-month-name">{monthOnly(row.month)}</span>
                    <span className={`sp-month-net ${net < 0 ? "sp-over" : ""}`}>
                      <span className="sp-month-net-value">{signedMoney(Math.round(net)).replace(".00", "")}</span>
                      <span className="sp-month-net-label">{net < 0 ? "over income" : "saved"}</span>
                    </span>
                    <span className="sp-flow" style={{ width: percent(Math.max(income, row.spending), scale) }} aria-hidden="true">
                      <span className="sp-flow-income" style={{ width: percent(income, Math.max(income, row.spending)) }}>
                        <span className="sp-flow-pay" style={{ flexGrow: row.pay }} />
                        {row.interest > 0 && <span className="sp-flow-interest" style={{ flexGrow: row.interest }} />}
                      </span>
                      <span className="sp-flow-spent" style={{ width: percent(Math.min(row.spending, income), Math.max(income, row.spending)) }} />
                      {over > 0 && (
                        <span
                          className="sp-flow-over"
                          style={{ left: percent(income, row.spending), width: percent(over, row.spending) }}
                        />
                      )}
                      {income > 0 && (
                        <span className="sp-flow-line" style={{ left: percent(income, Math.max(income, row.spending)) }} />
                      )}
                    </span>
                    <span className="sp-month-parts" aria-hidden="true">
                      <span><span className="sp-dot sp-key-pay" />Pay <b>{wholeMoney(row.pay)}</b></span>
                      <span><span className="sp-dot sp-key-interest" />Int <b>{wholeMoney(row.interest)}</b></span>
                      <span><span className="sp-dot sp-key-spent" />Spent <b>{wholeMoney(row.spending)}</b></span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// Grey rows in the shape of the month list while the year loads.
export function MonthListLoading() {
  return (
    <section className="dash-card sp-months-card" aria-hidden="true">
      <div className="dash-card-header">
        <Skeleton width="45%" height="22px" />
        <Skeleton width="25%" height="16px" />
      </div>
      <ul className="sp-month-rows">
        {[0.62, 0.85, 0.7, 0.66].map((width, index) => (
          <li key={index} className="sp-month-row">
            <Skeleton width="30%" height="14px" />
            <span className="sp-month-net">
              <Skeleton width="100%" height="14px" />
            </span>
            <Skeleton width={`${width * 100}%`} height="20px" />
            <span className="sp-month-parts">
              <Skeleton width="60%" height="10px" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
