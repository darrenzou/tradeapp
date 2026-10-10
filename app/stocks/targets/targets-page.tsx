"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { errorMessage, formatMoney, isRecord, readJson } from "../../client-api";
import { setCachedResource } from "../../client-cache";
import { Icon, Skeleton } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import { useStocks } from "../use-stocks";
import {
  TARGET_CLASSES,
  TARGET_PRESETS,
  estimateRisk,
  parseAllocationTargets,
  stockPercent,
  targetShares,
  type AllocationTargets,
  type TargetClass,
} from "@/lib/allocation-targets";
import { ASSET_CLASSES, buildAllocation } from "@/lib/asset-classes";

const STEP = 5;
const SAVE_FAILED_MESSAGE = "Your targets couldn't be saved. Try again.";

const percent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

function wholeMoney(value: number): string {
  return formatMoney(Math.round(Math.abs(value))).replace(/\.00$/, "");
}

function signedPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? "same as now" : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)} vs now`;
}

function TargetsView({ onSessionExpired }: { onSessionExpired: () => void }) {
  const router = useRouter();
  const fromRisk = useSearchParams().get("from") === "risk";
  const backHref = fromRisk ? "/stocks/risk" : "/stocks/allocation";
  const { data, apiFetch } = useStocks(onSessionExpired);
  const saved = data?.targets ?? null;
  // Null until the user changes something; until then the saved targets
  // (or the Growth preset) show.
  const [draft, setDraft] = useState<AllocationTargets | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const targets = draft ?? saved ?? TARGET_PRESETS[2].targets;
  const total = TARGET_CLASSES.reduce((sum, id) => sum + targets[id], 0);
  const allocation = data ? buildAllocation(data.rows, data.cashValue, data.otherInvestmentsValue) : null;
  const nowShare = (id: TargetClass) => allocation?.classes.find((item) => item.id === id)?.share ?? 0;
  const nowShares = Object.fromEntries(allocation?.classes.map((item) => [item.id, item.share]) ?? []);
  const now = allocation ? estimateRisk(nowShares) : null;
  const planned = estimateRisk(targetShares(targets));
  const value = allocation?.total ?? 0;
  const badYearNow = now ? (now.badYear / 100) * value : 0;
  const badYearPlanned = (planned.badYear / 100) * value;
  const stocks = stockPercent(targets);
  const preset = TARGET_PRESETS.find((item) => TARGET_CLASSES.every((id) => item.targets[id] === targets[id]));

  function change(id: TargetClass, delta: number) {
    setError("");
    setDraft({ ...targets, [id]: Math.min(100, Math.max(0, targets[id] + delta)) });
  }

  async function save() {
    const valid = parseAllocationTargets(targets);

    if (valid === null) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await apiFetch("/api/allocation-targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(valid),
      });

      if (response === null) {
        return;
      }

      const body = await readJson(response);
      const stored = isRecord(body) ? parseAllocationTargets(body.targets) : null;

      if (!response.ok || stored === null) {
        setError(errorMessage(body, SAVE_FAILED_MESSAGE));
        return;
      }

      if (data) {
        setCachedResource("stocks", { ...data, targets: stored });
      }

      router.push(backHref);
    } catch {
      setError(SAVE_FAILED_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="dash-page hd-page">
      <div className="dash-content">
        <div className="hd-top">
          <Link href={backHref} className="hd-back">
            <Icon name="chevronLeft" size={18} strokeWidth={2.4} />
            {fromRisk ? "Risk & return" : "Allocation"}
          </Link>
          <button
            type="button"
            className="tg-reset"
            onClick={() => {
              setDraft(null);
              setError("");
            }}
            disabled={draft === null}
          >
            Reset
          </button>
        </div>

        <section className="dash-hero" aria-labelledby="targets-heading">
          <p className="dash-label">Set targets</p>
          <h1 id="targets-heading" className="tg-headline">
            {stocks}% stocks, {targets.bonds + targets.cash}% safer
          </h1>
          <p className="tg-intro">Pick a starting point, then fine-tune each class. Targets must add up to 100%.</p>
          <div className="tg-presets" role="group" aria-label="Starting points">
            {TARGET_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="tg-preset"
                aria-pressed={preset?.id === item.id}
                onClick={() => {
                  setDraft(item.targets);
                  setError("");
                }}
              >
                <b>{item.label}</b>
                <span>{stockPercent(item.targets)}% stocks</span>
              </button>
            ))}
          </div>

          <div className="tg-outlook" aria-live="polite">
            <div className="tg-outlook-head">
              <span className="tg-outlook-title">With these targets</span>
              <span className="tg-grade">{planned.grade} for the risk</span>
            </div>
            <dl className="tg-outlook-stats">
              <div>
                <dt>Expected</dt>
                <dd>
                  {planned.expectedReturn.toFixed(1)}% <small>/yr</small>
                </dd>
                <dd className="tg-outlook-note">{now ? signedPoints(planned.expectedReturn - now.expectedReturn) : "—"}</dd>
              </div>
              <div>
                <dt>Volatility</dt>
                <dd>{planned.volatility.toFixed(1)}%</dd>
                <dd className="tg-outlook-note">
                  {planned.level}
                  {now ? ` · ${signedPoints(planned.volatility - now.volatility).replace(" vs now", "")}` : ""}
                </dd>
              </div>
              <div>
                <dt>Bad year</dt>
                <dd>{allocation ? `${badYearPlanned < 0 ? "−" : "+"}${wholeMoney(badYearPlanned)}` : "—"}</dd>
                <dd className="tg-outlook-note">
                  {now && allocation
                    ? Math.round(badYearPlanned - badYearNow) === 0
                      ? "same as now"
                      : `${wholeMoney(badYearPlanned - badYearNow)} ${badYearPlanned > badYearNow ? "less" : "more"}`
                    : ""}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="dash-card sp-section tg-mix" aria-labelledby="mix-heading">
          <div className="dash-card-header">
            <h2 id="mix-heading" className="sp-card-title al-title">Your mix</h2>
            <span className="sp-card-note">Line = where you are now</span>
          </div>
          <ul>
            {TARGET_CLASSES.map((id) => {
              const info = ASSET_CLASSES.find((item) => item.id === id)!;
              const trade = (targets[id] / 100) * value - (allocation?.classes.find((item) => item.id === id)?.value ?? 0);

              return (
                <li key={id} className="tg-row">
                  <span className="sp-swatch" style={{ background: info.color }} aria-hidden="true" />
                  <span className="tg-row-main">
                    <span className="tg-row-name" id={`target-${id}`}>{info.label}</span>
                    <span className="tg-row-detail">
                      {allocation ? (
                        <>
                          Now {percent.format(nowShare(id))}
                          {Math.round(trade) === 0 ? "" : ` · ${trade > 0 ? "Buy" : "Sell"} ${wholeMoney(trade)}`}
                        </>
                      ) : (
                        <Skeleton width="120px" height="12px" />
                      )}
                    </span>
                  </span>
                  <span className="tg-stepper" role="group" aria-labelledby={`target-${id}`}>
                    <button
                      type="button"
                      aria-label={`${info.label} ${STEP}% less`}
                      onClick={() => change(id, -STEP)}
                      disabled={targets[id] === 0}
                    >
                      <Icon name="minus" size={18} strokeWidth={2.4} />
                    </button>
                    <output aria-live="polite">{targets[id]}%</output>
                    <button
                      type="button"
                      aria-label={`${info.label} ${STEP}% more`}
                      onClick={() => change(id, STEP)}
                      disabled={targets[id] === 100}
                    >
                      <Icon name="plus" size={18} strokeWidth={2.4} />
                    </button>
                  </span>
                  <span className="tg-track" aria-hidden="true">
                    <span className="tg-fill" style={{ width: `${targets[id]}%`, background: info.color }} />
                    {allocation && <span className="tg-now" style={{ left: `${Math.min(nowShare(id), 1) * 100}%` }} />}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className={`tg-total ${total === 100 ? "" : "tg-total-off"}`} role="status">
            <b>Total {total}%</b>
            <span>
              {total === 100 ? "Ready to save" : total < 100 ? `Add ${100 - total}% more` : `Take away ${total - 100}%`}
            </span>
          </p>
        </section>

        {error && (
          <p className="dash-issue" role="alert">
            {error}
          </p>
        )}

        <div className="tg-actions">
          <button
            type="button"
            className="pill-button pill-button-primary tg-save"
            onClick={() => void save()}
            disabled={saving || total !== 100}
          >
            {saving ? "Saving…" : "Save targets"}
          </button>
          <Link href={backHref} className="pill-button pill-button-soft tg-cancel">
            Cancel
          </Link>
        </div>

        <p className="stocks-footnote spend-page-note">
          Saving makes no trades. Buy and sell amounts show what it would take to reach your targets today; Allocation
          tracks your progress from here. Expected return, volatility and a bad year (one that happens about 1 year in
          20) use long-run averages for each asset class, not a promise.
        </p>
      </div>
    </main>
  );
}

export default function TargetsPage() {
  const { username, onSessionExpired } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <TargetsView onSessionExpired={onSessionExpired} />;
}
