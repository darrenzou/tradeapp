"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import AppHeader from "../../app-header";
import DetailDialog from "../../detail-dialog";
import { errorMessage, formatMoney, formatTime, isRecord, readJson, useApiFetch } from "../../client-api";
import { prefetchResource, refreshResource, setCachedResource, useCachedResource } from "../../client-cache";
import { CATEGORY_ICONS, HeroAmount, Icon, Skeleton, UpdatedNote, type IconName } from "../../theme-ui";
import { useSignedInUser } from "../../use-signed-in-user";
import {
  MONTH_RANK_COLORS,
  categoryColor,
  counterpartyLabel,
  dateLabel,
  monthLabel,
  monthName,
  signedMoney,
  wholeMoney,
} from "../spending-format";
import { CategoryBreakdown, PeriodBar, SummaryTiles, rankCategories } from "../spending-ui";
import {
  CATEGORY_CHOICES,
  OTHER_INCOME_LABEL,
  TRANSFER_CHOICE,
  monthRange,
  similarRuleKey,
  transactionRuleKey,
  type CategoryChoice,
  type CategoryRuleChange,
  type MonthTransaction,
} from "@/lib/cashflow";
import type { SpendingData, SpendingMonthData } from "@/lib/spending";

type Tab = "spending" | "income" | "transactions";

const TABS: { id: Tab; label: string }[] = [
  { id: "spending", label: "Spending" },
  { id: "income", label: "Income" },
  { id: "transactions", label: "Transactions" },
];

type Filter = "all" | "spending" | "income" | "transfers";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "spending", label: "Spending" },
  { id: "income", label: "Income" },
  { id: "transfers", label: "Transfers" },
];

const COUNTED_LABELS: Record<MonthTransaction["kind"], string> = {
  spending: "Spending",
  income: "Income",
  other: "Other income",
  transfer: "Not counted",
};

// Income sources by size, in greens.
const SOURCE_COLORS = ["#4c7a1e", "#b9d97a", "#7fa83a", "#6fb0a8", "#9fcbc6"];

// Transactions listed at a time; "Show earlier" adds as many again.
const PAGE_SIZE = 25;

// Money in shows as +$, money out as −$ (Plaid amounts are positive when
// money leaves an account).
function transactionAmount(transaction: { amount: number }): string {
  return signedMoney(-transaction.amount);
}

// In lists, purchases show without a sign, money in with a +, and
// transfers in grey since they aren't counted.
function rowAmount(transaction: MonthTransaction): { text: string; className: string } {
  if (transaction.kind === "transfer") {
    return { text: formatMoney(Math.abs(transaction.amount)), className: "sp-muted" };
  }

  return transaction.amount < 0
    ? { text: `+${formatMoney(-transaction.amount)}`, className: "sp-in" }
    : { text: formatMoney(transaction.amount), className: "" };
}

// "Jul 1"
function shortDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// "Tue, Jul 28"
function dayHeading(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// "July 18, 2026"
function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// What a deposit is, singular: "Paycheck", "Dividend", "Other income".
function sourceLabel(category: string): string {
  return category === "Paychecks" ? "Paycheck" : category === "Dividends" ? "Dividend" : category;
}

function transactionIcon(transaction: MonthTransaction): IconName {
  if (transaction.kind === "transfer") {
    return "swap";
  }

  if (transaction.kind !== "spending") {
    return "cash";
  }

  return CATEGORY_ICONS[transaction.category] ?? "receipt";
}

function matchesFilter(transaction: MonthTransaction, filter: Filter): boolean {
  switch (filter) {
    case "spending":
      return transaction.kind === "spending";
    case "income":
      return transaction.kind === "income" || transaction.kind === "other";
    case "transfers":
      return transaction.kind === "transfer";
    default:
      return true;
  }
}

function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] ?? "th";
  return `${value}${suffix}`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

