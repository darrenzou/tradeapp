"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import AppHeader from "../../app-header";
import DetailDialog from "../../detail-dialog";
import { errorMessage, formatMoney, formatTime, isRecord, readJson, useApiFetch } from "../../client-api";
import { refreshResource, setCachedResource, useCachedResource } from "../../client-cache";
import { useSignedInUser } from "../../use-signed-in-user";
import { categoryColor, colorGroups, dateLabel, monthLabel, monthName, signedMoney, tone } from "../spending-format";
import {
  CATEGORY_CHOICES,
  TRANSFER_CHOICE,
  similarRuleKey,
  transactionRuleKey,
  type CategoryChoice,
  type CategoryRuleChange,
  type MonthTransaction,
} from "@/lib/cashflow";
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
  other: "Other income (no identified source)",
  transfer: "Transfer (not counted in spending or income)",
};

const percentFormatter = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// Money in shows as +$, money out as −$ (Plaid amounts are positive when
// money leaves an account).
function transactionAmount(transaction: { amount: number }): string {
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

type ApiFetch = ReturnType<typeof useApiFetch>;

type Scope = "transaction" | "similar";

const CHOICE_GROUPS: { group: CategoryChoice["group"]; label: string }[] = [
  { group: "transfer", label: "Not counted" },
  { group: "income", label: "Income" },
  { group: "spending", label: "Spending" },
];

// The other party without the reference numbers and dates that rules
// ignore: "Online Transfer to SAV ...5678 transaction#: 1111 09/12" reads
// "Online Transfer to SAV transaction".
function counterpartyLabel(name: string): string {
  const words = name
    .split(/\s+/)
    .filter((word) => !/\d/.test(word))
    .map((word) => word.replace(/[^\p{L}&']+$/u, ""))
    .filter((word) => word.length > 0);

  return words.length > 0 ? words.join(" ") : name;
}

// "Out of Checking ••1234 to Venmo" (Plaid amounts are positive when money
// leaves the account).
function flowLabel(transaction: { amount: number; accountName: string; name: string }): string {
  const other = counterpartyLabel(transaction.name);
  return transaction.amount > 0
    ? `Out of ${transaction.accountName} to ${other}`
    : `Into ${transaction.accountName} from ${other}`;
}

// The rules to save for a category picked for `transaction`, alone or for
// every transaction like it. Picking for all like it also clears a choice
// made for this one alone, so the new rule applies to it too.
function ruleChanges(
  transaction: { id: string; similarKey: string },
  scope: Scope,
  category: string,
): CategoryRuleChange[] {
  return scope === "transaction"
    ? [{ key: transactionRuleKey(transaction.id), category }]
    : [
        { key: similarRuleKey(transaction.similarKey), category },
        { key: transactionRuleKey(transaction.id), category: null },
      ];
}

function TransactionDialog({
  transaction,
  month,
  apiFetch,
  onSaved,
  onClose,
}: {
  transaction: MonthTransaction;
  month: string;
  apiFetch: ApiFetch;
  onSaved: (data: SpendingMonthData) => void;
  onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  // A pending transaction's id changes when it posts, so a choice for it
  // alone wouldn't last.
  const [scope, setScope] = useState<Scope>("similar");
  const [includeCounterpart, setIncludeCounterpart] = useState(true);
  // The choice being saved ("reset" for going back to the automatic one).
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");
  const counterpart = transaction.counterpart;

  async function save(changes: CategoryRuleChange[], savingId: string) {
    setSaving(savingId);
    setSaveError("");

    try {
      const response = await apiFetch(`/api/spending/${encodeURIComponent(month)}/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });

      if (response === null) {
        return;
      }

      const body = await readJson(response);

      if (!response.ok || !isRecord(body)) {
        setSaveError(errorMessage(body, "The category couldn't be saved. Try again."));
        return;
      }

      onSaved(body as SpendingMonthData);
      setPicking(false);
    } catch {
      setSaveError("The category couldn't be saved. Try again.");
    } finally {
      setSaving(null);
    }
  }

  function pick(category: string) {
    const changes = ruleChanges(transaction, scope, category);

    if (category === TRANSFER_CHOICE && counterpart !== null && includeCounterpart) {
      changes.push(...ruleChanges(counterpart, scope, category));
    }

    void save(changes, category);
  }

  function resetCategory() {
    void save(
      [
        {
          key:
            transaction.setBy === "similar"
              ? similarRuleKey(transaction.similarKey)
              : transactionRuleKey(transaction.id),
          category: null,
        },
      ],
      "reset",
    );
  }

  const status = saveError && (
    <p className="spend-picker-error" role="alert">
      {saveError}
    </p>
  );

  if (picking) {
    return (
      <DetailDialog title={transaction.name} subtitle={transaction.accountName} onClose={onClose}>
        <button type="button" className="dash-link-button spend-picker-back" onClick={() => setPicking(false)}>
          ‹ Back
        </button>
        <fieldset className="spend-scope" disabled={saving !== null}>
          <legend>Change the category of</legend>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scope === "similar"}
              onChange={() => setScope("similar")}
            />
            <span>
              <strong>All transactions like this</strong>
              <span className="detail-name">{flowLabel(transaction)}, past and future</span>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              checked={scope === "transaction"}
              onChange={() => setScope("transaction")}
              disabled={transaction.pending}
            />
            <span>
              <strong>Just this one</strong>
              <span className="detail-name">
                {transaction.pending
                  ? "Available once it posts"
                  : `${transactionAmount(transaction)} on ${dateLabel(transaction.date)}`}
              </span>
            </span>
          </label>
          {counterpart && (
            <label className="spend-scope-counterpart">
              <input
                type="checkbox"
                checked={includeCounterpart}
                onChange={(event) => setIncludeCounterpart(event.target.checked)}
              />
              <span>
                When marking a transfer, also mark the other side
                <span className="detail-name">
                  {transactionAmount(counterpart)} {counterpart.amount < 0 ? "into" : "from"} {counterpart.accountName}{" "}
                  on {dateLabel(counterpart.date)}
                  {scope === "similar" ? ", and all like it" : ""}
                </span>
              </span>
            </label>
          )}
        </fieldset>
        {status}
        {CHOICE_GROUPS.map(({ group, label }) => (
          <section key={group} className="spend-picker-group" aria-label={label}>
            <h3 className="spend-day">{label}</h3>
            <ul className="spend-rows">
              {CATEGORY_CHOICES.filter((choice) => choice.group === group).map((choice) => {
                const current = choice.label === transaction.category;

                return (
                  <li key={choice.id}>
                    <button
                      type="button"
                      onClick={() => pick(choice.id)}
                      disabled={saving !== null}
                      aria-current={current ? "true" : undefined}
                    >
                      <span
                        className="spend-swatch"
                        style={{ background: group === "spending" ? categoryColor(choice.label) : "transparent" }}
                        aria-hidden="true"
                      />
                      <span className="spend-row-name">{choice.label}</span>
                      <span className="spend-row-value">
                        {saving === choice.id ? "Saving…" : current ? <span aria-label="Current">✓</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </DetailDialog>
    );
  }

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
            {transaction.setBy !== null ? (
              <span className="detail-name">
                {transaction.setBy === "similar" ? "You set this for all transactions like it" : "You set this for this transaction"}
              </span>
            ) : (
              transaction.detail &&
              transaction.detail !== transaction.category && <span className="detail-name">{transaction.detail}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{transaction.accountName}</dd>
        </div>
        <div>
          <dt>Plaid category</dt>
          <dd className="spend-code">
            {transaction.fromBrokerage ? "From brokerage history" : transaction.plaidCategory ?? "None"}
          </dd>
        </div>
        <div>
          <dt>Counted as</dt>
          <dd>{transaction.pending ? "Pending (not counted until it posts)" : KIND_LABELS[transaction.kind]}</dd>
        </div>
      </dl>
      {status}
      <div className="spend-dialog-actions">
        <button
          type="button"
          className="spend-primary-button"
          onClick={() => {
            setSaveError("");
            setScope("similar");
            setPicking(true);
          }}
          disabled={saving !== null}
        >
          Change category
        </button>
        {transaction.setBy !== null && (
          <button type="button" className="dash-link-button" onClick={resetCategory} disabled={saving !== null}>
            {saving === "reset"
              ? "Saving…"
              : transaction.setBy === "similar"
                ? "Use the automatic category for all like it"
                : "Use the automatic category"}
          </button>
        )}
      </div>
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
  // Same measure as the yearly page: income (other income included) less
  // spending. Stock appreciation is shown but not counted.
  const moneyIn = data ? data.totals.income + data.totals.other : 0;
  const net = data ? moneyIn - data.totals.spending : 0;

  function showCategory(category: string) {
    setCategoryFilter(category);
    setTab("transactions");
  }

  return (
    <main className="dash-page spend-page">
      <AppHeader
        username={username}
        active="spending"
        busy={isSigningOut}
        onSignOut={onSignOut}
        onSessionExpired={onSessionExpired}
        alsoRefresh={key}
      />

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
                  <dd>
                    {formatMoney(moneyIn)}
                    {data.totals.other !== 0 && (
                      <span className="stocks-stat-caption">Includes {formatMoney(data.totals.other)} other</span>
                    )}
                  </dd>
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

      {openTransaction && (
        <TransactionDialog
          transaction={openTransaction}
          month={month}
          apiFetch={apiFetch}
          onSaved={(saved) => setCachedResource(key, saved)}
          onClose={() => setOpenTransactionId(null)}
        />
      )}
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
