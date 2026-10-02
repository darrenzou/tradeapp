"use client";

import { useRef, useState } from "react";

import { errorMessage, isRecord, readJson, type useApiFetch } from "./client-api";
import DetailDialog from "./detail-dialog";
import { Icon } from "./theme-ui";
import { guessInstitution, parseBankCsv } from "@/lib/imported-transactions";
import type { LinkedAccount } from "@/lib/net-worth";
import { accountKey, parseOverviewSettings, type OverviewSettings } from "@/lib/overview-settings";

type ApiFetch = ReturnType<typeof useApiFetch>;

type Picked = {
  fileName: string;
  csv: string;
  count: number;
  earliest: string;
  latest: string;
  mask: string | null;
  hasBalance: boolean;
};

const FAILED = "The file couldn't be imported. Try again.";
const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function dateLabel(date: string): string {
  return dateFormatter.format(new Date(`${date}T00:00:00Z`));
}

function count(value: number): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? "transaction" : "transactions"}`;
}

// The linked bank or card account a file with these last 4 digits belongs
// to, preferring one at the same bank.
function matchAccount(accounts: LinkedAccount[], mask: string, institution: string): LinkedAccount | null {
  const candidates = accounts.filter(
    (account) =>
      account.source !== "snaptrade" &&
      (account.kind === "cash" || account.kind === "credit") &&
      account.name.endsWith(`••${mask}`),
  );
  const bank = institution.trim().toLowerCase();
  const sameBank = candidates.find(
    (account) =>
      bank !== "" &&
      (account.institution.toLowerCase().includes(bank) || bank.includes(account.institution.toLowerCase())),
  );

  return sameBank ?? candidates[0] ?? null;
}

// Adds a bank's CSV download from Add account: into the linked account with
// the same last 4 digits, or as a new account when none is linked. Asks for
// the last 4 digits only when the file doesn't have them.
export default function ImportAccountDialog({
  accounts,
  settings,
  apiFetch,
  onDone,
  onClose,
}: {
  accounts: LinkedAccount[];
  settings: OverviewSettings;
  apiFetch: ApiFetch;
  onDone: (message: string, saved: OverviewSettings | null) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [institution, setInstitution] = useState("");
  const [mask, setMask] = useState("");
  const [nickname, setNickname] = useState("");
  const [kind, setKind] = useState<"cash" | "credit">("cash");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const lastFour = picked?.mask ?? (/^\d{4}$/.test(mask) ? mask : null);
  const match = lastFour === null ? null : matchAccount(accounts, lastFour, institution);
  const matchName = match ? (settings.accounts[accountKey(match)]?.nickname ?? match.name) : null;

  async function pick(file: File) {
    setError("");
    let csv: string;

    try {
      csv = await file.text();
    } catch {
      setError("That file couldn't be read.");
      return;
    }

    const parsed = parseBankCsv(csv, "preview");

    if ("error" in parsed) {
      setPicked(null);
      setError(parsed.error);
      return;
    }

    const dates = parsed.transactions.map((transaction) => transaction.date).sort();
    setPicked({
      fileName: file.name,
      csv,
      count: parsed.transactions.length,
      earliest: dates[0],
      latest: dates[dates.length - 1],
      mask: parsed.mask,
      hasBalance: parsed.balance !== null,
    });
    setInstitution((current) => current || guessInstitution(file.name) || "");
  }

  async function saveNickname(account: LinkedAccount, name: string): Promise<OverviewSettings | null> {
    const key = accountKey(account);
    const draft: OverviewSettings = {
      ...settings,
      accounts: { ...settings.accounts, [key]: { ...settings.accounts[key], nickname: name } },
    };
    const response = await apiFetch("/api/overview-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });

    if (response === null || !response.ok) {
      return null;
    }

    const body = await readJson(response);
    return isRecord(body) ? parseOverviewSettings(body.settings) : null;
  }

  async function submit() {
    if (picked === null) {
      return;
    }

    if (lastFour === null) {
      setError("Enter the account's last 4 digits.");
      return;
    }

    if (match === null && institution.trim() === "") {
      setError("Enter the bank's name.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const response = await apiFetch("/api/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          match
            ? { account: match.id, csv: picked.csv }
            : { newAccount: { institution: institution.trim(), nickname: nickname.trim(), mask: lastFour, kind }, csv: picked.csv },
        ),
      });

      if (response === null) {
        return;
      }

      const body = await readJson(response);

      if (!response.ok) {
        setError(errorMessage(body, FAILED));
        return;
      }

      const imported = isRecord(body) && typeof body.imported === "number" ? body.imported : picked.count;
      const name = nickname.trim();
      const saved = match && name !== "" && name !== matchName ? await saveNickname(match, name).catch(() => null) : null;

      onDone(
        match
          ? `Imported ${count(imported)} into ${name || matchName}. Ones Plaid already has aren't counted twice.`
          : `Added ${name || (kind === "credit" ? "Credit card" : "Checking")} ••${lastFour} with ${count(imported)}.`,
        saved,
      );
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailDialog title="Import from a bank file" onClose={onClose}>
      <p className="detail-caption">
        Download your transactions as a CSV file from your bank&apos;s website. Use it for older history than Plaid
        shares, or for a bank Plaid can&apos;t connect.
      </p>

      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="stocks-sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";

          if (file !== undefined) {
            void pick(file);
          }
        }}
      />

      {picked === null ? (
        <div className="dash-connect-actions">
          <button type="button" className="pill-button pill-button-primary" onClick={() => input.current?.click()}>
            <Icon name="upload" size={18} strokeWidth={2.2} />
            Choose a CSV file
          </button>
        </div>
      ) : (
        <>
          <div className="ea-box ia-file">
            <div className="ia-file-main">
              <p className="ia-file-name">{picked.fileName}</p>
              <p className="ea-option-note">
                {count(picked.count)} · {dateLabel(picked.earliest)} to {dateLabel(picked.latest)}
              </p>
            </div>
            <button type="button" className="pill-button pill-button-soft" onClick={() => input.current?.click()}>
              Change
            </button>
          </div>

          <div className="ea-box">
            <label className="ea-option ea-option-stacked">
              <span className="ea-option-title">Bank</span>
              <input
                className="ea-name"
                value={institution}
                maxLength={60}
                placeholder="e.g. Discover"
                autoComplete="off"
                onChange={(event) => setInstitution(event.target.value)}
              />
            </label>
            {picked.mask === null ? (
              <label className="ea-option ea-option-stacked">
                <span className="ea-option-title">Last 4 digits</span>
                <span className="ea-option-note">The file doesn&apos;t include the account number.</span>
                <input
                  className="ea-name ia-mask"
                  value={mask}
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="1234"
                  autoComplete="off"
                  onChange={(event) => setMask(event.target.value.replace(/\D/g, ""))}
                />
              </label>
            ) : (
              <div className="ea-option">
                <span className="ea-option-title">Account ending</span>
                <span className="ia-value">••{picked.mask} (from the file)</span>
              </div>
            )}
            <label className="ea-option ea-option-stacked">
              <span className="ea-option-title">Nickname (optional)</span>
              <input
                className="ea-name"
                value={nickname}
                maxLength={60}
                placeholder={matchName ?? "e.g. Everyday checking"}
                autoComplete="off"
                onChange={(event) => setNickname(event.target.value)}
              />
            </label>
            {match === null && (
              <div className="ea-option ea-option-stacked">
                <span className="ea-option-title" id="import-kind-label">
                  Type
                </span>
                <div className="ea-segment" role="radiogroup" aria-labelledby="import-kind-label">
                  {(
                    [
                      { value: "cash", label: "Bank account" },
                      { value: "credit", label: "Credit card" },
                    ] as const
                  ).map(({ value, label }) => (
                    <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {lastFour !== null && (
            <p className="ia-match" role="status">
              {match
                ? `Goes into ${matchName} at ${match.institution}, which is already linked. Only transactions older than what Plaid has are added.`
                : `No linked account ends in ${lastFour}, so this adds a new account to your Overview.${
                    picked.hasBalance ? " Its balance comes from the file." : " The file has no balance, so it shows $0."
                  }`}
            </p>
          )}
        </>
      )}

      {error && (
        <p className="ia-error" role="alert">
          {error}
        </p>
      )}

      {picked !== null && (
        <div className="dash-connect-actions">
          <button
            type="button"
            className="pill-button pill-button-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Importing…" : `Import ${count(picked.count)}`}
          </button>
        </div>
      )}
    </DetailDialog>
  );
}
