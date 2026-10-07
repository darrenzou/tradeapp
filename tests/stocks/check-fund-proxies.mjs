// Checks that 401(k) and mutual funds tracking the S&P 500 are priced from
// the index's daily moves on the P&L calendar and a day's holdings. No
// network or credentials needed.
//
//   node tests/stocks/check-fund-proxies.mjs

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

const { fundIndexes, indexProxy, priceFundsByIndex, proxySeries } = await import("../../lib/fund-proxies.ts");
const { dailyPnl, marketDaysFrom } = await import("../../lib/daily-pnl.ts");
const { holdingsOnDay } = await import("../../lib/day-holdings.ts");

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);
const fund = (name, ticker = null) => ({ name, ticker, securityType: "mutual fund" });

// Which funds count as tracking the S&P 500.
for (const name of [
  "S&P 500 Index Fund",
  "BlackRock S&P 500 Index Non-Lendable Fund M",
  "STATE STREET S&P500 INDEX SL SERIES CL K",
  "Vanguard Institutional 500 Index Trust (S & P 500)",
  "SP 500 INDEX FUND",
]) {
  assert.equal(indexProxy(fund(name)), "SPY", name);
}
assert.equal(indexProxy(fund("Fidelity 500 Index Fund", "FXAIX")), "SPY", "S&P 500 fund by ticker");
for (const name of [
  "Russell 2500 Index Fund",
  "S&P 500 Equal Weight Index",
  "S&P 500 Growth Index Fund",
  "Extended Market Index (ex S&P 500)",
  "Target Retirement 2055 Trust",
  "Stable Value Fund",
]) {
  assert.equal(indexProxy(fund(name)), null, name);
}

// A 401(k) S&P 500 fund (20 units at $50 today) and a stable value fund,
// neither with market prices.
const spy = [
  { date: "2026-09-29", close: 600 },
  { date: "2026-09-30", close: 606 },
  { date: "2026-10-01", close: 597.91 },
  { date: "2026-10-02", close: 600 },
  { date: "2026-10-05", close: 612 },
];
const positions = [
  { accountId: "k", key: "S&P 500 Index Fund", ticker: null, quantity: 20, currentValue: 1000 },
  { accountId: "k", key: "Stable Value Fund", ticker: null, quantity: 100, currentValue: 100 },
];
const securities = new Map([
  ["S&P 500 Index Fund", fund("S&P 500 Index Fund")],
  ["Stable Value Fund", fund("Stable Value Fund")],
]);
const indexes = fundIndexes(positions, securities);
assert.deepEqual([...indexes], [["S&P 500 Index Fund", "SPY"]]);

// The fund's $50 is the close before today (Oct 2, SPY 600): 1/12 of SPY.
const priced = priceFundsByIndex(positions, indexes, new Map([["SPY", spy]]), "2026-10-05");
const series = proxySeries("S&P 500 Index Fund");
assert.deepEqual([...priced.funds], ["S&P 500 Index Fund"]);
assert.equal(priced.positions[0].ticker, series);
assert.equal(priced.positions[1].ticker, null);
near(priced.closes.get(series).find((close) => close.date === "2026-09-30").close, 50.5, "scaled close");

// The calendar: the fund moves with SPY, 20 units × the scaled change.
const historyStarts = new Map([["k", "2026-09-29"]]);
const activities = [
  // 2 units bought Oct 1 at the scaled close.
  { accountId: "k", key: "S&P 500 Index Fund", date: "2026-10-01", shareChange: 2, cashFlow: -2 * (597.91 / 12), purchase: true },
];
const withPurchase = priceFundsByIndex(
  [{ ...positions[0], quantity: 22, currentValue: 1100 }, positions[1]],
  indexes,
  new Map([["SPY", spy]]),
  "2026-10-05",
);
const calendarCloses = new Map([["SPY", spy], ...withPurchase.closes]);
const marketDays = marketDaysFrom(calendarCloses, "2026-10-05");
const calendar = dailyPnl({
  positions: withPurchase.positions,
  activities,
  historyStarts,
  closes: calendarCloses,
  marketDays,
  today: "2026-10-05",
});
assert.equal(calendar.missing, 1, "the stable value fund still has no prices");
const sept30 = calendar.days.find((day) => day.date === "2026-09-30");
near(sept30.pnl, Math.round(20 * (606 - 600) / 12 * 100) / 100, "fund P&L on Sept 30");
near(sept30.rate, 0.01, "fund return matches SPY's");

// A day's holdings: the fund shows with its own name, priced from SPY, and
// its day P&L adds up to the calendar's.
const holdings = [
  {
    accountId: "k",
    key: "S&P 500 Index Fund",
    name: "S&P 500 Index Fund",
    ticker: null,
    securityType: "mutual fund",
    quantity: 22,
    institutionValue: 1100,
    institutionPrice: 50,
    costBasis: 1000,
    isCash: false,
  },
];
const input = {
  accounts: [{ id: "k", source: "plaid", name: "401(k)", institution: "Plan", kind: "investment", balance: 1100, currency: "USD" }],
  holdings,
  holdingsLoaded: new Set(["k"]),
  activities,
  historyStarts,
  closes: calendarCloses,
  indexed: withPurchase.funds,
};
const day = holdingsOnDay({ ...input, date: "2026-09-30", previousDate: "2026-09-29" });
assert.equal(day.indexed, 1);
assert.equal(day.missing, 0);
const row = day.rows[0];
assert.equal(row.ticker, null);
assert.equal(row.name, "S&P 500 Index Fund");
assert.equal(row.shares, 20);
near(row.price, 50.5, "fund price on Sept 30");
near(row.dayChangePercent, 0.01, "fund day change");

// Past days only: today opens the Stocks page.
for (const calendarDay of calendar.days.filter((item) => item.date < "2026-10-05")) {
  const previousDate = marketDays[marketDays.indexOf(calendarDay.date) - 1];
  const result = holdingsOnDay({ ...input, date: calendarDay.date, previousDate });
  // The calendar rounds to cents.
  assert.ok(Math.abs(result.dayPnl - calendarDay.pnl) < 0.006, `day P&L on ${calendarDay.date}`);
}

console.log("Fund proxy checks passed.");
