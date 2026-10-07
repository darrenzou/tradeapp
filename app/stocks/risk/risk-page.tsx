"use client";

import Link from "next/link";
import { useState } from "react";

import { formatMoney, staleDataMessage } from "../../client-api";
import { Icon, Skeleton, UpdatedNote } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import { useReturns } from "../use-returns";
import { useStocks } from "../use-stocks";
import {
  RISK_LEVELS,
  estimateRisk,
  targetShares,
  type AllocationTargets,
  type RiskEstimate,
} from "@/lib/allocation-targets";
import { ASSET_CLASSES, buildAllocation, type Allocation, type AssetClass } from "@/lib/asset-classes";
import type { ReturnRange, ReturnsData } from "@/lib/returns";

const RANGES: ReturnRange[] = ["1M", "3M", "YTD", "1Y", "3Y", "All"];

const RANGE_NOTES: Record<ReturnRange, string> = {
  "1M": "Past month",
  "3M": "Past 3 months",
  YTD: "This year",
  "1Y": "Past year",
  "3Y": "Past 3 years",
  All: "All history",
};

const GRADE_WORDS: Record<string, string> = {
  A: "great",
  "A−": "very good",
  "B+": "good",
  B: "fair",
  "B−": "fair",
  "C+": "weak",
  C: "weak",
};

// The "How bumpy is it?" scale ends here.
const SCALE_MAX = RISK_LEVELS.at(-1)!.upTo;
const LEVEL_COLORS = ["#dcebb6", "#c6e090", "#e8dcaa", "#e6c7b5"];

function levelStart(index: number): number {
  return index === 0 ? 0 : RISK_LEVELS[index - 1].upTo;
}

const onePercent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function signedPercent(rate: number): string {
  const text = onePercent.format(Math.abs(rate));
  return rate > 0 ? `+${text}` : rate < 0 ? `−${text}` : text;
}

function wholeMoney(value: number): string {
  return formatMoney(Math.round(Math.abs(value))).replace(/\.00$/, "");
}

function signedMoney(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${wholeMoney(rounded)}`;
}

function monthYear(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function classInfo(id: AssetClass) {
  return ASSET_CLASSES.find((item) => item.id === id)!;
}

function ReturnHero({ returns, total }: { returns: ReturnsData | null; total: number }) {
  if (returns === null) {
    return (
      <>
        <p className="dash-hero-value">
          <Skeleton width="45%" height="44px" />
        </p>
        <Skeleton width="55%" height="28px" />
      </>
    );
  }

  const rate = returns.rate;

  return (
    <>
      <p className="dash-hero-value rk-rate">
        {rate === null ? (
          "—"
        ) : (
          <>
            {signedPercent(rate).replace("%", "")}
            <span className="hero-cents">%</span>
          </>
        )}
      </p>
      <p className={`hero-pill ${returns.gain < 0 ? "hero-pill-down" : ""}`}>
        {signedMoney(returns.gain)} on {wholeMoney(total)}
      </p>
    </>
  );
}

function ClassReturns({ returns, allocation, range }: { returns: ReturnsData; allocation: Allocation; range: ReturnRange }) {
  const rows = returns.classes.filter((item) => item.rate !== null);
  const positiveGains = rows.reduce((sum, item) => sum + Math.max(item.gain, 0), 0);
  const leader = rows.reduce<(typeof rows)[number] | null>((best, item) => (best === null || item.gain > best.gain ? item : best), null);
  const scale = Math.max(0.0001, ...rows.map((item) => Math.abs(item.rate ?? 0)));
  const share = (id: AssetClass) => allocation.classes.find((item) => item.id === id)?.share ?? 0;

  return (
    <section className="dash-card sp-section rk-section" aria-labelledby="by-class-heading">
      <div className="dash-card-header">
        <h2 id="by-class-heading" className="sp-card-title al-title">Return by class</h2>
        <span className="sp-card-note">{RANGE_NOTES[range]}</span>
      </div>
      {leader && leader.gain > 0 && positiveGains > 0 && (
        <p className="rk-lead">
          {classInfo(leader.id).label} earned {Math.round((leader.gain / positiveGains) * 100)}% of your gains.
        </p>
      )}
      <ul className="rk-classes">
        {rows.map((item) => {
          const info = classInfo(item.id);
          const rate = item.rate ?? 0;

          return (
            <li key={item.id} className="rk-class">
              <span className="sp-swatch" style={{ background: info.color }} aria-hidden="true" />
              <span className="rk-class-main">
                <span className="rk-class-name">{info.label}</span>
                <span className="rk-class-detail">{onePercent.format(share(item.id))} of portfolio</span>
              </span>
              <span className="rk-class-values">
                <span className={`rk-class-rate ${rate < 0 ? "rk-down" : "rk-up"}`}>{signedPercent(rate)}</span>
                <span className="rk-class-detail">{signedMoney(item.gain)} earned</span>
              </span>
              <span className="al-bar rk-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${(Math.abs(rate) / scale) * 100}%`,
                    background: rate < 0 ? "var(--negative)" : info.color,
                  }}
                />
              </span>
            </li>
          );
        })}
        {share("cash") > 0 && (
          <li className="rk-class">
            <span className="sp-swatch" style={{ background: classInfo("cash").color }} aria-hidden="true" />
            <span className="rk-class-main">
              <span className="rk-class-name">Cash</span>
              <span className="rk-class-detail">{onePercent.format(share("cash"))} of portfolio</span>
            </span>
            <span className="rk-class-values">
              <span className="rk-class-rate rk-up">{signedMoney(returns.cashInterest)}</span>
              <span className="rk-class-detail">brokerage interest</span>
            </span>
          </li>
        )}
      </ul>
      {rows.length === 0 && <p className="dash-empty">No holdings could be valued for this period.</p>}
    </section>
  );
}

