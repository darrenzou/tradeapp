// Checks the holdings shown for a past day from the P&L calendar: shares
// and cost basis worked back from today, priced at that day's close, with
// day P&L that adds up to the calendar's figure. No network or credentials
// needed.
//
//   node tests/stocks/check-day-holdings.mjs

import assert from "node:assert/strict";
import { register } from "node:module";

// The lib files import each other with the app's "@/" path alias and
// without file extensions, as the Next.js build allows.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith("@/")) {
        return next(new URL(specifier.slice(2) + ".ts", ${JSON.stringify(new URL("../../", import.meta.url).href)}).href, context);
      }
      if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
        return next(specifier + ".ts", context);
      }
      return next(specifier, context);
    }
  `)}`,
);

const { holdingsOnDay } = await import("../../lib/day-holdings.ts");
const { dailyPnl, marketDaysFrom } = await import("../../lib/daily-pnl.ts");

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

const closes = new Map([
  [
    "VTI",
    [
      { date: "2026-09-29", close: 99 },
      { date: "2026-09-30", close: 100 },
      { date: "2026-10-01", close: 102 },
      { date: "2026-10-02", close: 101 },
      { date: "2026-10-05", close: 103 },
    ],
  ],
  [
    "AAPL",
    [
      { date: "2026-09-29", close: 200 },
      { date: "2026-09-30", close: 210 },
      { date: "2026-10-01", close: 205 },
      { date: "2026-10-02", close: 207 },
      { date: "2026-10-05", close: 211 },
    ],
  ],
]);
const account = { id: "a", source: "plaid", name: "Brokerage", institution: "Broker", kind: "investment", balance: 5000, currency: "USD" };
const holding = (key, quantity, costBasis, price) => ({
  accountId: "a",
  key,
  name: key,
  ticker: key,
  securityType: "etf",
  quantity,
  institutionValue: quantity * price,
  institutionPrice: price,
  costBasis,
  isCash: false,
});
const input = {
  accounts: [account],
  // Today: 15 VTI (cost 1,505: 10 at 100 plus 5 bought Oct 1 at 101), no AAPL.
  holdings: [holding("VTI", 15, 1505, 103), { ...holding("CASH", 500, null, 1), ticker: null, isCash: true }],
  holdingsLoaded: new Set(["a"]),
  activities: [
    { accountId: "a", key: "VTI", date: "2026-10-01", shareChange: 5, cashFlow: -505, purchase: true },
    // 4 AAPL sold on Oct 2 at 206.
    { accountId: "a", key: "AAPL", date: "2026-10-02", shareChange: -4, cashFlow: 824 },
    { accountId: "a", key: "VTI", date: "2026-10-03", shareChange: 0, cashFlow: 12 },
  ],
  historyStarts: new Map([["a", "2026-09-29"]]),
  closes,
};

// Sept 30: 10 VTI and 4 AAPL. AAPL's cost isn't known (sold out since).
const sept30 = holdingsOnDay({ ...input, date: "2026-09-30", previousDate: "2026-09-29" });
assert.deepEqual(
  sept30.rows.map((row) => [row.key, row.shares, row.price]),
  [
    ["VTI", 10, 100],
    ["AAPL", 4, 210],
  ],
);
const vti30 = sept30.rows.find((row) => row.key === "VTI");
near(vti30.averagePrice, 100, "VTI average cost on Sept 30");
near(vti30.totalPnl, 0, "VTI total P&L on Sept 30");
near(vti30.dayPnl, 10, "VTI day P&L on Sept 30");
near(sept30.holdingsValue, 1000 + 840, "holdings value");
assert.equal(sept30.cashValue, 0);
near(sept30.rows[1].portfolioPercent, 840 / 1840, "% of portfolio counts holdings only");

// Oct 2: AAPL sold that day still shows (0 shares) for its day P&L.
const oct2 = holdingsOnDay({ ...input, date: "2026-10-02", previousDate: "2026-10-01" });
const aapl2 = oct2.rows.find((row) => row.key === "AAPL");
assert.equal(aapl2.shares, 0);
// Sold at 824, worth 4 × 205 = 820 the day before.
near(aapl2.dayPnl, 4, "AAPL day P&L on the day it was sold");

// Each day's rows add up to the calendar's figure for that day.
const positions = [
  { accountId: "a", key: "VTI", ticker: "VTI", quantity: 15, currentValue: 15 * 103 },
  { accountId: "a", key: "AAPL", ticker: "AAPL", quantity: 0, currentValue: 0 },
];
const calendar = dailyPnl({
  positions,
  activities: input.activities,
  historyStarts: input.historyStarts,
  closes,
  marketDays: marketDaysFrom(closes, "2026-10-05"),
  today: "2026-10-05",
});
const days = marketDaysFrom(closes, "2026-10-05");

for (const day of calendar.days) {
  const previousDate = days[days.indexOf(day.date) - 1];
  const result = holdingsOnDay({ ...input, date: day.date, previousDate });
  near(result.dayPnl, day.pnl, `day P&L on ${day.date}`);
  near(result.dayPnlPercent, day.rate, `day return on ${day.date}`);
}

console.log("Day holdings checks passed.");
