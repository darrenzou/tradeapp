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
