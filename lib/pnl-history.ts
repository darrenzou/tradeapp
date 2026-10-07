import "server-only";

import { dailyPnl, marketDaysFrom, type DailyPnlData } from "@/lib/daily-pnl";
import { loadCloses, loadInvestmentHistory } from "@/lib/investment-history";
import type { ReadOptions } from "@/lib/provider-cache";

// Always priced, so the market's open days are known even when the
// portfolio's own symbols are thinly traded.
const MARKET_SYMBOL = "SPY";
// The calendar reaches back at most this many years.
const MAX_YEARS = 5;
const DAY_MS = 86_400_000;

// Today in New York, where market days are counted.
export function marketToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

// The portfolio's P&L on each market day its transaction history covers,
// for the P&L calendar.
export async function loadDailyPnl(userId: string, options: ReadOptions = {}): Promise<DailyPnlData> {
  const issues: string[] = [];
  const today = marketToday();
  const { history, positions } = await loadInvestmentHistory(userId, issues, options);
  const earliest = [...history.historyStarts.values()].sort()[0] ?? today;
  const limit = `${Number(today.slice(0, 4)) - MAX_YEARS}-01-01`;
  // A couple of weeks before the history starts, so the opening close is
  // found across holidays.
  const start = daysBefore(earliest < limit ? limit : earliest, 15);
  const closes = await loadCloses(positions, start, today, [MARKET_SYMBOL]);
  const result = dailyPnl({
    positions,
    activities: history.activities,
    historyStarts: history.historyStarts,
    closes,
    marketDays: marketDaysFrom(closes, today),
    today,
  });

  return { today, ...result, issues };
}
