// Checks the P&L calendar's daily figures: change in value from the previous
// close, with purchases, sales and dividends that day, and months and years
// that chain the daily returns. No network or credentials needed.
//
//   node tests/stocks/check-daily-pnl.mjs

import assert from "node:assert/strict";

import { dailyPnl, marketDaysFrom } from "../../lib/daily-pnl.ts";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

const today = "2026-10-06";
const closes = new Map([
  [
    "VTI",
    [
      { date: "2026-09-28", close: 98 },
      { date: "2026-09-29", close: 99 },
      { date: "2026-09-30", close: 100 },
      { date: "2026-10-01", close: 102 },
      { date: "2026-10-02", close: 101 },
      { date: "2026-10-05", close: 103 },
      { date: "2026-10-06", close: 104 },
    ],
  ],
  [
    "SPY",
    [
      { date: "2026-09-29", close: 600 },
      { date: "2026-09-30", close: 600 },
      { date: "2026-10-01", close: 600 },
      { date: "2026-10-02", close: 600 },
      { date: "2026-10-05", close: 600 },
      { date: "2026-10-06", close: 600 },
    ],
  ],
]);
const marketDays = marketDaysFrom(closes, today);
assert.deepEqual(marketDays, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]);

const input = {
  positions: [
    // 15 shares now: 5 bought on Oct 1 at 101, worth 105 each live today.
    { accountId: "a", key: "VTI", ticker: "VTI", quantity: 15, currentValue: 15 * 105 },
    // A fund without market prices can't be valued.
    { accountId: "a", key: "Plan fund", ticker: null, quantity: 3, currentValue: 300 },
  ],
  activities: [
    { accountId: "a", key: "VTI", date: "2026-10-01", shareChange: 5, cashFlow: -505, purchase: true },
    // A dividend on Saturday counts on Monday.
    { accountId: "a", key: "VTI", date: "2026-10-03", shareChange: 0, cashFlow: 12 },
  ],
  historyStarts: new Map([["a", "2026-09-30"]]),
  closes,
  marketDays,
  today,
};

const result = dailyPnl(input);
assert.equal(result.missing, 1);
assert.equal(result.partial, false);
// The history starts on the 30th, so shares are known from the 29th's close
// on: the 30th is the first day with a figure.
assert.deepEqual(
  result.days.map((day) => day.date),
  ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"],
);
const byDate = Object.fromEntries(result.days.map((day) => [day.date, day]));
// Sept 30: 10 × (100 − 99) = 10.
near(byDate["2026-09-30"].pnl, 10, "Sept 30 P&L");
// Oct 1: 10 × (102 − 100) + 5 × 102 − 505 = 20 + 5 = 25.
near(byDate["2026-10-01"].pnl, 25, "Oct 1 P&L");
near(byDate["2026-10-01"].rate, 25 / (1000 + 505), "Oct 1 rate");
// Oct 2: 15 × (101 − 102) = −15.
near(byDate["2026-10-02"].pnl, -15, "Oct 2 P&L");
// Oct 5: 15 × 2 + 12 dividend = 42.
near(byDate["2026-10-05"].pnl, 42, "Oct 5 P&L");
// Today uses the live value: 15 × (105 − 103) = 30.
near(byDate["2026-10-06"].pnl, 30, "Oct 6 P&L");

const october = result.months.find((month) => month.key === "2026-10");
near(october.pnl, 25 - 15 + 42 + 30, "October P&L");
assert.equal(october.days, 4);
const chained = [25 / 1505, -15 / 1530, 42 / 1515, 30 / 1545].reduce((growth, rate) => growth * (1 + rate), 1) - 1;
near(october.rate, chained, "October return");
assert.deepEqual(
  result.months.map((month) => [month.key, month.pnl, month.days]),
  [
    ["2026-09", 10, 1],
    ["2026-10", 82, 4],
  ],
);
assert.equal(result.years.length, 1);
near(result.years[0].pnl, 92, "2026 P&L");
assert.equal(result.years[0].key, "2026");

// Days before anything was held aren't shown.
const later = dailyPnl({
  ...input,
  positions: [{ accountId: "a", key: "NEW", ticker: "VTI", quantity: 2, currentValue: 210 }],
  activities: [{ accountId: "a", key: "NEW", date: "2026-10-05", shareChange: 2, cashFlow: -206, purchase: true }],
  historyStarts: new Map([["a", "2026-01-01"]]),
});
assert.deepEqual(
  later.days.map((day) => [day.date, day.pnl]),
  [
    ["2026-10-05", 0],
    ["2026-10-06", 4],
  ],
);

console.log("Daily P&L checks passed.");
