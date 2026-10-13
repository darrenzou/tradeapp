// Checks that outside regular hours the day's change stops at the regular
// close and later trades become a separate pre-market or after-hours figure.
// No network or credentials needed.
//
//   node tests/stocks/check-extended-hours.mjs

import assert from "node:assert/strict";

const { extendedHoursQuote, extendedSessionLabel, isRegularHours, liveAdjustments } = await import(
  "../../lib/live-valuation.ts"
);

// Monday 2026-10-12 in New York (EDT, UTC-4).
const at = (time) => new Date(`2026-10-12T${time}-04:00`);
const bar = (date, c) => ({ t: `${date}T04:00:00Z`, c });

assert.equal(isRegularHours(at("09:29:00")), false);
assert.equal(isRegularHours(at("09:30:00")), true);
assert.equal(isRegularHours(at("16:14:00")), true, "waits for the delayed feed to report the close");
assert.equal(isRegularHours(at("16:15:00")), false);
assert.equal(isRegularHours(new Date("2026-10-10T12:00:00-04:00")), false, "Saturday");
assert.equal(extendedSessionLabel(at("07:00:00")), "Pre-market");
assert.equal(extendedSessionLabel(at("18:00:00")), "After hours");
assert.equal(extendedSessionLabel(at("01:00:00")), "After hours", "overnight, before pre-market opens");
assert.equal(extendedSessionLabel(new Date("2026-10-10T07:00:00-04:00")), "After hours", "Saturday shows Friday's");

// After hours: today's change ends at the close; the 17:30 trade is separate.
const after = extendedHoursQuote(
  {
    latestTrade: { p: 103, t: "2026-10-12T21:30:00Z" },
    dailyBar: bar("2026-10-12", 101),
    prevDailyBar: bar("2026-10-09", 100),
  },
  at("20:45:00"),
);
assert.deepEqual(after, { price: 101, previousClose: 100, asOf: "2026-10-12T21:30:00Z", extendedPrice: 103 });

// The last trade was the 15:59 regular one: no extended figure.
assert.equal(
  extendedHoursQuote(
    { latestTrade: { p: 101.2, t: "2026-10-12T19:59:00Z" }, dailyBar: bar("2026-10-12", 101), prevDailyBar: bar("2026-10-09", 100) },
    at("18:00:00"),
  ).extendedPrice,
  null,
);

// Pre-market Tuesday with Monday's bar still the latest: Monday's after-hours
// and Tuesday's early trades both count from Monday's close.
const pre = extendedHoursQuote(
  { latestTrade: { p: 99, t: "2026-10-13T11:00:00Z" }, dailyBar: bar("2026-10-12", 101), prevDailyBar: bar("2026-10-09", 100) },
  new Date("2026-10-13T07:30:00-04:00"),
);
assert.deepEqual([pre.price, pre.previousClose, pre.extendedPrice], [101, 100, 99]);

// Pre-market with a bar already dated today: Monday's close is the base.
const early = extendedHoursQuote(
  { latestTrade: { p: 99, t: "2026-10-13T11:00:00Z" }, dailyBar: bar("2026-10-13", 98), prevDailyBar: bar("2026-10-12", 101) },
  new Date("2026-10-13T07:30:00-04:00"),
);
assert.deepEqual([early.price, early.previousClose, early.extendedPrice], [101, null, 99]);

assert.equal(extendedHoursQuote({ latestTrade: null, dailyBar: null, prevDailyBar: null }, at("18:00:00")), null);

// Holdings value at the close; the extended move is reported on its own.
const adjustments = liveAdjustments(
  [
    { accountId: "a", ticker: "AAA", securityType: "equity", quantity: 10, institutionValue: 1000 },
    { accountId: "a", ticker: "BBB", securityType: "etf", quantity: 2, institutionValue: 200 },
  ],
  new Map([
    ["AAA", after],
    ["BBB", { price: 100, previousClose: 100, asOf: "2026-10-12T20:00:00Z", extendedPrice: null }],
  ]),
);
const account = adjustments.get("a");
assert.equal(account.delta, 10);
assert.equal(account.dayChange, 10);
assert.equal(account.extendedChange, 20);

console.log("Extended-hours checks passed.");
