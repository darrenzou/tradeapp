"use client";

import Link from "next/link";
import { useState } from "react";

import { formatMoney, staleDataMessage } from "../../client-api";
import { HeroAmount, Icon, Skeleton, UpdatedNote } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import { useStocks } from "../use-stocks";
import {
  ASSET_CLASSES,
  REGIONS,
  buildAllocation,
  isSingleStock,
  type Allocation,
  type AssetClass,
  type ClassTotal,
} from "@/lib/asset-classes";
import type { AllocationTargets } from "@/lib/allocation-targets";
import type { StockRow } from "@/lib/portfolio";

// Holding colors in the top bar, largest first; the rest share the last grey.
const HOLDING_COLORS = ["#1c2b1a", "#3f6b17", "#4c7a1e", "#6e9a33", "#8fb356", "#b5d38a", "#6fb0a8", "#9fcbc6"];
const REST_COLOR = "#d3d6cf";
const CASH_COLOR = "#bdbdb5";

const percent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const wholePercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// Each class's name inside a sentence.
const IN_SENTENCE: Record<AssetClass, string> = {
  us: "US stocks",
  intl: "international stocks",
  bonds: "bonds",
  cash: "cash",
  other: "other holdings",
};

function classInfo(id: AssetClass) {
  return ASSET_CLASSES.find((item) => item.id === id)!;
}

function wholeMoney(value: number): string {
  return formatMoney(Math.round(value)).replace(/\.00$/, "");
}

// What to buy (+) or sell (−) to reach the target, rounded to dollars.
function tradeText(trade: number): string {
  const rounded = Math.round(trade);
  return rounded === 0 ? "$0" : `${rounded > 0 ? "+" : "−"}${wholeMoney(Math.abs(rounded))}`;
}

function symbol(row: { ticker: string | null; name: string }): string {
  return row.ticker ?? row.name;
}

function StackedBar({ parts, label }: { parts: { key: string; value: number; color: string }[]; label?: string }) {
  return (
    <span className="al-stack" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {parts
        .filter((part) => part.value > 0)
        .map((part) => (
          <span key={part.key} style={{ flexGrow: part.value, background: part.color }} />
        ))}
    </span>
  );
}

