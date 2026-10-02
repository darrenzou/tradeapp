// Sorts holdings into asset classes (US stocks, international stocks, bonds,
// cash) and stock regions, from a built-in list of common funds and stocks.
// Funds count by their usual mix; there's no look-through to what a fund
// holds, so two funds holding the same company aren't combined. Pure, so it
// runs in the browser, scripts and tests.

export type AssetClass = "us" | "intl" | "bonds" | "cash" | "other";

export type Region = "us" | "developed" | "emerging";

// Shares of a holding's value, adding up to 1.
export type ClassMix = Partial<Record<AssetClass, number>>;
export type RegionMix = Partial<Record<Region, number>>;

// How a holding was placed: the built-in list, its name, its security type
// (a single stock, a bond), or not at all ("Other").
export type ClassBasis = "list" | "name" | "type" | "unknown";

export type Classification = {
  mix: ClassMix;
  // Where its stocks are; empty when it holds none.
  regions: RegionMix;
  basis: ClassBasis;
};

export const ASSET_CLASSES: { id: AssetClass; label: string; color: string }[] = [
  { id: "us", label: "US stocks", color: "#1c2b1a" },
  { id: "intl", label: "Intl stock", color: "#4c7a1e" },
  { id: "bonds", label: "Bonds", color: "#9fcbc6" },
  { id: "cash", label: "Cash", color: "#bdbdb5" },
  { id: "other", label: "Other", color: "#d8c79f" },
];

export const REGIONS: { id: Region; label: string; color: string }[] = [
  { id: "us", label: "United States", color: "#1c2b1a" },
  { id: "developed", label: "Developed markets", color: "#4c7a1e" },
  { id: "emerging", label: "Emerging markets", color: "#9fcbc6" },
];

const US: ClassMix = { us: 1 };
const BONDS: ClassMix = { bonds: 1 };
const CASH: ClassMix = { cash: 1 };
const INTL: ClassMix = { intl: 1 };

// International stock funds split between developed and emerging markets.
const ALL_WORLD_EX_US: RegionMix = { developed: 0.75, emerging: 0.25 };
const DEVELOPED: RegionMix = { developed: 1 };
const EMERGING: RegionMix = { emerging: 1 };

type Entry = { mix: ClassMix; intlRegions?: RegionMix };

function entries(tickers: string[], entry: Entry): [string, Entry][] {
  return tickers.map((ticker) => [ticker, entry]);
}

// Vanguard Target Retirement funds by year, roughly as of 2026.
const TARGET_DATE: [string[], ClassMix][] = [
  [["VTTVX"], { us: 0.32, intl: 0.21, bonds: 0.47 }], // 2025
  [["VTHRX"], { us: 0.38, intl: 0.25, bonds: 0.37 }], // 2030
  [["VTTHX"], { us: 0.43, intl: 0.28, bonds: 0.29 }], // 2035
  [["VFORX"], { us: 0.48, intl: 0.32, bonds: 0.2 }], // 2040
  [["VTIVX"], { us: 0.53, intl: 0.35, bonds: 0.12 }], // 2045
  [["VFIFX", "VFFVX", "VTTSX", "VLXVX", "VSVNX"], { us: 0.54, intl: 0.36, bonds: 0.1 }], // 2050+
];