function BumpyScale({ now, target }: { now: RiskEstimate; target: RiskEstimate | null }) {
  const left = (volatility: number) => `${(Math.min(volatility, SCALE_MAX) / SCALE_MAX) * 100}%`;

  return (
    <div className="rk-scale">
      <span className="rk-marker rk-marker-now" style={{ left: left(now.volatility) }}>
        Now {now.volatility.toFixed(1)}
      </span>
      <span className="rk-track" aria-hidden="true">
        {RISK_LEVELS.map((level, index) => (
          <span
            key={level.label}
            style={{ width: `${((level.upTo - levelStart(index)) / SCALE_MAX) * 100}%`, background: LEVEL_COLORS[index] }}
          />
        ))}
        <span className="rk-tick rk-tick-now" style={{ left: left(now.volatility) }} />
        {target && <span className="rk-tick" style={{ left: left(target.volatility) }} />}
      </span>
      {target && (
        <span className="rk-marker rk-marker-target" style={{ left: left(target.volatility) }}>
          Target {target.volatility.toFixed(1)}
        </span>
      )}
      <span className="rk-levels" aria-hidden="true">
        {RISK_LEVELS.map((level, index) => (
          <span key={level.label} style={{ left: `${(levelStart(index) / SCALE_MAX) * 100}%` }}>
            {level.label}
          </span>
        ))}
      </span>
    </div>
  );
}

