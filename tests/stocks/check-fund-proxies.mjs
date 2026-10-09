// Checks that 401(k) and mutual funds tracking an index (the S&P 500, the
// Nasdaq, international...) are priced from the index's daily moves on the P&L calendar and a day's holdings. No
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

const { fundIndexes, fundQuote, indexProxy, priceBeforeToday, priceFundsByIndex, proxyCloses, proxyParts, proxySeries } = await import(
  "../../lib/fund-proxies.ts"
);
const { fundQuoteKey, holdingQuote, liveAdjustments } = await import("../../lib/live-valuation.ts");
const { dailyPnl, marketDaysFrom } = await import("../../lib/daily-pnl.ts");
const { holdingsOnDay } = await import("../../lib/day-holdings.ts");

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);
const fund = (name, ticker = null) => ({ name, ticker, securityType: "mutual fund" });

// Which index each fund tracks, by the ETF that prices it.
const expected = [
  ["S&P 500 Index Fund", "SPY"],
  ["BlackRock S&P 500 Index Non-Lendable Fund M", "SPY"],
  ["STATE STREET S&P500 INDEX SL SERIES CL K", "SPY"],
  ["Vanguard Institutional 500 Index Trust (S & P 500)", "SPY"],
  ["SP 500 INDEX FUND", "SPY"],
  ["S&P 500 Growth Index Fund", "IVW"],
  ["Extended Market Index (ex S&P 500)", "VXF"],
  ["Russell 2000 Index Fund", "IWM"],
  ["Russell 1000 Growth Index Fund", "IWF"],
  ["S&P MidCap 400 Index", "IJH"],
  ["Nasdaq-100 Index Fund", "QQQ"],
  ["NASDAQ 100 INDEX NL", "QQQ"],
  ["Nasdaq Composite Index Fund", "ONEQ"],
  ["Dow Jones Industrial Average Index", "DIA"],
  ["Total International Stock Index Trust", "VXUS"],
  ["BlackRock ACWI ex US IMI Index Fund", "VXUS"],
  ["MSCI ACWI ex-U.S. Index", "VXUS"],
  ["BlackRock MSCI EAFE Equity Index Fund M", "EFA"],
  ["Emerging Markets Index Fund", "VWO"],
  ["Vanguard Total Stock Market Index Trust", "VTI"],
  ["Dow Jones U.S. Total Stock Market Index", "VTI"],
  ["Russell 3000 Index", "VTI"],
  ["U.S. Aggregate Bond Index Fund", "BND"],
  ["Total Bond Market Index Trust", "BND"],
  ["Total International Bond Index", "BNDX"],
  ["Dow Jones U.S. Select REIT Index", "VNQ"],
  // As 401(k) plans abbreviate them.
  ["VANGUARD INSTL TTL INTL STOCK", "VXUS"],
  ["VANGUARD INSTL 500 INDEX TR", "SPY"],
  ["VANGUARD INSTL TTL STK MKT", "VTI"],
  // Not index funds, or not an index an ETF here tracks.
  ["Russell 2500 Index Fund", null],
  ["S&P 500 Equal Weight Index", null],
  ["Schwab 1000 Index Fund", "SCHK"],
  // Target-date funds, by a mix of ETFs.
  ["Vanguard Target Retirement 2055 Trust", "target-2055"],
  ["Fidelity Freedom Index 2055 Fund Investor Class", "target-2055"],
  ["Schwab Target 2055 Index Fund", "target-2055"],
  ["BlackRock LifePath Index 2040 Fund K", "target-2040"],
  ["VANGUARD TRGT RET 2030 TR", "target-2030"],
  ["Stable Value Fund", null],
  ["Target Retirement Income Fund", null],
  ["Emerging Markets Opportunities Fund", null],
  ["Short-Term Bond Index", null],
  ["Large Cap Growth Fund", null],
];

