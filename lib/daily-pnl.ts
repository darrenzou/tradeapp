// The portfolio's profit or loss on each market day, rebuilt from brokerage
// transaction history and daily closing prices: each holding's change in
// value from the previous close, plus sales less purchases that day, plus
// dividends and interest it paid. Months and years add up their days, and
// their returns chain the daily returns together (time-weighted), so money
// added or taken out doesn't count as a gain or loss. Pure, so it runs in
// scripts and tests.

import type { DailyClose } from "./alpaca";
import type { AppreciationPosition } from "./appreciation";
import type { InvestmentActivity } from "./portfolio";

export type PnlDay = {
  // YYYY-MM-DD, a day the market was open.
  date: string;
  pnl: number;
  // Fraction of what was invested at the start of the day (plus anything
  // bought that day), or null when nothing was.
  rate: number | null;
};

export type PnlPeriod = {
  // YYYY-MM for a month, YYYY for a year.
  key: string;
  pnl: number;
  rate: number | null;
  // Market days with a figure.
  days: number;
};

export type DailyPnlData = {
  // Today in New York, where the market's days are counted.
  today: string;
  // Market days with a figure, oldest first. Days the market was closed
  // aren't listed.
  days: PnlDay[];
  months: PnlPeriod[];
  years: PnlPeriod[];
  // Positions that couldn't be valued (no market prices or history, e.g.
  // some funds and 401(k) trusts), so they aren't counted.
  missing: number;
  // Some accounts' history starts after the first day shown, so early days
  // count only the accounts covered then.
  partial: boolean;
  issues: string[];
};

type Input = {
  positions: AppreciationPosition[];
  activities: InvestmentActivity[];
  // Earliest date each account's transaction history covers.
  historyStarts: Map<string, string>;
  closes: Map<string, DailyClose[]>;
  // Days the market was open, oldest first, through today when it has
  // opened. Today's values are the positions' live values.
  marketDays: string[];
  today: string;
};

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

