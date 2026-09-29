"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import AppHeader from "../../app-header";
import DetailDialog from "../../detail-dialog";
import { formatMoney, formatTime, useApiFetch } from "../../client-api";
import { refreshResource, useCachedResource } from "../../client-cache";
import { useSignedInUser } from "../../use-signed-in-user";
import { categoryColor, colorGroups, dateLabel, monthLabel, monthName, signedMoney, tone } from "../spending-format";
import type { MonthTransaction } from "@/lib/cashflow";
import type { SpendingMonthData } from "@/lib/spending";

type Tab = "transactions" | "categories" | "merchants";

const TABS: { id: Tab; label: string }[] = [
  { id: "categories", label: "Categories" },
  { id: "transactions", label: "Transactions" },
  { id: "merchants", label: "Merchants" },
];

const KIND_LABELS: Record<MonthTransaction["kind"], string> = {
  spending: "Spending",
  income: "Income",
  gift: "Gift",
  transfer: "Transfer between your accounts (not counted)",
};

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// Money in shows as +$, money out as −$ (Plaid amounts are positive when
// money leaves an account).
function transactionAmount(transaction: MonthTransaction): string {
  return signedMoney(-transaction.amount);
}

type Segment = { name: string; amount: number; color: string };

const RING_SIZE = 200;
const RING_STROKE = 26;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2 - 4;
const RING_GAP = 2;

