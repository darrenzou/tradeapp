import { formatMoney } from "../client-api";

export function monthLabel(month: string, style: "long" | "short" = "long"): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-US", {
    month: style,
    year: "numeric",
    timeZone: "UTC",
  });
}

// "Jul" for 2026-07.
export function monthName(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

export function dateLabel(date: string, style: "short" | "long" = "short"): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: style === "long" ? "long" : undefined,
    month: style === "long" ? "long" : "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function signedMoney(value: number): string {
  const text = formatMoney(Math.abs(value));
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

export function tone(value: number | null): string {
  return value === null || value === 0 ? "" : value > 0 ? "stocks-up" : "stocks-down";
}

// Compact axis and bar labels: $950, $2.4k, $12k.
export function compactMoney(value: number): string {
  const abs = Math.abs(value);
  const text =
    abs >= 10_000
      ? `$${Math.round(abs / 1000)}k`
      : abs >= 1000
        ? `$${(abs / 1000).toFixed(1).replace(/\.0$/, "")}k`
        : `$${Math.round(abs)}`;
  return value < 0 ? `−${text}` : text;
}

// Spending categories in a fixed color order, so a category keeps its color
// from month to month; the rest share "Other". Hues are the validated
// categorical order (adjacent pairs distinguishable with color-vision
// deficiencies); lighter ones always appear with a text label.
export const CATEGORY_COLORS: [string, string][] = [
  ["Food & drink", "#2a78d6"],
  ["Shopping", "#eb6834"],
  ["Rent & utilities", "#1baf7a"],
  ["Travel", "#eda100"],
  ["Transportation", "#e87ba4"],
  ["Entertainment", "#008300"],
  ["Services", "#4a3aa7"],
];

export const OTHER_COLOR = "#9aa7a0";
const COLOR_BY_CATEGORY = new Map(CATEGORY_COLORS);

export function categoryColor(category: string): string {
  return COLOR_BY_CATEGORY.get(category) ?? OTHER_COLOR;
}

// Folds categories into the colored ones plus "Other", in color order.
export function colorGroups(categories: Record<string, number>): { name: string; amount: number; color: string }[] {
  let other = 0;
  const groups = CATEGORY_COLORS.flatMap(([name, color]) => {
    const amount = categories[name] ?? 0;
    return amount > 0 ? [{ name, amount, color }] : [];
  });

  for (const [name, amount] of Object.entries(categories)) {
    if (!COLOR_BY_CATEGORY.has(name) && amount > 0) {
      other += amount;
    }
  }

  return other > 0 ? [...groups, { name: "Other", amount: other, color: OTHER_COLOR }] : groups;
}

// Category colors by rank on the new Spending pages: the largest category
// gets the first. The yearly page uses warm tones, the month page greens.
export const YEAR_RANK_COLORS = ["#7a3a1c", "#a4532a", "#c9773f", "#dda27a"];
export const MONTH_RANK_COLORS = ["#1c2b1a", "#4c7a1e", "#7fa83a", "#b9d97a", "#6fb0a8", "#9fcbc6"];
export const REST_COLOR = "#bdbdb5";

// The other party without the reference numbers and dates banks add:
// "Online Transfer to SAV ...5678 transaction#: 1111 09/12" reads
// "Online Transfer to SAV transaction".
export function counterpartyLabel(name: string): string {
  const words = name
    .split(/\s+/)
    .filter((word) => !/\d/.test(word))
    .map((word) => word.replace(/[^\p{L}&']+$/u, ""))
    .filter((word) => word.length > 0);

  return words.length > 0 ? words.join(" ") : name;
}

// How often deposits arrive, from how many came in the months they span:
// "twice a month", "monthly", or a count.
export function depositFrequency(dates: string[]): string {
  const months = new Set(dates.map((date) => date.slice(0, 7))).size;
  const perMonth = months === 0 ? 0 : dates.length / months;

  if (months >= 2 && perMonth >= 3.5) {
    return "weekly";
  }

  if (months >= 2 && perMonth >= 1.8) {
    return "twice a month";
  }

  if (months >= 2 && perMonth >= 0.8) {
    return "monthly";
  }

  return `${dates.length} ${dates.length === 1 ? "deposit" : "deposits"}`;
}

// "Ally and Marcus", "Ally, Marcus and Chase".
export function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length <= 1 ? unique.join("") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

// "$2,337" for headline tiles that don't need cents.
export function wholeMoney(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

// Plaid shares at most this many months of bank and card history.
const HISTORY_MONTHS = 24;

// The first month the Spending pages show: when the bank history starts, but
// no earlier than 24 months back (this month included). Null before any
// history arrives.
export function historyStartMonth(earliest: string | null, today: string): string | null {
  if (earliest === null) {
    return null;
  }

  const [year, month] = today.slice(0, 7).split("-").map(Number);
  const index = year * 12 + (month - 1) - (HISTORY_MONTHS - 1);
  const floor = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  const first = earliest.slice(0, 7);
  return first > floor ? first : floor;
}