for (const [name, symbol] of expected) {
  assert.equal(indexProxy(fund(name)), symbol, name);
}
assert.equal(indexProxy(fund("Fidelity 500 Index Fund", "FXAIX")), "SPY", "S&P 500 fund by ticker");
assert.equal(indexProxy(fund("Vanguard Total Intl Stock Index Admiral", "VTIAX")), "VXUS", "VXUS fund by ticker");
assert.equal(indexProxy(fund("Schwab 1000 Index Fund", "SNXFX")), "SCHK", "SNXFX");
assert.equal(indexProxy(fund("Fidelity ZERO Total Market Index Fund", "FZROX")), "VTI", "FZROX");
assert.equal(indexProxy(fund("Unnamed", "SWYJX")), "target-2055", "SWYJX by ticker");
assert.equal(indexProxy(fund("Unnamed", "FDEWX")), "target-2055", "FDEWX by ticker");

// A 2055 fund in 2026 is 90% stocks (62% of them US), 10% bonds; a fund at
// its target year is half stocks; long after, 30%.
const weights = (proxy, year) => Object.fromEntries(proxyParts(proxy, year).map((part) => [part.symbol, part.weight]));
const far = weights("target-2055", 2026);
near(far.VTI, 0.9 * 0.62, "2055 US stocks");
near(far.VXUS, 0.9 * 0.38, "2055 international");
near(far.BND, 0.1, "2055 bonds");
near(weights("target-2026", 2026).BND, 0.5, "at the target year");
near(weights("target-2010", 2026).BND, 0.7, "long after");
assert.deepEqual(proxyParts("SPY", 2026), [{ symbol: "SPY", weight: 1 }]);

// The mix moves by its ETFs' weighted returns, on days all have closes.
const mixed = proxyCloses(
  ["target-2055", "SPY", "target-2055"],
  new Map([
    ["VTI", [{ date: "2026-10-01", close: 300 }, { date: "2026-10-02", close: 303 }, { date: "2026-10-05", close: 300 }]],
    ["VXUS", [{ date: "2026-10-01", close: 70 }, { date: "2026-10-02", close: 70 }, { date: "2026-10-05", close: 71.4 }]],
    ["BND", [{ date: "2026-10-01", close: 72 }, { date: "2026-10-02", close: 72 }]],
    ["SPY", [{ date: "2026-10-01", close: 600 }]],
  ]),
  2026,
);
assert.deepEqual(mixed.get("SPY"), [{ date: "2026-10-01", close: 600 }]);
assert.deepEqual(mixed.get("target-2055").map((close) => close.date), ["2026-10-01", "2026-10-02"], "Oct 5 has no BND close");
near(mixed.get("target-2055")[1].close, 100 * (1 + far.VTI * 0.01), "Oct 2: US stocks up 1%");
assert.equal(indexProxy(fund("Vanguard Instl Total Intl Stock Market Index Trust", "VGIST")), "VXUS", "VGIST");
assert.equal(indexProxy(fund("Unnamed", "VGIST")), "VXUS", "VGIST by its plan code alone");

// Today's estimate: Thursday Oct 8 at 2pm New York, SPY up 1% and the fund
// last reported at Wednesday's $50.
const etfQuotes = new Map([
  ["SPY", { price: 606, previousClose: 600, asOf: "2026-10-08T18:00:00Z" }],
  ["VTI", { price: 303, previousClose: 300, asOf: "2026-10-08T18:00:00Z" }],
  ["VXUS", { price: 69.3, previousClose: 70, asOf: "2026-10-08T18:00:01Z" }],
  ["BND", { price: 72, previousClose: 72, asOf: "2026-10-08T17:59:00Z" }],
]);
const during = fundQuote(50, "SPY", etfQuotes, "2026-10-08");
near(during.price, 50.5, "moves with SPY");
assert.equal(during.previousClose, 50);
assert.equal(during.asOf, "2026-10-08T18:00:00Z");
assert.equal(priceBeforeToday(during, "2026-10-08"), 50, "past days scale to the reported price");
// A target-date mix: US up 1%, international down 1%, bonds flat.
const mix = weights("target-2055", 2026);
near(fundQuote(30, "target-2055", etfQuotes, "2026-10-08").price, 30 * (1 + mix.VTI * 0.01 - mix.VXUS * 0.01), "2055 mix");
// Plaid says the price is already Thursday's (evening): no move added, and
// the day's change runs back to the estimated Wednesday price.
const evening = fundQuote(50.5, "SPY", etfQuotes, "2026-10-08", "2026-10-08");
near(evening.price, 50.5, "already caught up");
near(evening.previousClose, 50, "Wednesday estimated");
near(priceBeforeToday(evening, "2026-10-08"), 50, "Wednesday close");
// Saturday: the brokerage has Friday's price; the latest session is Friday.
const weekend = fundQuote(50.5, "SPY", new Map([["SPY", { price: 606, previousClose: 600, asOf: "2026-10-09T19:59:00Z" }]]), "2026-10-10");
near(weekend.price, 50.5, "weekend price is the reported one");
near(priceBeforeToday(weekend, "2026-10-10"), 50.5, "Friday close");
assert.equal(fundQuote(50, "target-2055", new Map([["VTI", etfQuotes.get("VTI")]]), "2026-10-08"), null, "ETF quotes missing");
assert.equal(fundQuote(50, "SPY", new Map([["SPY", { price: 606, previousClose: null, asOf: "2026-10-08T18:00:00Z" }]]), "2026-10-08"), null);