// "a, b, and c"
function listJoin(parts: string[]): string {
  return parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

type ApiFetch = ReturnType<typeof useApiFetch>;

type Scope = "transaction" | "similar";

const CHOICE_GROUPS: { group: CategoryChoice["group"]; label: string }[] = [
  { group: "transfer", label: "Not counted" },
  { group: "income", label: "Income" },
  { group: "spending", label: "Spending" },
];

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

  const detail =
    transaction.setBy === "similar"
      ? "You set this for all like it"
      : transaction.setBy === "transaction"
        ? "You set this for this one"
        : transaction.detail !== transaction.category
          ? transaction.detail
          : null;

  return (
    <DetailDialog
      title={transaction.name}
      subtitle={longDate(transaction.date)}
      onClose={onClose}
      action={
        <button
          type="button"
          className="pill-button sp-edit-button"
          onClick={() => {
            setSaveError("");
            setScope("similar");
            setPicking(true);
          }}
          disabled={saving !== null}
          aria-label="Edit category"
        >
          <Icon name="pencil" size={15} strokeWidth={2.2} />
          Edit
        </button>
      }
    >
      <p className={`sp-sheet-amount ${transaction.amount < 0 && transaction.kind !== "transfer" ? "sp-in" : ""}`}>
        {transactionAmount(transaction)}
      </p>
      <dl className="sp-facts">
        <div>
          <dt>Category</dt>
          <dd className="sp-facts-category">
            <span className="sp-facts-icon" aria-hidden="true">
              <Icon name={transactionIcon(transaction)} size={18} strokeWidth={2} />
            </span>
            <span className="sp-facts-stack">
              <span>{transaction.kind === "transfer" ? "Transfer" : transaction.category}</span>
              {detail && <span className="sp-facts-detail">{detail}</span>}
            </span>
          </dd>
        </div>
        <div>
          <dt>Counted as</dt>
          <dd>{transaction.pending ? "Pending, not yet counted" : COUNTED_LABELS[transaction.kind]}</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{transaction.accountName}</dd>
        </div>
        <div>
          <dt>Description</dt>
          <dd>{transaction.name}</dd>
        </div>
      </dl>
      {status}
      {transaction.setBy !== null && (
        <button type="button" className="dash-link-button sp-sheet-reset" onClick={resetCategory} disabled={saving !== null}>
          {saving === "reset"
            ? "Saving…"
            : transaction.setBy === "similar"
              ? "Use the automatic category for all like it"
              : "Use the automatic category"}
        </button>
      )}
    </DetailDialog>
  );
}

// One row of a transaction list: name, a second line, and the amount.
function TransactionRow({
  transaction,
  detail,
  onSelect,
}: {
  transaction: MonthTransaction;
  detail: string;
  onSelect: (transaction: MonthTransaction) => void;
}) {
  const amount = rowAmount(transaction);

  return (
    <li>
      <button type="button" className="sp-list-row" onClick={() => onSelect(transaction)} aria-haspopup="dialog">
        <span className="sp-list-main">
          <span className="sp-list-name">{transaction.name}</span>
          <span className="sp-list-detail">{detail}</span>
        </span>
        <span className={`sp-list-amount ${amount.className}`}>{amount.text}</span>
      </button>
    </li>
  );
}

// "Food & drink · Amex Gold ••1008", or "Not counted · …" for a transfer.
function listDetail(transaction: MonthTransaction): string {
  const kind = transaction.kind === "transfer" ? "Not counted" : sourceLabel(transaction.category);
  return `${transaction.pending ? "Pending · " : ""}${kind} · ${transaction.accountName}`;
}