// Index of the first market day on or after `date`, or days.length.
function firstDayFrom(days: string[], date: string): number {
  let low = 0;
  let high = days.length;

  while (low < high) {
    const middle = (low + high) >> 1;

    if (days[middle] < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

// Days the market was open: every date any symbol has a close for.
export function marketDaysFrom(closes: Map<string, DailyClose[]>, today: string): string[] {
  const dates = new Set<string>();

  for (const list of closes.values()) {
    for (const close of list) {
      if (close.date <= today) {
        dates.add(close.date);
      }
    }
  }

  return [...dates].sort();
}

// Chains daily returns: (1 + r1)(1 + r2)… − 1.
function chain(rates: (number | null)[]): number | null {
  let growth = 1;
  let any = false;

  for (const rate of rates) {
    if (rate !== null) {
      growth *= 1 + rate;
      any = true;
    }
  }

  return any ? growth - 1 : null;
}

function periods(days: PnlDay[], keyOf: (date: string) => string): PnlPeriod[] {
  const groups = new Map<string, PnlDay[]>();

  for (const day of days) {
    const key = keyOf(day.date);
    const list = groups.get(key) ?? [];
    list.push(day);
    groups.set(key, list);
  }

  return [...groups].map(([key, list]) => ({
    key,
    pnl: Math.round(list.reduce((sum, day) => sum + day.pnl, 0) * 100) / 100,
    rate: chain(list.map((day) => day.rate)),
    days: list.length,
  }));
}

export function dailyPnl(input: Input): Omit<DailyPnlData, "today" | "issues"> {
  const days = input.marketDays;
  const count = days.length;
  const pnl = new Array<number>(count).fill(0);
  const base = new Array<number>(count).fill(0);
  // A day with a figure: at least one position was valued over it.
  const covered = new Array<boolean>(count).fill(false);
  // Something was held, bought, sold or paid that day.
  const active = new Array<boolean>(count).fill(false);
  // The latest start of any valued position's history.
  let latestCover: string | null = null;
  let missing = 0;

  const activitiesByLot = new Map<string, InvestmentActivity[]>();

  for (const activity of input.activities) {
    if (activity.date > input.today) {
      continue;
    }

    const lot = `${activity.accountId}|${activity.key}`;
    const list = activitiesByLot.get(lot) ?? [];
    list.push(activity);
    activitiesByLot.set(lot, list);
  }

  for (const position of input.positions) {
    const activities = activitiesByLot.get(`${position.accountId}|${position.key}`) ?? [];

    if (position.quantity === 0 && activities.length === 0) {
      continue;
    }

    const historyStart = input.historyStarts.get(position.accountId);
    const closes = position.ticker === null ? undefined : input.closes.get(position.ticker);

    if (historyStart === undefined || closes === undefined || closes.length === 0 || count === 0) {
      missing += 1;
      continue;
    }

    // Shares can be worked back from today only to the day before the
    // history starts.
    const coverFrom = previousDay(historyStart);
    const tolerance = Math.max(SHARE_TOLERANCE, Math.abs(position.quantity) * SHARE_TOLERANCE);

    // Shares held at the end of each market day, working back from today.
    const newestFirst = [...activities].sort((a, b) => b.date.localeCompare(a.date));
    const shares = new Array<number>(count);
    let held = position.quantity;
    let next = 0;

    for (let index = count - 1; index >= 0; index -= 1) {
      while (next < newestFirst.length && newestFirst[next].date > days[index]) {
        held -= newestFirst[next].shareChange;
        next += 1;
      }
      shares[index] = held;
    }

    const values = days.map((date, index): number | null => {
      if (Math.abs(shares[index]) <= tolerance) {
        return 0;
      }
      if (date === input.today) {
        return position.currentValue;
      }

      const close = closeOn(closes, date);
      return close === null ? null : shares[index] * close;
    });

    // Money in and out, credited to the first market day on or after it.
    const flows = new Array<number>(count).fill(0);
    const income = new Array<number>(count).fill(0);
    const unpriced = new Array<boolean>(count).fill(false);

    for (const activity of activities) {
      const index = firstDayFrom(days, activity.date);

      if (index === 0 || index >= count) {
        continue;
      }

      if (activity.shareChange === 0) {
        income[index] += activity.cashFlow;
      } else if (activity.valueAtCost) {
        // Shares moved between accounts without a price: valued at that
        // day's close so the move itself is neither a gain nor a loss.
        const close = closeOn(closes, activity.date);

        if (close === null) {
          unpriced[index] = true;
        } else {
          flows[index] -= activity.shareChange * close;
        }
      } else {
        flows[index] += activity.cashFlow;
      }
    }

    let valued = false;

    for (let index = 1; index < count; index += 1) {
      const start = values[index - 1];
      const end = values[index];

      if (days[index - 1] < coverFrom || start === null || end === null || unpriced[index]) {
        continue;
      }

      pnl[index] += end - start + flows[index] + income[index];
      base[index] += start + Math.max(0, -flows[index]);
      covered[index] = true;
      active[index] ||= start !== 0 || end !== 0 || flows[index] !== 0 || income[index] !== 0;
      valued = true;
    }

    if (!valued) {
      missing += 1;
    } else if (latestCover === null || coverFrom > latestCover) {
      latestCover = coverFrom;
    }
  }

  const first = active.indexOf(true);
  const result: PnlDay[] = [];

  if (first !== -1) {
    for (let index = first; index < count; index += 1) {
      if (!covered[index]) {
        continue;
      }

      result.push({
        date: days[index],
        pnl: Math.round(pnl[index] * 100) / 100,
        rate: base[index] > 0 ? pnl[index] / base[index] : null,
      });
    }
  }

  return {
    days: result,
    months: periods(result, (date) => date.slice(0, 7)),
    years: periods(result, (date) => date.slice(0, 4)),
    missing,
    partial: result.length > 0 && latestCover !== null && latestCover > result[0].date,
  };
}
