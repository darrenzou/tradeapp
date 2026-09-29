// A rough US federal income tax estimate: ordinary brackets less the standard
// deduction, with no credits, itemized deductions, capital-gains rates, or
// payroll taxes. Pure, so the page can recompute it when the filing status
// changes.

export type FilingStatus = "single" | "married_joint" | "head_of_household";

// The status the Spending page assumes until the user picks another.
export const DEFAULT_FILING_STATUS: FilingStatus = "single";

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  married_joint: "Married filing jointly",
  head_of_household: "Head of household",
};

type YearTable = {
  standardDeduction: number;
  // Upper bounds of the 10, 12, 22, 24, 32, and 35% brackets; income above
  // the last bound is taxed at 37%.
  bounds: [number, number, number, number, number, number];
};

const RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37];

// IRS inflation adjustments (Rev. Procs. 2022-38, 2023-34, 2024-40, 2025-32),
// with the 2025 standard deduction as amended by Public Law 119-21.
const TABLES: Record<number, Record<FilingStatus, YearTable>> = {
  2023: {
    single: { standardDeduction: 13_850, bounds: [11_000, 44_725, 95_375, 182_100, 231_250, 578_125] },
    married_joint: { standardDeduction: 27_700, bounds: [22_000, 89_450, 190_750, 364_200, 462_500, 693_750] },
    head_of_household: { standardDeduction: 20_800, bounds: [15_700, 59_850, 95_350, 182_100, 231_250, 578_100] },
  },
  2024: {
    single: { standardDeduction: 14_600, bounds: [11_600, 47_150, 100_525, 191_950, 243_725, 609_350] },
    married_joint: { standardDeduction: 29_200, bounds: [23_200, 94_300, 201_050, 383_900, 487_450, 731_200] },
    head_of_household: { standardDeduction: 21_900, bounds: [16_550, 63_100, 100_500, 191_950, 243_700, 609_350] },
  },
  2025: {
    single: { standardDeduction: 15_750, bounds: [11_925, 48_475, 103_350, 197_300, 250_525, 626_350] },
    married_joint: { standardDeduction: 31_500, bounds: [23_850, 96_950, 206_700, 394_600, 501_050, 751_600] },
    head_of_household: { standardDeduction: 23_625, bounds: [17_000, 64_850, 103_350, 197_300, 250_500, 626_350] },
  },
  2026: {
    single: { standardDeduction: 16_100, bounds: [12_400, 50_400, 105_700, 201_775, 256_225, 640_600] },
    married_joint: { standardDeduction: 32_200, bounds: [24_800, 100_800, 211_400, 403_550, 512_450, 768_700] },
    head_of_household: { standardDeduction: 24_150, bounds: [17_700, 67_450, 105_700, 201_750, 256_200, 640_600] },
  },
};

const TABLE_YEARS = Object.keys(TABLES).map(Number).sort((a, b) => a - b);

// The table for a year, or the nearest year that has one.
function tableFor(year: number, status: FilingStatus): { table: YearTable; year: number } {
  const nearest = TABLE_YEARS.reduce((best, candidate) =>
    Math.abs(candidate - year) < Math.abs(best - year) ? candidate : best,
  );
  return { table: TABLES[nearest][status], year: nearest };
}

export type TaxEstimate = {
  taxableIncome: number;
  standardDeduction: number;
  tax: number;
  // Tax as a share of the income it was estimated on.
  effectiveRate: number | null;
  // The tax year whose brackets were used (the nearest one on file).
  bracketYear: number;
};

export function estimateFederalTax(income: number, year: number, status: FilingStatus): TaxEstimate {
  const { table, year: bracketYear } = tableFor(year, status);
  const taxableIncome = Math.max(0, income - table.standardDeduction);
  let tax = 0;
  let lower = 0;

  for (let index = 0; index < RATES.length; index += 1) {
    const upper = table.bounds[index] ?? Infinity;

    if (taxableIncome <= lower) {
      break;
    }

    tax += (Math.min(taxableIncome, upper) - lower) * RATES[index];
    lower = upper;
  }

  const rounded = Math.round(tax * 100) / 100;

  return {
    taxableIncome,
    standardDeduction: table.standardDeduction,
    tax: rounded,
    effectiveRate: income > 0 ? rounded / income : null,
    bracketYear,
  };
}
