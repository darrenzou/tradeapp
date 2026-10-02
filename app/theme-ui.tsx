import type { CSSProperties } from "react";

import { formatMoney, formatTime } from "./client-api";

// A big headline amount with the cents set smaller: $320,428.28 shows as
// "$320,428" and a muted ".28". With signed, gains get a "+" and losses "−".
export function HeroAmount({ value, signed = false }: { value: number; signed?: boolean }) {
  const text = formatMoney(Math.abs(value));
  const point = text.lastIndexOf(".");
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";

  return (
    <>
      {sign}
      {point === -1 ? text : text.slice(0, point)}
      {point !== -1 && <span className="hero-cents">{text.slice(point)}</span>}
    </>
  );
}

// A grey placeholder bar shown while numbers load.
export function Skeleton({ width, height, className = "" }: { width: string; height?: string; className?: string }) {
  const style: CSSProperties = { width, ...(height ? { height } : {}) };
  return <span className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}

// "Updated 4:00 PM" beside a page's headline, or what is happening instead.
export function UpdatedNote({
  fetchedAt,
  updating,
}: {
  // When the shown data was loaded, or null before the first load.
  fetchedAt: number | null;
  updating: boolean;
}) {
  const text =
    fetchedAt === null || updating ? "Refreshing…" : `Updated ${formatTime(new Date(fetchedAt).toISOString())}`;

  return (
    <span className="hero-updated" aria-live="polite">
      {text}
    </span>
  );
}

// Stroke icons drawn at 24×24, inheriting the text color.
const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  trendUp: "M3 17l6-6 4 4 8-8M14 7h7v7",
  trendDown: "M3 7l6 6 4-4 8 8M14 17h7v-7",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  arrowDown: "M12 5v14M5 12l7 7 7-7",
  cart: "M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6M9 20h.01M17 20h.01",
  cash: "M3 7h18v10H3zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 10v.01M18 14v.01",
  fuel: "M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3M4 10h10",
  screen: "M3 5h18v12H3zM8 21h8M10 9v4l3.5-2z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  home: "M3 11l9-7 9 7M5 10v10h14V10",
  plane: "M2 16l20-6-20-6 3 6zM5 10h7",
  bag: "M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
  swap: "M7 7h13l-3-3M17 17H4l3 3",
  chart: "M3 17l6-6 4 4 8-8",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  close: "M6 6l12 12M18 6L6 18",
  bank: "M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  card: "M3 6h18v12H3zM3 10h18M7 15h3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.6 3.4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 16, strokeWidth = 2.2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="icon">
      <path
        d={ICON_PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A picture for each spending category (or account transaction detail).
export const CATEGORY_ICONS: Record<string, IconName> = {
  "Food & drink": "cart",
  Income: "cash",
  Transportation: "fuel",
  Travel: "plane",
  Entertainment: "screen",
  "Rent & utilities": "bolt",
  "Home improvement": "home",
  Shopping: "bag",
  Medical: "heart",
  "Personal care": "heart",
  "Transfer In": "swap",
  "Transfer Out": "swap",
  "Loan payments": "swap",
};