const FUNDS = new Map<string, Entry>([
  // US stock funds.
  ...entries(
    [
      "VTI", "VOO", "SPY", "IVV", "SPLG", "ITOT", "SCHB", "SCHX", "SCHG", "SCHV", "SCHD", "SCHA", "SCHM",
      "VUG", "VTV", "VIG", "VYM", "VB", "VO", "VXF", "MGK", "MGC", "QQQ", "QQQM", "RSP", "IWM", "IWB",
      "IWF", "IWD", "IJR", "IJH", "DIA", "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "VGT",
      "SMH", "SOXX", "ARKK", "VNQ", "SCHH", "DGRO", "NOBL", "JEPI", "JEPQ", "SPYG", "SPYV", "VV",
      "FXAIX", "FSKAX", "FZROX", "FNILX", "FSMDX", "FSSNX", "SWPPX", "SWTSX", "VTSAX", "VFIAX", "VIGAX",
      "VFFSX", "VITSX", "VINIX",
    ],
    { mix: US },
  ),
  // International stock funds.
  ...entries(["VXUS", "IXUS", "VEU", "VTIAX", "FTIHX", "VFWAX"], { mix: INTL, intlRegions: ALL_WORLD_EX_US }),
  ...entries(["FZILX", "FSPSX"], { mix: INTL, intlRegions: { developed: 0.8, emerging: 0.2 } }),
  ...entries(["VEA", "IEFA", "EFA", "SCHF", "SPDW", "SWISX", "VTMGX", "IDEV"], { mix: INTL, intlRegions: DEVELOPED }),
  ...entries(["VWO", "IEMG", "EEM", "SCHE", "SPEM", "VEMAX", "FPADX"], { mix: INTL, intlRegions: EMERGING }),
  // Whole-world stock funds.
  ...entries(["VT", "VTWAX", "ACWI"], { mix: { us: 0.62, intl: 0.38 }, intlRegions: ALL_WORLD_EX_US }),
  // Bond funds.
  ...entries(
    [
      "BND", "AGG", "BNDX", "SCHZ", "VGIT", "VGSH", "VGLT", "TLT", "IEF", "SHY", "IEI", "GOVT", "VTEB",
      "MUB", "LQD", "HYG", "JNK", "TIP", "VTIP", "SCHP", "SCHO", "SCHR", "BSV", "BIV", "BLV", "VCIT",
      "VCSH", "IUSB", "SPAB", "FXNAX", "VBTLX", "VBMFX", "FBND", "SWAGX", "FUAMX", "VTABX", "BOND",
    ],
    { mix: BONDS },
  ),
  // Cash and cash-like funds.
  ...entries(
    ["SPAXX", "FDRXX", "FZFXX", "SPRXX", "VMFXX", "VMRXX", "SWVXX", "SNVXX", "SNSXX", "SGOV", "BIL", "SHV", "USFR", "TFLO", "JPST"],
    { mix: CASH },
  ),
  // Balanced funds.
  ...entries(["VBIAX", "VBINX"], { mix: { us: 0.6, bonds: 0.4 } }),
  ...entries(["AOA"], { mix: { us: 0.5, intl: 0.3, bonds: 0.2 }, intlRegions: ALL_WORLD_EX_US }),
  ...entries(["AOR"], { mix: { us: 0.37, intl: 0.23, bonds: 0.4 }, intlRegions: ALL_WORLD_EX_US }),
  ...entries(["AOM"], { mix: { us: 0.25, intl: 0.15, bonds: 0.6 }, intlRegions: ALL_WORLD_EX_US }),
  ...entries(["AOK"], { mix: { us: 0.18, intl: 0.12, bonds: 0.7 }, intlRegions: ALL_WORLD_EX_US }),
  ...TARGET_DATE.flatMap(([tickers, mix]) => entries(tickers, { mix, intlRegions: ALL_WORLD_EX_US })),
]);

// Single stocks listed in the US but based abroad.
const FOREIGN_STOCKS = new Map<string, Region>([
  ...[
    "ASML", "TM", "SONY", "NVO", "SAP", "SHEL", "BP", "UL", "AZN", "HSBC", "TD", "RY", "BNS", "BMO", "CM",
    "SHOP", "NVS", "DEO", "BTI", "GSK", "SNY", "MUFG", "HMC", "SPOT", "ARM", "SE", "TTE", "RIO", "BHP",
    "ENB", "CNQ", "CP", "CNI", "LYG", "SMFG", "NTES", "STLA", "RACE", "LOGI",
  ].map((ticker): [string, Region] => [ticker, "developed"]),
  ...[
    "TSM", "BABA", "PDD", "JD", "BIDU", "NIO", "LI", "XPEV", "INFY", "WIT", "HDB", "IBN", "VALE", "PBR",
    "MELI", "NU", "TCEHY", "BEKE", "TME", "ITUB", "BBD", "YUMC",
  ].map((ticker): [string, Region] => [ticker, "emerging"]),
]);

