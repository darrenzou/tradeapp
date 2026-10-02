// Estimates how much stock and ETF positions gained in value in each calendar
// year, net of money put in or taken out: the change in market value plus
// sales less purchases. Dividends and interest are left out, since they are
// income rather than appreciation. Pure, so it runs in scripts and tests.

import type { DailyClose } from "./alpaca";
import type { InvestmentActivity } from "./portfolio";

// One position in one account: what is held now and how it got there.
export type AppreciationPosition = {
  accountId: string;
  key: string;
  // A US ticker with market prices, or null (funds without a listing, 401(k)
  // trusts), which can't be valued in past years.
  ticker: string | null;
  quantity: number;
  // Today's market value, at live prices where available.
  currentValue: number;
};

// complete: every stock and ETF position was valued for the whole year.
// partial: the year is only partly covered (history starts mid-year, or
//   some positions had no prices).
// unavailable: nothing could be valued for that year.
export type AppreciationStatus = "complete" | "partial" | "unavailable";

export type YearAppreciation = {
  year: number;
  amount: number | null;
  status: AppreciationStatus;
  // Why the figure is partial or missing, for display.
  note: string | null;
};

type Input = {
  positions: AppreciationPosition[];
  activities: InvestmentActivity[];
  // Earliest date each account's transaction history covers.
  historyStarts: Map<string, string>;
  closes: Map<string, DailyClose[]>;
  years: number[];
  today: string;
};

const TICKER_PATTERN = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
const SHARE_TOLERANCE = 1e-4;
const DAY_MS = 86_400_000;

function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