function TransactionDays({
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
    <div className="sp-days">
      {[...byDate.entries()].map(([date, list]) => (
        <section key={date} aria-label={dateLabel(date, "long")}>
          <h3 className="sp-day">{dayHeading(date)}</h3>
          <ul className="sp-list">
            {list.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                detail={listDetail(transaction)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LoadingCard() {
  return (
    <section className="dash-card sp-section" aria-hidden="true">
      <div className="dash-card-header">
        <Skeleton width="40%" height="22px" />
        <Skeleton width="24%" height="18px" />
      </div>
      <Skeleton width="100%" height="14px" className="sp-loading-stack" />
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="sp-loading-row">
          <Skeleton width={`${56 - row * 8}%`} height="14px" />
          <Skeleton width="22%" height="14px" />
        </div>
      ))}
    </section>
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
  // The yearly data, for the period bar and how this month compares.
  const { entry: yearEntry } = useCachedResource<SpendingData>("spending");
  const data = entry?.data ?? null;
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("spending");
  const [filter, setFilter] = useState<Filter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
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
    prefetchResource("spending", apiFetch);
  }, [apiFetch, load]);

  const yearKey = month.slice(0, 4);
  const year = useMemo(() => {
    const spending = yearEntry?.data;

    if (spending === undefined) {
      return null;
    }

    const thisMonth = spending.today.slice(0, 7);
    const firstDataMonth = spending.coverage.earliest?.slice(0, 7) ?? null;
    const inYear = spending.months.filter((totals) => totals.month.startsWith(yearKey) && totals.month <= thisMonth);
    const dataMonths = inYear.filter((totals) => firstDataMonth !== null && totals.month >= firstDataMonth);
    const ranked = dataMonths
      .map((totals) => ({ month: totals.month, net: totals.income + totals.other + totals.dividends - totals.spending }))
      .sort((a, b) => b.net - a.net);
    // Finished months other than this one, for "under your average".
    const others = dataMonths.filter((totals) => totals.month !== month && totals.month !== thisMonth);

    return {
      years: spending.years.map((row) => row.year),
      periodMonths: inYear.map((totals) => ({
        month: totals.month,
        hasData: firstDataMonth !== null && totals.month >= firstDataMonth,
      })),
      rank: ranked.findIndex((row) => row.month === month) + 1,
      monthCount: ranked.length,
      averageSpending:
        others.length > 0 ? others.reduce((total, totals) => total + totals.spending, 0) / others.length : null,
      inProgress: month === thisMonth,
    };
  }, [month, yearEntry, yearKey]);

  const transactions = useMemo(() => data?.transactions ?? [], [data]);
  const openTransaction = transactions.find((transaction) => transaction.id === openTransactionId);
  const earliest = data?.coverage.earliest ?? null;
  const hasData = earliest !== null && month >= earliest.slice(0, 7);
  const stocks = data?.stockAppreciation?.amount ?? null;
  // Same measure as the yearly page: everything that came in, less
  // spending. Stock gains are shown but not counted.
  const incomeTotal = data ? data.totals.income + data.totals.other + data.totals.dividends : 0;
  const net = data ? incomeTotal - data.totals.spending : 0;
  const posted = transactions.filter((transaction) => !transaction.pending);
  const purchases = posted.filter((transaction) => transaction.kind === "spending");
  const deposits = posted.filter((transaction) => transaction.kind === "income" || transaction.kind === "other");
  const interestAndDividends = deposits
    .filter((transaction) => transaction.category === "Interest" || transaction.category === "Dividends")
    .reduce((total, transaction) => total - transaction.amount, 0);
  const largest = [...purchases].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const categoryShares = data
    ? rankCategories(
        Object.entries(data.totals.categories).sort((a, b) => b[1] - a[1]),
        MONTH_RANK_COLORS,
      )
    : [];
  const sourceTotals = new Map<string, number>();

  for (const deposit of deposits) {
    const source = deposit.category === OTHER_INCOME_LABEL ? "Other" : deposit.category;
    sourceTotals.set(source, (sourceTotals.get(source) ?? 0) - deposit.amount);
  }

  const sourceShares = rankCategories([...sourceTotals.entries()].sort((a, b) => b[1] - a[1]), SOURCE_COLORS);

  const search = query.trim().toLowerCase();
  const filtered = transactions.filter(
    (transaction) =>
      matchesFilter(transaction, filter) &&
      (categoryFilter === null || (transaction.kind === "spending" && transaction.category === categoryFilter)) &&
      (search === "" ||
        `${transaction.name} ${transaction.category} ${transaction.accountName}`.toLowerCase().includes(search)),
  );
  const transfers = posted.filter((transaction) => transaction.kind === "transfer").length;
  const pending = transactions.length - posted.length;
  const otherDeposits = deposits.filter((transaction) => transaction.kind === "other").length;
  const countNote = listJoin(
    [
      count(purchases.length, "purchase"),
      deposits.length - otherDeposits > 0 && `${count(deposits.length - otherDeposits, "deposit")} counted as income`,
      otherDeposits > 0 && `${count(otherDeposits, "deposit")} with no identified source`,
      transfers > 0 && `${count(transfers, "transfer")} between your own accounts or card payments`,
    ].filter((part): part is string => typeof part === "string"),
  );

  let rankNote: string | null = null;

  if (year && !year.inProgress && year.rank > 0 && year.monthCount > 1) {
    rankNote =
      year.rank === 1
        ? "Best month this year"
        : year.rank === year.monthCount
          ? "Lowest month this year"
          : `${ordinal(year.rank)} best of ${year.monthCount} months`;
  }

  function changeFilter(next: Filter) {
    setFilter(next);
    setShown(PAGE_SIZE);
  }

  function showCategory(category: string) {
    setCategoryFilter(category);
    setFilter("all");
    setQuery("");
    setShown(PAGE_SIZE);
    setTab("transactions");
  }

  function showPurchases() {
    setCategoryFilter(null);
    setFilter("spending");
    setQuery("");
    setShown(PAGE_SIZE);
    setTab("transactions");
  }

  const isLoading = data === null && !loadError;
  const openSheet = (transaction: MonthTransaction) => setOpenTransactionId(transaction.id);

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
        <PeriodBar
          years={year?.years ?? [Number(yearKey)]}
          year={Number(yearKey)}
          months={year?.periodMonths ?? monthRange(`${yearKey}-01`, month).map((item) => ({ month: item, hasData: true }))}
          selectedMonth={month}
        />

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

        <section className="dash-hero" aria-labelledby="month-heading" aria-busy={isLoading}>
          <div className="dash-hero-top">
            <h1 id="month-heading" className="dash-label">
              Saved in {monthLabel(month)}
              {year?.inProgress ? " so far" : ""}
            </h1>
            {showUpdating || isLoading ? (
              <UpdatedNote fetchedAt={entry?.fetchedAt ?? null} updating />
            ) : (
              rankNote && <span className="hero-updated">{rankNote}</span>
            )}
          </div>
          <p className="dash-hero-value">
            {data ? (
              hasData ? <HeroAmount value={net} signed /> : "No data"
            ) : loadError ? (
              "—"
            ) : (
              <Skeleton width="62%" height="44px" />
            )}
          </p>
          {data && hasData && stocks !== null && stocks !== 0 && (
            <p className="sp-hero-aside" title={data.stockAppreciation?.note ?? undefined}>
              Stocks {signedMoney(stocks)} this month, not counted
            </p>
          )}
        </section>

        {(isLoading || (data && hasData)) && (
          <SummaryTiles
            income={data ? formatMoney(incomeTotal) : <Skeleton width="80%" height="20px" />}
            incomeNote={
              data ? (
                data.totals.other > 0 ? (
                  `Incl. ${wholeMoney(data.totals.other)} other`
                ) : interestAndDividends > 0 ? (
                  `Incl. ${wholeMoney(interestAndDividends)} interest & dividends`
                ) : (
                  ""
                )
              ) : (
                <Skeleton width="60%" height="10px" />
              )
            }
            spent={data ? formatMoney(data.totals.spending) : <Skeleton width="80%" height="20px" />}
            spentNote={
              data ? (
                year?.inProgress ? (
                  "So far this month"
                ) : year?.averageSpending != null ? (
                  `${wholeMoney(Math.abs(data.totals.spending - year.averageSpending))} ${
                    data.totals.spending <= year.averageSpending ? "under" : "over"
                  } your average`
                ) : (
                  ""
                )
              ) : (
                <Skeleton width="60%" height="10px" />
              )
            }
          />
        )}

        <div className="sp-tabs" role="tablist" aria-label="View">
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

        {data === null ? (
          isLoading && <LoadingCard />
        ) : (
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="sp-panel">
            {tab === "spending" && (
              <>
                <section className="dash-card sp-section" aria-labelledby="by-category-heading">
                  <div className="dash-card-header">
                    <h2 id="by-category-heading" className="sp-card-title">By category</h2>
                    <span className="sp-card-total">{formatMoney(data.totals.spending)}</span>
                  </div>
                  {categoryShares.length === 0 ? (
                    <p className="dash-empty">No spending this month.</p>
                  ) : (
                    <CategoryBreakdown shares={categoryShares} total={data.totals.spending} onSelect={showCategory} />
                  )}
                </section>

                {largest.length > 0 && (
                  <section className="dash-card sp-section" aria-labelledby="largest-heading">
                    <div className="dash-card-header">
                      <h2 id="largest-heading" className="sp-card-title">Largest</h2>
                      <span className="sp-card-total">
                        {largest.length} of {purchases.length}
                      </span>
                    </div>
                    <ul className="sp-list">
                      {largest.map((transaction) => (
                        <TransactionRow
                          key={transaction.id}
                          transaction={transaction}
                          detail={`${transaction.category} · ${shortDay(transaction.date)}`}
                          onSelect={openSheet}
                        />
                      ))}
                    </ul>
                    {purchases.length > largest.length && (
                      <button type="button" className="pill-button pill-button-soft sp-more" onClick={showPurchases}>
                        See all {purchases.length} purchases
                        <Icon name="chevronRight" size={16} strokeWidth={2.4} />
                      </button>
                    )}
                  </section>
                )}

                <p className="stocks-footnote spend-page-note">
                  Tap a category to see its transactions. Categories come from your bank; change one from any
                  transaction.
                </p>
              </>
            )}

            {tab === "income" && (
              <>
                <section className="dash-card sp-section" aria-labelledby="money-in-heading">
                  <div className="dash-card-header">
                    <h2 id="money-in-heading" className="sp-card-title">Money in</h2>
                    <span className="sp-card-total">{formatMoney(incomeTotal)}</span>
                  </div>
                  {deposits.length === 0 ? (
                    <p className="dash-empty">No income this month.</p>
                  ) : (
                    <ul className="sp-list">
                      {deposits.map((transaction) => (
                        <TransactionRow
                          key={transaction.id}
                          transaction={transaction}
                          detail={`${sourceLabel(transaction.category)} · ${shortDay(transaction.date)}`}
                          onSelect={openSheet}
                        />
                      ))}
                    </ul>
                  )}
                </section>

                {sourceShares.length > 0 && (
                  <section className="dash-card sp-section" aria-labelledby="by-source-heading">
                    <div className="dash-card-header">
                      <h2 id="by-source-heading" className="sp-card-title">By source</h2>
                      <span className="sp-card-total">{count(sourceShares.length, "source")}</span>
                    </div>
                    <CategoryBreakdown shares={sourceShares} total={incomeTotal} stacked={false} />
                  </section>
                )}

                <p className="stocks-footnote spend-page-note">
                  Refunds, transfers from your own accounts and stock sales aren&apos;t counted as income. Mark a
                  deposit as a transfer from its transaction sheet if it&apos;s counted by mistake.
                </p>
              </>
            )}

            {tab === "transactions" && (
              <>
                <section className="dash-card sp-section" aria-labelledby="transactions-heading">
                  <div className="dash-card-header">
                    <h2 id="transactions-heading" className="sp-card-title">
                      {count(filtered.length, "transaction")}
                    </h2>
                    <span className="sp-card-note">Newest first</span>
                  </div>
                  <label className="sp-search">
                    <Icon name="search" size={18} strokeWidth={2.2} />
                    <span className="stocks-sr-only">Search {monthName(month)}</span>
                    <input
                      type="search"
                      value={query}
                      placeholder={`Search ${monthLabel(month).split(" ")[0]}`}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setShown(PAGE_SIZE);
                      }}
                    />
                  </label>
                  <div className="sp-chips" role="group" aria-label="Show">
                    {FILTERS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="sp-chip"
                        aria-pressed={filter === item.id && categoryFilter === null}
                        onClick={() => {
                          setCategoryFilter(null);
                          changeFilter(item.id);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                    {categoryFilter && (
                      <button
                        type="button"
                        className="sp-chip"
                        aria-pressed="true"
                        onClick={() => {
                          setCategoryFilter(null);
                          setShown(PAGE_SIZE);
                        }}
                      >
                        {categoryFilter}
                        <Icon name="close" size={13} strokeWidth={2.6} />
                        <span className="stocks-sr-only"> (show all)</span>
                      </button>
                    )}
                  </div>

                  {filtered.length === 0 ? (
                    <p className="dash-empty">No transactions match.</p>
                  ) : (
                    <TransactionDays transactions={filtered.slice(0, shown)} onSelect={openSheet} />
                  )}
                  {filtered.length > shown && (
                    <button
                      type="button"
                      className="pill-button pill-button-soft sp-more"
                      onClick={() => setShown((current) => current + PAGE_SIZE)}
                    >
                      Show earlier in {monthLabel(month).split(" ")[0]}
                      <Icon name="chevronRight" size={16} strokeWidth={2.4} />
                    </button>
                  )}
                </section>

                <p className="stocks-footnote spend-page-note">
                  {countNote ? `${countNote.charAt(0).toUpperCase()}${countNote.slice(1)}. ` : ""}
                  Transfers are listed but not counted.
                  {pending > 0 && ` ${count(pending, "pending transaction")} won't count until they post.`}
                </p>
              </>
            )}
          </div>
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