function splitStockRegions(mix: ClassMix, intlRegions: RegionMix = ALL_WORLD_EX_US): RegionMix {
  const stocks = (mix.us ?? 0) + (mix.intl ?? 0);

  if (stocks === 0) {
    return {};
  }

  const regions: RegionMix = {};

  if (mix.us) {
    regions.us = mix.us / stocks;
  }

  for (const [region, share] of Object.entries(intlRegions) as [Region, number][]) {
    regions[region] = (regions[region] ?? 0) + ((mix.intl ?? 0) / stocks) * share;
  }

  return regions;
}

function fromEntry(entry: Entry, basis: ClassBasis): Classification {
  return { mix: entry.mix, regions: splitStockRegions(entry.mix, entry.intlRegions), basis };
}

// Fund names in 401(k) plans often come without a ticker; their names
// usually say what they hold.
function fromName(name: string): Entry | null {
  const lower = name.toLowerCase();
  const year =
    lower.match(/\b(?:target|freedom|retirement|lifecycle|lifepath)\b.*\b(20[2-7]\d)\b/) ??
    lower.match(/\b(20[2-7]\d)\b.*\b(?:target|freedom|retirement|lifecycle|lifepath)\b/);

  if (year) {
    const target = Number(year[1]);
    const row = TARGET_DATE.find((_, index) => 2025 + index * 5 >= target) ?? TARGET_DATE.at(-1)!;
    return { mix: row[1], intlRegions: ALL_WORLD_EX_US };
  }

  if (/money market|cash reserves|government cash|stable value|treasury money/.test(lower)) {
    return { mix: CASH };
  }

  if (/\bbond|fixed income|aggregate|treasury|income fund|tips\b/.test(lower)) {
    return { mix: BONDS };
  }

  if (/emerging/.test(lower)) {
    return { mix: INTL, intlRegions: EMERGING };
  }

  if (/international|intl|ex[- ]us|foreign|global ex|developed/.test(lower)) {
    return { mix: INTL, intlRegions: /developed/.test(lower) ? DEVELOPED : ALL_WORLD_EX_US };
  }

  if (/s&p 500|500 index|total (?:stock )?market|large ?cap|mid ?cap|small ?cap|extended market|russell|growth|value|dividend|stock index|equity index/.test(lower)) {
    return { mix: US };
  }

  return null;
}

export function classifyHolding(holding: {
  ticker: string | null;
  name: string;
  securityType: string | null;
}): Classification {
  const ticker = holding.ticker?.toUpperCase() ?? null;
  const listed = ticker ? FUNDS.get(ticker) : undefined;

  if (listed) {
    return fromEntry(listed, "list");
  }

  const type = holding.securityType?.toLowerCase() ?? "";

  if (type === "equity" || type === "stock" || type === "adr") {
    const region = (ticker && FOREIGN_STOCKS.get(ticker)) || "us";
    return region === "us"
      ? { mix: US, regions: { us: 1 }, basis: ticker && FOREIGN_STOCKS.has(ticker) ? "list" : "type" }
      : { mix: INTL, regions: { [region]: 1 }, basis: "list" };
  }

  if (type === "fixed income" || type === "bond") {
    return { mix: BONDS, regions: {}, basis: "type" };
  }

  if (type === "cash" || type === "money market") {
    return { mix: CASH, regions: {}, basis: "type" };
  }

  const named = fromName(holding.name);

  if (named) {
    return fromEntry(named, "name");
  }

  return { mix: { other: 1 }, regions: {}, basis: "unknown" };
}