// The last close on or before `date`.
function closeOn(closes: DailyClose[] | undefined, date: string): number | null {
  if (closes === undefined) {
    return null;
  }

  let low = 0;
  let high = closes.length - 1;
  let found: number | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (closes[middle].date <= date) {
      found = closes[middle].close;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

// A symbol sold out of before today still has history; its grouping key is
// the ticker when it has one.
export function tickerFromKey(key: string): string | null {
  return TICKER_PATTERN.test(key) ? key : null;
}

// Positions held now plus any that only appear in history (sold since).
export function positionsWithHistory(
  held: AppreciationPosition[],
  activities: InvestmentActivity[],
): AppreciationPosition[] {
  const byLot = new Map(held.map((position) => [`${position.accountId}|${position.key}`, position]));

  for (const activity of activities) {
    const lot = `${activity.accountId}|${activity.key}`;

    if (!byLot.has(lot)) {
      byLot.set(lot, {
        accountId: activity.accountId,
        key: activity.key,
        ticker: tickerFromKey(activity.key),
        quantity: 0,
        currentValue: 0,
      });
    }
  }

  return [...byLot.values()];
}

// amount: the gain. startValue: what the lot was worth at the start.
// flows: sales less purchases during the period.
type LotResult = { amount: number; partial: boolean; startValue: number; flows: number } | null;

function lotAppreciation(
  position: AppreciationPosition,
  activities: InvestmentActivity[],
  historyStart: string,
  closes: DailyClose[] | undefined,
  yearStart: string,
  yearEnd: string,
  today: string,
): LotResult {
  // Shares held at the end of `date`, working back from today. Only valid
  // from the day before the history starts onward.
  const sharesAt = (date: string) =>
    activities.reduce(
      (shares, activity) => (activity.date > date ? shares - activity.shareChange : shares),
      position.quantity,
    );
  const start = historyStart > yearStart ? previousDay(historyStart) : yearStart;
  const end = yearEnd >= today ? today : yearEnd;

  if (start >= end) {
    return null;
  }

  const tolerance = Math.max(SHARE_TOLERANCE, Math.abs(position.quantity) * SHARE_TOLERANCE);
  const value = (date: string): number | null => {
    const shares = sharesAt(date);

    if (Math.abs(shares) <= tolerance) {
      return 0;
    }
    if (date === today) {
      return position.currentValue;
    }

    const close = closeOn(closes, date);
    return close === null ? null : shares * close;
  };

  const startValue = value(start);
  const endValue = value(end);

  if (startValue === null || endValue === null) {
    return null;
  }

  let flows = 0;

  for (const activity of activities) {
    if (activity.date <= start || activity.date > end || activity.shareChange === 0) {
      continue;
    }

    if (activity.valueAtCost) {
      // Shares moved between accounts without a price: value them at that
      // day's close so the move itself is neither a gain nor a loss.
      const close = closeOn(closes, activity.date);

      if (close === null) {
        return null;
      }
      flows -= activity.shareChange * close;
    } else {
      flows += activity.cashFlow;
    }
  }

  return { amount: endValue - startValue + flows, partial: start !== yearStart, startValue, flows };
}

type Period = { start: string; end: string };
type PeriodResult = Omit<YearAppreciation, "year">;

// Appreciation over each period, from the close on `start` to the close on
// `end` (or today's value, for a period still under way).
function periodAppreciation(input: Omit<Input, "years">, periods: Period[], unit: "year" | "month"): PeriodResult[] {
  const activitiesByLot = new Map<string, InvestmentActivity[]>();

  for (const activity of input.activities) {
    const lot = `${activity.accountId}|${activity.key}`;
    const list = activitiesByLot.get(lot) ?? [];
    list.push(activity);
    activitiesByLot.set(lot, list);
  }

  return periods.map(({ start, end }): PeriodResult => {
    let amount = 0;
    let valued = 0;
    let partialStart = false;
    let missing = 0;

    for (const position of input.positions) {
      const historyStart = input.historyStarts.get(position.accountId);
      const activities = activitiesByLot.get(`${position.accountId}|${position.key}`) ?? [];
      const heldDuringPeriod =
        position.quantity !== 0 || activities.some((activity) => activity.date > start);

      if (!heldDuringPeriod) {
        continue;
      }

      if (position.ticker === null || historyStart === undefined) {
        missing += 1;
        continue;
      }

      const result = lotAppreciation(
        position,
        activities,
        historyStart,
        input.closes.get(position.ticker),
        start,
        end,
        input.today,
      );

      if (result === null) {
        missing += 1;
        continue;
      }

      amount += result.amount;
      valued += 1;
      partialStart ||= result.partial;
    }

    if (valued === 0) {
      return {
        amount: null,
        status: "unavailable",
        note: `Your brokerage transaction history doesn't reach back to this ${unit}.`,
      };
    }

    const notes = [
      partialStart && `Transaction history starts partway through this ${unit}, so only the covered part is included.`,
      missing > 0 &&
        `${missing} ${missing === 1 ? "position isn't" : "positions aren't"} included (no market prices or transaction history, e.g. some funds and 401(k) trusts).`,
    ].filter((note): note is string => typeof note === "string");

    return {
      amount: Math.round(amount * 100) / 100,
      status: notes.length > 0 ? "partial" : "complete",
      note: notes.length > 0 ? notes.join(" ") : null,
    };
  });
}

export type HoldingReturn = {
  key: string;
  // Change in value plus sales less purchases, plus dividends and interest
  // paid on the holding.
  gain: number;
  startValue: number;
  // Purchases less sales during the period.
  invested: number;
};

export type HoldingReturns = {
  holdings: HoldingReturn[];
  // Positions held during the period that couldn't be valued.
  missing: number;
  // Some history starts after `start`, so only the covered part counts.
  partial: boolean;
};

// Each holding's gain from the close on `start` to today, including the
// dividends and interest it paid, summed across accounts.
export function holdingReturns(input: Omit<Input, "years">, start: string): HoldingReturns {
  const activitiesByLot = new Map<string, InvestmentActivity[]>();

  for (const activity of input.activities) {
    const lot = `${activity.accountId}|${activity.key}`;
    const list = activitiesByLot.get(lot) ?? [];
    list.push(activity);
    activitiesByLot.set(lot, list);
  }

  const byKey = new Map<string, HoldingReturn>();
  let missing = 0;
  let partial = false;

  for (const position of input.positions) {
    const historyStart = input.historyStarts.get(position.accountId);
    const activities = activitiesByLot.get(`${position.accountId}|${position.key}`) ?? [];
    const heldDuringPeriod = position.quantity !== 0 || activities.some((activity) => activity.date > start);

    if (!heldDuringPeriod) {
      continue;
    }

    const result =
      position.ticker === null || historyStart === undefined
        ? null
        : lotAppreciation(
            position,
            activities,
            historyStart,
            input.closes.get(position.ticker),
            start,
            input.today,
            input.today,
          );

    if (result === null) {
      missing += 1;
      continue;
    }

    const counted = result.partial ? previousDay(historyStart!) : start;
    const income = activities
      .filter((activity) => activity.shareChange === 0 && activity.date > counted && activity.date <= input.today)
      .reduce((sum, activity) => sum + activity.cashFlow, 0);
    const entry = byKey.get(position.key) ?? { key: position.key, gain: 0, startValue: 0, invested: 0 };

    entry.gain += result.amount + income;
    entry.startValue += result.startValue;
    entry.invested -= result.flows;
    byKey.set(position.key, entry);
    partial ||= result.partial;
  }

  return { holdings: [...byKey.values()], missing, partial };
}

// A group's return as a fraction: its gain over what was at work, counting
// money added during the period as at work for half of it.
export function returnRate(holdings: HoldingReturn[]): number | null {
  const gain = holdings.reduce((sum, holding) => sum + holding.gain, 0);
  const base = holdings.reduce((sum, holding) => sum + holding.startValue + holding.invested / 2, 0);
  return base > 0 ? gain / base : null;
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function yearlyAppreciation(input: Input): YearAppreciation[] {
  const results = periodAppreciation(
    input,
    // Values at the close of the last day of the previous year.
    input.years.map((year) => ({ start: `${year - 1}-12-31`, end: `${year}-12-31` })),
    "year",
  );

  return input.years.map((year, index) => ({ year, ...results[index] }));
}

export type MonthAppreciation = Omit<YearAppreciation, "year"> & { month: string };

// The same measure for each month (YYYY-MM), close to close.
export function monthlyAppreciation(input: Omit<Input, "years">, months: string[]): MonthAppreciation[] {
  const results = periodAppreciation(
    input,
    months.map((month) => {
      const [year, index] = month.split("-").map(Number);
      return { start: lastDayOfMonth(year, index - 1), end: lastDayOfMonth(year, index) };
    }),
    "month",
  );

  return months.map((month, index) => ({ month, ...results[index] }));
}