function CategoryRing({
  segments,
  total,
  month,
  selected,
  onSelect,
}: {
  segments: Segment[];
  total: number;
  month: string;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const circumference = 2 * Math.PI * RING_RADIUS;
  const current = segments[selected];
  // Where each segment starts along the ring.
  const starts = segments.map((_, index) =>
    segments.slice(0, index).reduce((sum, segment) => sum + (segment.amount / total) * circumference, 0),
  );

  return (
    <div className="spend-ring">
      <button
        type="button"
        className="spend-ring-step"
        onClick={() => onSelect((selected - 1 + segments.length) % segments.length)}
        disabled={segments.length < 2}
        aria-label="Previous category"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <div className="spend-ring-figure">
        <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="img" aria-label="Spending by category">
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="#edf2ee"
            strokeWidth={RING_STROKE}
          />
          {segments.map((segment, index) => {
            const length = (segment.amount / total) * circumference;
            const dash = Math.max(0, length - (segments.length > 1 ? RING_GAP : 0));
            const start = starts[index];

            return (
              <circle
                key={segment.name}
                className="spend-ring-segment"
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke={segment.color}
                strokeWidth={index === selected ? RING_STROKE + 6 : RING_STROKE}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-start}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                onClick={() => onSelect(index)}
              >
                <title>{`${segment.name}: ${formatMoney(segment.amount)}`}</title>
              </circle>
            );
          })}
        </svg>
        {current && (
          <div className="spend-ring-center" aria-live="polite">
            <span className="spend-ring-name">{current.name}</span>
            <span className="spend-ring-value">{formatMoney(current.amount)}</span>
            <span className="spend-ring-share">
              {percentFormatter.format(current.amount / total)} of {monthName(month)} spending
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        className="spend-ring-step"
        onClick={() => onSelect((selected + 1) % segments.length)}
        disabled={segments.length < 2}
        aria-label="Next category"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

function TransactionDialog({ transaction, onClose }: { transaction: MonthTransaction; onClose: () => void }) {
  return (
    <DetailDialog title={transaction.name} subtitle={transaction.accountName} onClose={onClose}>
      <div className="detail-summary">
        <p className={`detail-summary-value ${transaction.amount < 0 ? "stocks-up" : ""}`}>
          {transactionAmount(transaction)}
        </p>
        <p className="detail-summary-caption">{dateLabel(transaction.date, "long")}</p>
      </div>
      <dl className="spend-facts">
        <div>
          <dt>Description</dt>
          <dd>{transaction.name}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{dateLabel(transaction.date, "long")}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>
            <span className="spend-swatch" style={{ background: categoryColor(transaction.category) }} aria-hidden="true" />
            {transaction.category}
            {transaction.detail && transaction.detail !== transaction.category && (
              <span className="detail-name">{transaction.detail}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{transaction.accountName}</dd>
        </div>
        <div>
          <dt>Counted as</dt>
          <dd>{transaction.pending ? "Pending (not counted until it posts)" : KIND_LABELS[transaction.kind]}</dd>
        </div>
      </dl>
    </DetailDialog>
  );
}

function TransactionList({
  transactions,
  onSelect,
}: {
  transactions: MonthTransaction[];
  onSelect: (transaction: MonthTransaction) => void;
}) {
  const byDate = new Map<string, MonthTransaction[]>();

  for (const transaction of transactions) {
    const list = byDate.get(transaction.date) ?? [];
    list.push(transaction);
    byDate.set(transaction.date, list);
  }

  return (
    <div className="spend-days">
      {[...byDate.entries()].map(([date, list]) => (
        <section key={date} aria-label={dateLabel(date)}>
          <h3 className="spend-day">{dateLabel(date, "long")}</h3>
          <ul className="spend-transactions">
            {list.map((transaction) => (
              <li key={transaction.id}>
                <button
                  type="button"
                  className={`spend-transaction ${transaction.kind === "transfer" ? "spend-transfer" : ""}`}
                  onClick={() => onSelect(transaction)}
                  aria-haspopup="dialog"
                >
                  <span
                    className="spend-swatch"
                    style={{ background: transaction.kind === "spending" ? categoryColor(transaction.category) : "transparent" }}
                    aria-hidden="true"
                  />
                  <span className="spend-transaction-main">
                    <span className="spend-transaction-name">{transaction.name}</span>
                    <span className="detail-name">
                      {transaction.category}
                      {transaction.pending ? " · Pending" : ""} · {transaction.accountName}
                    </span>
                  </span>
                  <span className={`spend-transaction-amount ${transaction.amount < 0 && transaction.kind !== "transfer" ? "stocks-up" : ""}`}>
                    {transactionAmount(transaction)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MonthView({
  month,
  username,
  isSigningOut,
  onSignOut,
  onSessionExpired,
}: {
  month: string;
  username: string;
  isSigningOut: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
}) {
  const key = `spending-month:${month}` as const;
  const { entry, showUpdating } = useCachedResource<SpendingMonthData>(key);
  const data = entry?.data ?? null;
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("categories");
  // Null until the user picks one: the largest category is shown first.
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [openTransactionId, setOpenTransactionId] = useState<string | null>(null);
  const apiFetch = useApiFetch(onSessionExpired);

  const load = useCallback(async () => {
    try {
      await refreshResource(key, apiFetch);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Transactions couldn't be loaded. Try again.");
    }
  }, [apiFetch, key]);

  useEffect(() => {
    async function loadInitial() {
      await load();
    }

    void loadInitial();
  }, [load]);

  const segments = useMemo(() => (data ? colorGroups(data.totals.categories) : []), [data]);
  const ringTotal = segments.reduce((total, segment) => total + segment.amount, 0);
  const largestSegment = segments.reduce((best, segment, index) => (segment.amount > segments[best].amount ? index : best), 0);
  const categories = useMemo(
    () =>
      data
        ? Object.entries(data.totals.categories)
            .filter(([, amount]) => amount !== 0)
            .sort((a, b) => b[1] - a[1])
        : [],
    [data],
  );
  const merchants = useMemo(() => {
    const totals = new Map<string, { amount: number; count: number }>();

    for (const transaction of data?.transactions ?? []) {
      if (transaction.kind !== "spending" || transaction.pending) {
        continue;
      }

      const merchant = totals.get(transaction.name) ?? { amount: 0, count: 0 };
      merchant.amount += transaction.amount;
      merchant.count += 1;
      totals.set(transaction.name, merchant);
    }

    return [...totals.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [data]);

  const transactions = (data?.transactions ?? []).filter(
    (transaction) => categoryFilter === null || transaction.category === categoryFilter,
  );
  const openTransaction = data?.transactions.find((transaction) => transaction.id === openTransactionId);
  const earliest = data?.coverage.earliest ?? null;
  const hasData = earliest !== null && month >= earliest.slice(0, 7);
  const stocks = data?.stockAppreciation?.amount ?? null;
  // Same measure as the yearly page: income, gifts, and stock appreciation
  // less spending.
  const net = data ? data.totals.income + data.totals.gifts + (stocks ?? 0) - data.totals.spending : 0;

  function showCategory(category: string) {
    setCategoryFilter(category);
    setTab("transactions");
  }

  return (
    <main className="dash-page spend-page">
      <AppHeader username={username} active="spending" busy={isSigningOut} onSignOut={onSignOut} />

      <div className="dash-content">
        <div className="spend-toolbar">
          <Link href="/spending" className="dash-link-button spend-back">
            ‹ All spending
          </Link>
          <div className="spend-stepper">
            {data?.previousMonth ? (
              <Link href={`/spending/${data.previousMonth}`} aria-label={`${monthLabel(data.previousMonth)}`}>
                <span aria-hidden="true">‹</span>
              </Link>
            ) : (
              <span className="spend-stepper-disabled" aria-hidden="true">‹</span>
            )}
            <span className="spend-stepper-label">{monthLabel(month)}</span>
            {data?.nextMonth ? (
              <Link href={`/spending/${data.nextMonth}`} aria-label={`${monthLabel(data.nextMonth)}`}>
                <span aria-hidden="true">›</span>
              </Link>
            ) : (
              <span className="spend-stepper-disabled" aria-hidden="true">›</span>
            )}
          </div>
        </div>

        {loadError && (
          <p className="dash-message" role="status" aria-live="polite">
            {entry
              ? `Couldn't refresh these transactions. Showing data from ${formatTime(new Date(entry.fetchedAt).toISOString())}.`
              : loadError}
          </p>
        )}
        {data?.issues.map((issue) => (
          <p key={issue} className="dash-issue">{issue}</p>
        ))}
        {data && !hasData && (
          <p className="dash-issue">
            Plaid hasn&apos;t shared any transactions from {monthLabel(month)}.
            {earliest && ` Your history starts in ${monthLabel(earliest.slice(0, 7))}.`}
          </p>
        )}

        <section className="dash-card spend-month-card" aria-labelledby="month-title">
          <div className="dash-card-header">
            <h1 id="month-title" className="dash-label">
              {monthLabel(month)} spending
              <span className="dash-updating" aria-live="polite">{showUpdating ? " · Updating…" : ""}</span>
            </h1>
          </div>

          {data === null ? (
            <p className="dash-empty">{loadError ? "—" : "Loading…"}</p>
          ) : (
            <div className="spend-month-summary">
              {segments.length > 0 ? (
                <CategoryRing
                  segments={segments}
                  total={ringTotal}
                  month={month}
                  selected={Math.min(selectedSegment ?? largestSegment, segments.length - 1)}
                  onSelect={setSelectedSegment}
                />
              ) : (
                <p className="dash-empty">No spending this month.</p>
              )}
              <dl className="spend-month-stats">
                <div>
                  <dt>Spent</dt>
                  <dd>{formatMoney(data.totals.spending)}</dd>
                </div>
                <div>
                  <dt>Income</dt>
                  <dd>{formatMoney(data.totals.income)}</dd>
                </div>
                <div>
                  <dt>Gifts</dt>
                  <dd>{formatMoney(data.totals.gifts)}</dd>
                </div>
                <div>
                  <dt>Stock appreciation</dt>
                  <dd className={tone(stocks)} title={data.stockAppreciation?.note ?? undefined}>
                    {stocks === null ? "—" : signedMoney(stocks)}
                  </dd>
                </div>
                <div className="spend-month-total">
                  <dt>Net gain</dt>
                  <dd className={tone(net)}>{signedMoney(net)}</dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        {data && (
          <section className="dash-card" aria-label="Transactions, categories, and merchants">
            <div className="spend-tabs" role="tablist" aria-label="View">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls={`panel-${item.id}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === "transactions" && (
                <>
                  {categoryFilter && (
                    <button type="button" className="spend-chip" onClick={() => setCategoryFilter(null)}>
                      {categoryFilter} <span aria-hidden="true">×</span>
                      <span className="stocks-sr-only"> (show all)</span>
                    </button>
                  )}
                  {transactions.length === 0 ? (
                    <p className="dash-empty">No transactions.</p>
                  ) : (
                    <TransactionList transactions={transactions} onSelect={(transaction) => setOpenTransactionId(transaction.id)} />
                  )}
                </>
              )}

              {tab === "categories" &&
                (categories.length === 0 ? (
                  <p className="dash-empty">No spending this month.</p>
                ) : (
                  <ul className="spend-rows">
                    {categories.map(([category, amount]) => (
                      <li key={category}>
                        <button type="button" onClick={() => showCategory(category)}>
                          <span className="spend-swatch" style={{ background: categoryColor(category) }} aria-hidden="true" />
                          <span className="spend-row-name">{category}</span>
                          <span className="spend-row-value">
                            {formatMoney(amount)}
                            <span>{data.totals.spending > 0 && amount > 0 ? percentFormatter.format(amount / data.totals.spending) : ""}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ))}

              {tab === "merchants" &&
                (merchants.length === 0 ? (
                  <p className="dash-empty">No spending this month.</p>
                ) : (
                  <ul className="spend-rows">
                    {merchants.map(([name, merchant]) => (
                      <li key={name}>
                        <div>
                          <span className="spend-row-name">
                            {name}
                            <span className="detail-name">
                              {merchant.count} {merchant.count === 1 ? "purchase" : "purchases"}
                            </span>
                          </span>
                          <span className="spend-row-value">{formatMoney(merchant.amount)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          </section>
        )}
      </div>

      {openTransaction && <TransactionDialog transaction={openTransaction} onClose={() => setOpenTransactionId(null)} />}
    </main>
  );
}

export default function MonthPage({ month }: { month: string }) {
  const { username, ...session } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  // Keyed by month so paging between months starts each one fresh.
  return <MonthView key={month} month={month} username={username} {...session} />;
}