// A single stock rather than a fund.
export function isSingleStock(holding: { ticker: string | null; securityType: string | null }): boolean {
  const type = holding.securityType?.toLowerCase() ?? "";
  return (type === "equity" || type === "stock" || type === "adr") && !FUNDS.has(holding.ticker?.toUpperCase() ?? "");
}

export type AllocationHolding = {
  key: string;
  ticker: string | null;
  name: string;
  securityType: string | null;
  marketValue: number;
};

export type ClassHolding = {
  key: string;
  ticker: string | null;
  name: string;
  // The part of this holding's value in the class.
  value: number;
  isFund: boolean;
  basis: ClassBasis;
};

export type ClassTotal = {
  id: AssetClass;
  value: number;
  // Share of everything (holdings, cash and accounts without holdings).
  share: number;
  // Largest first.
  holdings: ClassHolding[];
};

export type Allocation = {
  total: number;
  // Every class, in ASSET_CLASSES order, including empty ones.
  classes: ClassTotal[];
  // Shares of the stocks part, by region, in REGIONS order.
  regions: { id: Region; value: number; share: number }[];
  singleStocks: number;
  // Holdings placed by their name or not at all, for the footnote.
  guessed: number;
  unclassified: number;
};

// Splits the portfolio into asset classes and regions. Cash is the brokerage
// and bank cash from the Stocks page; accounts whose holdings couldn't be
// loaded count as Other.
export function buildAllocation(
  holdings: AllocationHolding[],
  cashValue: number,
  otherValue: number,
): Allocation {
  const byClass = new Map<AssetClass, ClassHolding[]>(ASSET_CLASSES.map((item) => [item.id, []]));
  const regionValues = new Map<Region, number>(REGIONS.map((item) => [item.id, 0]));
  let singleStocks = 0;
  let guessed = 0;
  let unclassified = 0;

  for (const holding of holdings) {
    if (holding.marketValue <= 0) {
      continue;
    }

    const { mix, regions, basis } = classifyHolding(holding);
    const stocksValue = holding.marketValue * ((mix.us ?? 0) + (mix.intl ?? 0));
    const single = isSingleStock(holding);

    for (const [assetClass, share] of Object.entries(mix) as [AssetClass, number][]) {
      byClass.get(assetClass)!.push({
        key: holding.key,
        ticker: holding.ticker,
        name: holding.name,
        value: holding.marketValue * share,
        isFund: !single,
        basis,
      });
    }

    for (const [region, share] of Object.entries(regions) as [Region, number][]) {
      regionValues.set(region, regionValues.get(region)! + stocksValue * share);
    }

    singleStocks += single ? holding.marketValue : 0;
    guessed += basis === "name" ? 1 : 0;
    unclassified += basis === "unknown" ? 1 : 0;
  }

  const holdingsTotal = holdings.reduce((sum, holding) => sum + Math.max(holding.marketValue, 0), 0);
  const total = holdingsTotal + Math.max(cashValue, 0) + Math.max(otherValue, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);
  const extra: Partial<Record<AssetClass, number>> = { cash: Math.max(cashValue, 0), other: Math.max(otherValue, 0) };
  const stocksTotal = [...regionValues.values()].reduce((sum, value) => sum + value, 0);

  return {
    total,
    classes: ASSET_CLASSES.map(({ id }) => {
      const items = byClass.get(id)!.sort((a, b) => b.value - a.value);
      const value = items.reduce((sum, item) => sum + item.value, 0) + (extra[id] ?? 0);
      return { id, value, share: share(value), holdings: items };
    }),
    regions: REGIONS.map(({ id }) => {
      const value = regionValues.get(id)!;
      return { id, value, share: stocksTotal > 0 ? value / stocksTotal : 0 };
    }),
    singleStocks: share(singleStocks),
    guessed,
    unclassified,
  };
}