function RiskSection({
  allocation,
  targets,
}: {
  allocation: Allocation;
  targets: AllocationTargets | null;
}) {
  const now = estimateRisk(Object.fromEntries(allocation.classes.map((item) => [item.id, item.share])));
  const target = targets ? estimateRisk(targetShares(targets)) : null;
  const sameLevel = target === null || target.level === now.level;
  const grade = target && target.returnPerRisk > now.returnPerRisk ? target : now;

  return (
    <section className="dash-card sp-section rk-section" aria-labelledby="risk-heading">
      <div className="dash-card-header al-section-header">
        <h2 id="risk-heading" className="sp-card-title al-title">Current vs target</h2>
        <Link href="/stocks/targets?from=risk" className="al-edit">
          {targets ? "Edit targets" : "Set targets"}
        </Link>
      </div>

      <div className="rk-mixes">
        <div className="rk-mix rk-mix-now">
          <span className="rk-mix-title">Current mix</span>
          <span className="rk-mix-label">Expected return</span>
          <span className="rk-mix-value">
            {now.expectedReturn.toFixed(1)}% <small>/yr</small>
          </span>
          <span className="rk-mix-label">Volatility</span>
          <span className="rk-mix-value">{now.volatility.toFixed(1)}%</span>
        </div>
        <div className="rk-mix">
          <span className="rk-mix-title">Your target</span>
          {target ? (
            <>
              <span className="rk-mix-label">Expected return</span>
              <span className="rk-mix-value">
                {target.expectedReturn.toFixed(1)}% <small>/yr</small>
              </span>
              <span className="rk-mix-label">Volatility</span>
              <span className="rk-mix-value">{target.volatility.toFixed(1)}%</span>
            </>
          ) : (
            <span className="rk-mix-label">No targets yet. Set them to compare.</span>
          )}
        </div>
      </div>

      <h3 className="rk-subheading">How bumpy is it?</h3>
      <BumpyScale now={now} target={target} />
      <p className="rk-text">
        Volatility is how much a year can swing.{" "}
        {sameLevel ? (
          <>
            {target ? "Both sit in" : "Yours sits in"} <b>{now.level}</b>
            {now.level === "High" || now.level === "Very high" ? ", typical for a mostly stock portfolio." : "."}
          </>
        ) : (
          <>
            Now it&apos;s <b>{now.level}</b>; your target is <b>{target!.level}</b>.
          </>
        )}{" "}
        A bad year below is one that happens about 1 in 20 years.
      </p>

      <div className="rk-bad-years">
        <div className="rk-bad-year">
          <span>Bad year, now</span>
          <b>{signedMoney((now.badYear / 100) * allocation.total)}</b>
          <span>{signedPercent(now.badYear / 100)}</span>
        </div>
        {target && (
          <div className="rk-bad-year">
            <span>Bad year, at target</span>
            <b>{signedMoney((target.badYear / 100) * allocation.total)}</b>
            <span>{signedPercent(target.badYear / 100)}</span>
          </div>
        )}
      </div>

      <div className="rk-grade">
        <span className="rk-grade-letter">{grade.grade}</span>
        <span>
          <b>Return for the risk: {GRADE_WORDS[grade.grade] ?? "fair"}</b>
          <span className="rk-grade-text">
            {now.returnPerRisk.toFixed(2)}% return per 1% of volatility now
            {target ? `, ${target.returnPerRisk.toFixed(2)}% at target` : ""}.
            {target && target.returnPerRisk > now.returnPerRisk + 0.005
              ? " Your target gets more for each unit of risk."
              : target && now.returnPerRisk > target.returnPerRisk + 0.005
                ? " Your current mix gets more for each unit of risk."
                : ""}
          </span>
        </span>
      </div>
    </section>
  );
}

function RiskView({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [range, setRange] = useState<ReturnRange>("1Y");
  const { entry, data, showUpdating, loadError, apiFetch } = useStocks(onSessionExpired);
  const { returns, error } = useReturns(range, apiFetch);
  const allocation = data ? buildAllocation(data.rows, data.cashValue, data.otherInvestmentsValue) : null;
  const isLoading = data === null && !loadError;

  return (
    <main className="dash-page hd-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href="/stocks/allocation" className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            Allocation
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

        <section className="dash-hero" aria-labelledby="return-heading" aria-busy={returns === null && !error}>
          <div className="dash-hero-top">
            <h1 id="return-heading" className="dash-label">Your return</h1>
            {returns && (
              <span className="hero-updated">
                {monthYear(returns.start)} – {monthYear(returns.end)}
              </span>
            )}
          </div>
          {error ? <p className="dash-message">{error}</p> : <ReturnHero returns={returns} total={allocation?.total ?? 0} />}
          <div className="rk-ranges" role="group" aria-label="Period">
            {RANGES.map((option) => (
              <button key={option} type="button" aria-pressed={range === option} onClick={() => setRange(option)}>
                {option}
              </button>
            ))}
          </div>
        </section>

        {returns && allocation && <ClassReturns returns={returns} allocation={allocation} range={range} />}
        {allocation && allocation.total > 0 && <RiskSection allocation={allocation} targets={data?.targets ?? null} />}

        <p className="stocks-footnote spend-page-note">
          Expected returns and volatility use long-run averages for each asset class, not a promise. Your return uses
          your actual gains for the period you pick, including dividends, from your brokerage transaction history and
          daily closing prices; money you added counts as invested for half the period.
          {returns && returns.missing > 0
            ? ` ${returns.missing} ${returns.missing === 1 ? "position isn't" : "positions aren't"} included (no market prices or history, e.g. some funds and 401(k) trusts).`
            : ""}
          {returns?.partial ? " Some history starts partway through the period, so only the covered part counts." : ""}
        </p>
      </div>
    </main>
  );
}

export default function RiskPage() {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <RiskView onSessionExpired={onSessionExpired} />;
}