// One asset class: its row in the table, opening to the holdings in it.
function ClassRow({
  item,
  allocation,
  target,
}: {
  item: ClassTotal;
  allocation: Allocation;
  target: number | null;
}) {
  const [ofEverything, setOfEverything] = useState(false);
  const info = classInfo(item.id);
  const trade = target === null ? null : (target / 100) * allocation.total - item.value;
  const scale = ofEverything ? allocation.total : item.value;
  const cashOutside = item.id === "cash" ? item.value - item.holdings.reduce((sum, holding) => sum + holding.value, 0) : 0;

  return (
    <details className="al-class">
      <summary className="al-class-row">
        <span className="al-class-name">
          <span className="sp-swatch" style={{ background: info.color }} aria-hidden="true" />
          {info.label}
        </span>
        <span className="al-num">{percent.format(item.share)}</span>
        <span className="al-num al-muted">{target === null ? "—" : `${target}%`}</span>
        <span className={`al-num al-trade ${trade !== null && trade > 0.5 ? "al-buy" : ""}`}>
          {trade === null ? "—" : tradeText(trade)}
        </span>
        <Icon name="chevronDown" size={16} strokeWidth={2.4} />
      </summary>
      <div className="al-class-body">
        <div className="al-class-head">
          <span>
            <b>{formatMoney(item.value)}</b> in {IN_SENTENCE[item.id]}
          </span>
          <span>
            {item.holdings.length} {item.holdings.length === 1 ? "holding" : "holdings"}
          </span>
        </div>
        {item.holdings.length > 0 && (
          <>
            <div className="al-segment" role="radiogroup" aria-label="Show each holding as a share of">
              {[false, true].map((everything) => (
                <button
                  key={String(everything)}
                  type="button"
                  role="radio"
                  aria-checked={ofEverything === everything}
                  onClick={() => setOfEverything(everything)}
                >
                  {everything ? "Of everything" : `Of ${IN_SENTENCE[item.id]}`}
                </button>
              ))}
            </div>
            <p className="al-note">
              {ofEverything
                ? `Full bar = everything you own, ${wholeMoney(allocation.total)}.`
                : `Full bar = all your ${IN_SENTENCE[item.id]}. Switch to see each slice of your whole ${wholeMoney(allocation.total)}.`}
            </p>
            <ul className="al-holdings">
              {item.holdings.map((holding) => {
                const share = scale > 0 ? holding.value / scale : 0;

                return (
                  <li key={holding.key}>
                    <Link href={`/stocks/${encodeURIComponent(holding.key)}`} className="al-holding">
                      <span className="al-ticker">{symbol(holding)}</span>
                      <span className="al-holding-main">
                        <span className="al-holding-name">{holding.ticker ? holding.name : "Fund"}</span>
                        <span className="al-holding-detail">
                          {holding.isFund ? "Fund" : "Stock"} · {formatMoney(holding.value)}
                        </span>
                      </span>
                      <span className="al-holding-share">{wholePercent.format(share)}</span>
                      <span className="al-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(share, 1) * 100}%`, background: info.color }} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="al-open-hint">Tap a holding to open it ›</p>
          </>
        )}
        {cashOutside > 0 && (
          <p className="al-note">
            {formatMoney(cashOutside)} is bank balances and uninvested cash. Cash on Stocks shows which accounts hold it.
          </p>
        )}
        {item.id === "other" && (
          <p className="al-note">
            Holdings the built-in list doesn&apos;t cover, and accounts whose holdings couldn&apos;t be loaded.
          </p>
        )}
      </div>
    </details>
  );
}

function ClassSection({ allocation, targets }: { allocation: Allocation; targets: AllocationTargets | null }) {
  const shown = allocation.classes.filter(
    (item) => item.value > 0 || (targets !== null && item.id !== "other" && targets[item.id] > 0),
  );

  return (
    <section className="dash-card sp-section al-section" aria-labelledby="class-heading">
      <div className="dash-card-header al-section-header">
        <h2 id="class-heading" className="sp-card-title al-title">By asset class</h2>
        <Link href="/stocks/targets" className="al-edit">
          {targets ? "Edit targets" : "Set targets"}
        </Link>
      </div>

      <div className="al-compare">
        <span className="al-compare-label">Now</span>
        <StackedBar parts={allocation.classes.map((item) => ({ key: item.id, value: item.value, color: classInfo(item.id).color }))} />
        {targets && (
          <>
            <span className="al-compare-label">Target</span>
            <StackedBar
              parts={(["us", "intl", "bonds", "cash"] as const).map((id) => ({
                key: id,
                value: targets[id],
                color: classInfo(id).color,
              }))}
            />
          </>
        )}
      </div>

      <div className="al-class-header" aria-hidden="true">
        <span>Class</span>
        <span>Now</span>
        <span>Target</span>
        <span>Trade</span>
        <span />
      </div>
      {shown.map((item) => (
        <ClassRow
          key={item.id}
          item={item}
          allocation={allocation}
          target={targets && item.id !== "other" ? targets[item.id] : null}
        />
      ))}
      <p className="al-note al-footer-note">
        {targets
          ? "You set your own targets. Trade shows what to sell (−) or buy (+) to land on your targets."
          : "Set targets to see how far each class is from the mix you want, and what to buy or sell to get there."}
      </p>
    </section>
  );
}

function RegionSection({ allocation }: { allocation: Allocation }) {
  if (allocation.regions.every((region) => region.value === 0)) {
    return null;
  }

  return (
    <section className="dash-card sp-section al-section" aria-labelledby="region-heading">
      <div className="dash-card-header al-section-header">
        <h2 id="region-heading" className="sp-card-title al-title">By region</h2>
        <span className="sp-card-note">Stocks only</span>
      </div>
      <StackedBar
        parts={allocation.regions.map((region) => ({
          key: region.id,
          value: region.value,
          color: REGIONS.find((item) => item.id === region.id)!.color,
        }))}
      />
      <ul className="al-regions">
        {allocation.regions.map((region) => {
          const info = REGIONS.find((item) => item.id === region.id)!;

          return (
            <li key={region.id}>
              <span className="al-class-name">
                <span className="sp-swatch" style={{ background: info.color }} aria-hidden="true" />
                {info.label}
              </span>
              <span className="al-num">{percent.format(region.share)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AllocationView({ onSessionExpired }: { onSessionExpired: () => void }) {
  const { entry, data, showUpdating, loadError } = useStocks(onSessionExpired);
  const isLoading = data === null && !loadError;
  const rows: StockRow[] = data ? [...data.rows].sort((a, b) => b.marketValue - a.marketValue) : [];
  const allocation = data ? buildAllocation(rows, data.cashValue, data.otherInvestmentsValue) : null;
  const total = allocation?.total ?? 0;
  const share = (value: number) => (total > 0 ? value / total : 0);
  const top = rows.slice(0, 3);
  const singles = rows.filter(isSingleStock);
  const legend = [
    ...rows.slice(0, HOLDING_COLORS.length).map((row, index) => ({
      key: row.key,
      label: symbol(row),
      value: row.marketValue,
      color: HOLDING_COLORS[index],
    })),
    ...(rows.length > HOLDING_COLORS.length
      ? [{ key: "rest", label: "Others", value: rows.slice(HOLDING_COLORS.length).reduce((sum, row) => sum + row.marketValue, 0), color: REST_COLOR }]
      : []),
    ...(data && data.cashValue > 0 ? [{ key: "cash", label: "Cash", value: data.cashValue, color: CASH_COLOR }] : []),
    ...(data && data.otherInvestmentsValue > 0
      ? [{ key: "other", label: "Other", value: data.otherInvestmentsValue, color: classInfo("other").color }]
      : []),
  ];

  return (
    <main className="dash-page hd-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href="/stocks" className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            Stocks
          </Link>
          <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating={showUpdating || isLoading} />
        </div>

        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? staleDataMessage("your holdings", entry.fetchedAt)
              : loadError}
          </p>
        )}

        <section className="dash-hero" aria-labelledby="allocation-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="allocation-heading" className="dash-label">Allocation</h1>
            {data && (
              <span className="hero-updated">
                {rows.length} {rows.length === 1 ? "holding" : "holdings"}
                {data.cashValue > 0 ? " + cash" : ""}
              </span>
            )}
          </div>
          <p className="dash-hero-value">
            {allocation ? <HeroAmount value={allocation.total} /> : <Skeleton width="60%" height="44px" />}
          </p>
          {allocation && allocation.total > 0 && (
            <>
              <StackedBar parts={legend} />
              <ul className="al-legend">
                {legend.map((item) => (
                  <li key={item.key}>
                    <span className="sp-swatch" style={{ background: item.color }} aria-hidden="true" />
                    <b>{item.label}</b> {percent.format(share(item.value))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {allocation && allocation.total > 0 && (
          <>
            <div className="sp-tiles">
              <div className="sp-tile sp-tile-out">
                <span className="sp-tile-label">Top 3 holdings</span>
                <span className="sp-tile-value">{percent.format(share(top.reduce((sum, row) => sum + row.marketValue, 0)))}</span>
                <span className="sp-tile-note">{top.map(symbol).join(", ") || "None"}</span>
              </div>
              <div className="sp-tile hd-tile-plain">
                <span className="sp-tile-label">Single stocks</span>
                <span className="sp-tile-value">{percent.format(allocation.singleStocks)}</span>
                <span className="sp-tile-note">{singles.slice(0, 3).map(symbol).join(", ") || "Only funds"}</span>
              </div>
            </div>

            <ClassSection allocation={allocation} targets={data?.targets ?? null} />
            <RegionSection allocation={allocation} />

            <p className="stocks-footnote spend-page-note">
              Funds are placed by their usual mix from a built-in list of common funds, without looking inside them, so
              a company held through two funds isn&apos;t combined.
              {allocation.guessed > 0
                ? ` ${allocation.guessed} ${allocation.guessed === 1 ? "fund isn't" : "funds aren't"} on the list and ${allocation.guessed === 1 ? "is" : "are"} placed by ${allocation.guessed === 1 ? "its" : "their"} name.`
                : ""}
              {allocation.unclassified > 0
                ? ` ${allocation.unclassified} ${allocation.unclassified === 1 ? "holding" : "holdings"} couldn't be placed and ${allocation.unclassified === 1 ? "counts" : "count"} as Other.`
                : ""}{" "}
              Cash is the same as on Stocks: bank balances and uninvested cash in your brokerage accounts.
            </p>
          </>
        )}

        {data && allocation?.total === 0 && <p className="dash-message">No investments to show yet.</p>}
      </div>
    </main>
  );
}

export default function AllocationPage() {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <AllocationView onSessionExpired={onSessionExpired} />;
}
