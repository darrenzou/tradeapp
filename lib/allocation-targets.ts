// The asset class mix a user aims for, set on the Set targets page, plus the
// expected return and swings of a mix from long-run averages. Pure, so it
// runs in the browser, scripts and tests.

export type TargetClass = "us" | "intl" | "bonds" | "cash";

// Whole percents adding up to 100.
export type AllocationTargets = Record<TargetClass, number>;

export const TARGET_CLASSES: TargetClass[] = ["us", "intl", "bonds", "cash"];

export const TARGET_PRESETS: { id: string; label: string; targets: AllocationTargets }[] = [
  { id: "cautious", label: "Cautious", targets: { us: 30, intl: 10, bonds: 50, cash: 10 } },
  { id: "balanced", label: "Balanced", targets: { us: 45, intl: 15, bonds: 35, cash: 5 } },
  { id: "growth", label: "Growth", targets: { us: 60, intl: 25, bonds: 10, cash: 5 } },
];

export function stockPercent(targets: AllocationTargets): number {
  return targets.us + targets.intl;
}

// Targets as sent by the browser or read back from storage, or null when
// they aren't valid.
export function parseAllocationTargets(value: unknown): AllocationTargets | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const targets = {} as AllocationTargets;

  for (const id of TARGET_CLASSES) {
    const percent = record[id];

    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
      return null;
    }

    targets[id] = percent;
  }

  return TARGET_CLASSES.reduce((sum, id) => sum + targets[id], 0) === 100 ? targets : null;
}

// Long-run yearly averages for each class, in percent: what a year returns
// on average and how far it typically swings (standard deviation). "other"
// covers holdings the built-in list can't place.
type RiskClass = TargetClass | "other";

const EXPECTED: Record<RiskClass, number> = { us: 7.2, intl: 6.8, bonds: 3.8, cash: 3, other: 5.5 };
const VOLATILITY: Record<RiskClass, number> = { us: 16.5, intl: 18, bonds: 6, cash: 0.6, other: 15 };

// How closely two classes move together.
const CORRELATION: Record<string, number> = {
  "us|intl": 0.82,
  "us|bonds": 0.15,
  "intl|bonds": 0.15,
  "us|other": 0.7,
  "intl|other": 0.7,
  "bonds|other": 0.2,
};

function correlation(a: RiskClass, b: RiskClass): number {
  return a === b ? 1 : (CORRELATION[`${a}|${b}`] ?? CORRELATION[`${b}|${a}`] ?? 0);
}

// One year this bad or worse happens about 1 year in 20.
const BAD_YEAR_Z = 1.645;

export type RiskLevel = "Low" | "Moderate" | "High" | "Very high";

// Upper volatility bound of each level but the last, for the "How bumpy is
// it?" scale.
export const RISK_LEVELS: { label: RiskLevel; upTo: number }[] = [
  { label: "Low", upTo: 6 },
  { label: "Moderate", upTo: 11 },
  { label: "High", upTo: 17 },
  { label: "Very high", upTo: 24 },
];

export type RiskEstimate = {
  // Percent a year.
  expectedReturn: number;
  volatility: number;
  level: RiskLevel;
  // Percent lost in a 1-in-20 bad year (negative).
  badYear: number;
  // Return per 1% of volatility, and its letter grade.
  returnPerRisk: number;
  grade: string;
};

const GRADES: [number, string][] = [
  [0.55, "A"],
  [0.5, "A−"],
  [0.45, "B+"],
  [0.4, "B"],
  [0.35, "B−"],
  [0.3, "C+"],
];

// Shares of each class (fractions adding up to 1).
export function estimateRisk(shares: Partial<Record<RiskClass, number>>): RiskEstimate {
  const classes = (Object.keys(shares) as RiskClass[]).filter((id) => (shares[id] ?? 0) > 0);
  const total = classes.reduce((sum, id) => sum + shares[id]!, 0) || 1;
  const weight = (id: RiskClass) => (shares[id] ?? 0) / total;
  const expectedReturn = classes.reduce((sum, id) => sum + weight(id) * EXPECTED[id], 0);
  let variance = 0;

  for (const a of classes) {
    for (const b of classes) {
      variance += weight(a) * weight(b) * VOLATILITY[a] * VOLATILITY[b] * correlation(a, b);
    }
  }

  const volatility = Math.sqrt(variance);
  const returnPerRisk = volatility > 0 ? expectedReturn / volatility : 0;

  return {
    expectedReturn,
    volatility,
    level: RISK_LEVELS.find((level) => volatility < level.upTo)?.label ?? "Very high",
    badYear: expectedReturn - BAD_YEAR_Z * volatility,
    returnPerRisk,
    grade: GRADES.find(([floor]) => returnPerRisk >= floor)?.[1] ?? "C",
  };
}

export function targetShares(targets: AllocationTargets): Record<TargetClass, number> {
  return { us: targets.us / 100, intl: targets.intl / 100, bonds: targets.bonds / 100, cash: targets.cash / 100 };
}
