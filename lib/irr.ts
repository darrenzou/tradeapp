// Money-weighted return (XIRR) for dated cash flows, from the investor's
// point of view: money put in is negative, money taken out (sales,
// dividends, and the current value) is positive.

export type CashFlow = { date: string; amount: number };

const DAY_MS = 86_400_000;
// Holdings bought days ago can annualize to absurd rates; results are clamped
// to these bounds.
export const MIN_RATE = -0.9999;
export const MAX_IRR = 1_000;
const TOLERANCE = 1e-7;

function yearsBetween(from: number, to: number): number {
  return (to - from) / DAY_MS / 365;
}

// Returns the annualized IRR clamped to [MIN_RATE, MAX_IRR], or null when the
// flows cannot produce one (e.g. no money in, or no money out).
export function xirr(flows: CashFlow[]): number | null {
  const dated = flows
    .filter((flow) => Number.isFinite(flow.amount) && flow.amount !== 0)
    .map((flow) => ({ time: Date.parse(flow.date), amount: flow.amount }))
    .filter((flow) => Number.isFinite(flow.time));

  if (!dated.some((flow) => flow.amount < 0) || !dated.some((flow) => flow.amount > 0)) {
    return null;
  }

  const start = Math.min(...dated.map((flow) => flow.time));
  const end = Math.max(...dated.map((flow) => flow.time));

  if (end - start < DAY_MS) {
    return null;
  }

  const presentValue = (rate: number) =>
    dated.reduce(
      (total, flow) => total + flow.amount / Math.pow(1 + rate, yearsBetween(start, flow.time)),
      0,
    );

  // Bisection: present value falls as the rate rises for an
  // invest-then-receive pattern, and bisection never diverges.
  let low = MIN_RATE;
  let high = MAX_IRR;
  let lowValue = presentValue(low);
  const highValue = presentValue(high);

  // No root in range: the return is beyond one of the bounds.
  if (Math.sign(lowValue) === Math.sign(highValue)) {
    return highValue > 0 ? MAX_IRR : MIN_RATE;
  }

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const middle = (low + high) / 2;
    const middleValue = presentValue(middle);

    if (Math.abs(middleValue) < TOLERANCE || high - low < TOLERANCE) {
      return middle;
    }

    if (Math.sign(middleValue) === Math.sign(lowValue)) {
      low = middle;
      lowValue = middleValue;
    } else {
      high = middle;
    }
  }

  return (low + high) / 2;
}