// The estimate prices the holding live, as a ticker's quote would; a quoted
// ticker wins over it.
const fundHolding = { accountId: "k", key: "SWYJX", ticker: "SWYJX", securityType: "mutual fund", quantity: 10, institutionValue: 500 };
const liveQuotes = new Map([[fundQuoteKey("k", "SWYJX"), during]]);
assert.equal(holdingQuote(fundHolding, liveQuotes), during);
assert.equal(holdingQuote({ ...fundHolding, key: undefined }, liveQuotes), undefined);
const adjustment = liveAdjustments([fundHolding], liveQuotes).get("k");
near(adjustment.delta, 5, "account value moves with the estimate");
near(adjustment.dayChange, 5, "day change");
const etfHolding = { accountId: "a", key: "VOO", ticker: "VOO", securityType: "etf", quantity: 1, institutionValue: 550 };
const vooQuote = { price: 560, previousClose: 550, asOf: "2026-10-08T18:00:00Z" };
assert.equal(holdingQuote(etfHolding, new Map([["VOO", vooQuote], [fundQuoteKey("a", "VOO"), during]])), vooQuote);

// A plan code that looks like a ticker but has no market prices is priced
// by its index too; a priced ETF isn't.
assert.deepEqual(
  [
    ...fundIndexes(
      [
        { accountId: "k", key: "VGIST", ticker: "VGIST", quantity: 10, currentValue: 500 },
        { accountId: "a", key: "VOO", ticker: "VOO", quantity: 1, currentValue: 550 },
      ],
      new Map([
        ["VGIST", { name: "VANGUARD INSTL TTL INTL STOCK", ticker: "VGIST", securityType: "equity" }],
        ["VOO", { name: "Vanguard S&P 500 ETF", ticker: "VOO", securityType: "etf" }],
      ]),
      new Set(["VOO"]),
    ),
  ],
  [["VGIST", "VXUS"]],
);

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
const indexes = fundIndexes(positions, securities, new Set());
assert.deepEqual([...indexes], [["S&P 500 Index Fund", "SPY"]]);

// The fund's $50 is the close before today (Oct 2, SPY 600): 1/12 of SPY.
const priced = priceFundsByIndex(positions, indexes, new Map([["SPY", spy]]), "2026-10-05");
const series = proxySeries("S&P 500 Index Fund");
assert.deepEqual([...priced.funds], ["S&P 500 Index Fund"]);
assert.equal(priced.positions[0].ticker, series);
assert.equal(priced.positions[1].ticker, null);
near(priced.closes.get(series).find((close) => close.date === "2026-09-30").close, 50.5, "scaled close");
// Today's live estimate doesn't change the scale: it's the price before today.
const live = priceFundsByIndex(
  [{ ...positions[0], currentValue: 1010, reportedValue: 1000 }],
  indexes,
  new Map([["SPY", spy]]),
  "2026-10-05",
);
near(live.closes.get(series).find((close) => close.date === "2026-09-30").close, 50.5, "scaled to the reported price");

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
