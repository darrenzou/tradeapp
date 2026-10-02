"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import DetailDialog from "./detail-dialog";
import { errorMessage, formatMoney, isRecord, readJson, useApiFetch } from "./client-api";
import { Icon } from "./theme-ui";
import { isHiddenAtZero, orderedAccounts, orderedSections, type Section } from "./overview-layout";
import type { LinkedAccount } from "@/lib/net-worth";
import {
  MAX_NICKNAME_LENGTH,
  accountKey,
  parseOverviewSettings,
  type AccountSetting,
  type OverviewSettings,
} from "@/lib/overview-settings";

const SAVE_FAILED_MESSAGE = "Your changes couldn't be saved. Try again.";

function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// Reordering by dragging a handle (mouse, touch or pen) or with the arrow
// keys on it. `onMove` gets the item's index and where it should go. The
// drag follows the pointer on the window, since the dragged row moves in the
// page as it's reordered.
function useReorder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const onMoveRef = useRef(onMove);

  useEffect(() => {
    onMoveRef.current = onMove;
  });

  function start(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    setDragging(id);
    // The handle's row and the list holding it and its siblings.
    const list = event.currentTarget.closest("[data-reorder]")?.parentElement ?? null;

    function follow(moveEvent: PointerEvent) {
      const items = Array.from(list?.querySelectorAll<HTMLElement>(":scope > [data-reorder]") ?? []);
      const from = items.findIndex((item) => item.dataset.reorder === id);
      // The first row whose middle is below the pointer.
      let to = items.findIndex((item) => {
        const box = item.getBoundingClientRect();
        return moveEvent.clientY < box.top + box.height / 2;
      });

      to = to === -1 ? items.length - 1 : to > from ? to - 1 : to;

      if (from !== -1 && to !== from) {
        onMoveRef.current(from, to);
      }
    }

    function stop() {
      setDragging(null);
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    }

    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number, count: number) {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : null;

    if (to !== null) {
      event.preventDefault();

      if (to >= 0 && to < count) {
        onMove(index, to);
      }
    }
  }

  return { dragging, start, keyDown };
}

function Handle({
  id,
  index,
  count,
  label,
  reorder,
}: {
  id: string;
  index: number;
  count: number;
  label: string;
  reorder: ReturnType<typeof useReorder>;
}) {
  return (
    <button
      type="button"
      className="ea-grip"
      aria-label={`${label}, ${index + 1} of ${count}. Drag, or use the up and down arrow keys, to move`}
      onPointerDown={(event) => reorder.start(event, id)}
      onKeyDown={(event) => reorder.keyDown(event, index, count)}
    >
      <Icon name="grip" size={18} strokeWidth={3.2} />
    </button>
  );
}

function AccountRows({
  section,
  accounts,
  settings,
  onChange,
  onMove,
}: {
  section: Section;
  accounts: LinkedAccount[];
  settings: OverviewSettings;
  onChange: (account: LinkedAccount, change: Partial<AccountSetting>) => void;
  onMove: (from: number, to: number) => void;
}) {
  const reorder = useReorder(onMove);

  return (
    <ul className="ea-list" aria-label={section.title}>
      {accounts.map((account, index) => {
        const key = accountKey(account);
        const setting = settings.accounts[key] ?? {};
        const atZero = !setting.hidden && isHiddenAtZero(account, settings);
        const hidden = setting.hidden === true || atZero;
        const name = setting.nickname || account.name;

        return (
          <li
            key={key}
            data-reorder={key}
            className={`ea-row ${hidden ? "ea-row-hidden" : ""} ${reorder.dragging === key ? "ea-row-dragging" : ""}`}
          >
            <Handle id={key} index={index} count={accounts.length} label={name} reorder={reorder} />
            <div className="ea-row-main">
              <input
                className="ea-name"
                type="text"
                value={setting.nickname ?? ""}
                placeholder={account.name}
                maxLength={MAX_NICKNAME_LENGTH}
                aria-label={`Nickname for ${account.name}`}
                onChange={(event) => onChange(account, { nickname: event.target.value })}
              />
              <p className="ea-row-detail">
                {account.institution} · {formatMoney(account.balance, account.currency)}
                {atZero ? " · Hidden at $0" : hidden ? " · Hidden" : ""}
              </p>
            </div>
            <div className="ea-row-buttons">
              <button
                type="button"
                className={`ea-icon-button ${hidden ? "ea-icon-active" : ""}`}
                aria-pressed={hidden}
                aria-label={atZero ? `${name} is hidden while its balance is $0` : hidden ? `Show ${name}` : `Hide ${name}`}
                disabled={atZero}
                onClick={() => onChange(account, { hidden: !setting.hidden })}
              >
                <Icon name={hidden ? "eyeOff" : "eye"} size={18} strokeWidth={2} />
              </button>
              <button
                type="button"
                className="ea-icon-button ea-trash"
                aria-label={`Remove ${name}`}
                onClick={() => onChange(account, { removed: true })}
              >
                <Icon name="trash" size={18} strokeWidth={2} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// The Overview's Edit accounts sheet: nicknames, hiding, removing, and the
// order of sections and accounts. Nothing is saved until Save or Done.
export default function EditAccounts({
  accounts,
  removedAccounts,
  settings,
  apiFetch,
  onSaved,
  onClose,
}: {
  accounts: LinkedAccount[];
  removedAccounts: LinkedAccount[];
  settings: OverviewSettings;
  apiFetch: ReturnType<typeof useApiFetch>;
  onSaved: (settings: OverviewSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const all = [...accounts, ...removedAccounts];
  const isRemoved = (account: LinkedAccount) => draft.accounts[accountKey(account)]?.removed === true;
  const listed = orderedAccounts(all, draft).filter((account) => !isRemoved(account));
  const removed = all.filter(isRemoved);
  const sections = orderedSections(draft)
    .map((section) => ({ section, accounts: listed.filter((account) => section.kinds.includes(account.kind)) }))
    .filter((group) => group.accounts.length > 0);
  const zeroCount = listed.filter((account) => account.balance === 0).length;
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  const sectionReorder = useReorder((from, to) => {
    setDraft((current) => ({
      ...current,
      sectionOrder: arrayMove(
        sections.map(({ section }) => section.id),
        from,
        to,
      ),
    }));
  });

  function changeAccount(account: LinkedAccount, change: Partial<AccountSetting>) {
    const key = accountKey(account);

    setDraft((current) => {
      const next: AccountSetting = { ...current.accounts[key], ...change };

      for (const field of ["nickname", "hidden", "removed"] as const) {
        if (!next[field]) {
          delete next[field];
        }
      }

      const accountsSettings = { ...current.accounts, [key]: next };

      if (Object.keys(next).length === 0) {
        delete accountsSettings[key];
      }

      return { ...current, accounts: accountsSettings };
    });
  }

  // Moves an account within its section, keeping every other account where
  // it is in the overall order.
  function moveAccount(sectionAccounts: LinkedAccount[], from: number, to: number) {
    const sectionKeys = sectionAccounts.map(accountKey);
    const moved = arrayMove(sectionKeys, from, to);

    setDraft((current) => {
      let next = 0;

      return {
        ...current,
        accountOrder: orderedAccounts(all, current)
          .map(accountKey)
          .map((key) => (sectionKeys.includes(key) ? moved[next++] : key)),
      };
    });
  }

  async function save() {
    if (!changed) {
      onClose();
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await apiFetch("/api/overview-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });

      if (response === null) {
        return;
      }

      const body = await readJson(response);
      const saved = isRecord(body) ? parseOverviewSettings(body.settings) : null;

      if (!response.ok || saved === null) {
        setError(errorMessage(body, SAVE_FAILED_MESSAGE));
        return;
      }

      onSaved(saved);
    } catch {
      setError(SAVE_FAILED_MESSAGE);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailDialog
      title="Edit accounts"
      onClose={onClose}
      action={
        <button type="button" className="pill-button pill-button-primary ea-done" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Done"}
        </button>
      }
    >
      <div className="ea-box">
        <div className="ea-option">
          <div>
            <p className="ea-option-title" id="hide-zero-label">Hide accounts with a $0 balance</p>
            <p className="ea-option-note">
              {draft.hideZeroBalances
                ? `${zeroCount} ${zeroCount === 1 ? "account is" : "accounts are"} hidden this way. Each comes back on its own when its balance changes.`
                : `${zeroCount} ${zeroCount === 1 ? "account has" : "accounts have"} a $0 balance.`}
            </p>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="ea-switch"
            aria-labelledby="hide-zero-label"
            checked={draft.hideZeroBalances}
            onChange={(event) => setDraft((current) => ({ ...current, hideZeroBalances: event.target.checked }))}
          />
        </div>
        <div className="ea-option ea-option-stacked">
          <p className="ea-option-title" id="combine-label">Savings and investments</p>
          <div className="ea-segment" role="radiogroup" aria-labelledby="combine-label">
            {[
              { combined: false, label: "Separate" },
              { combined: true, label: "Combined" },
            ].map(({ combined, label }) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={draft.combineSavingsAndInvestments === combined}
                onClick={() => setDraft((current) => ({ ...current, combineSavingsAndInvestments: combined }))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="ea-help">
        Drag the handle to reorder sections or accounts. Type a nickname, or leave it blank to use the bank&apos;s
        name. The trash button takes an account off the Overview and out of net worth; you can restore it
        below. Hidden accounts still count toward net worth and section totals.
      </p>

      <div className="ea-sections">
        {sections.map(({ section, accounts: sectionAccounts }, index) => (
          <section
            key={section.id}
            data-reorder={section.id}
            className={`ea-section ${sectionReorder.dragging === section.id ? "ea-row-dragging" : ""}`}
            aria-label={section.title}
          >
            <h3 className="ea-section-title">
              <Handle id={section.id} index={index} count={sections.length} label={section.title} reorder={sectionReorder} />
              <Icon name={section.icon} size={16} strokeWidth={2.2} />
              {section.title}
            </h3>
            <AccountRows
              section={section}
              accounts={sectionAccounts}
              settings={draft}
              onChange={changeAccount}
              onMove={(from, to) => moveAccount(sectionAccounts, from, to)}
            />
          </section>
        ))}
      </div>

      {removed.length > 0 && (
        <section className="ea-section" aria-labelledby="removed-heading">
          <h3 className="ea-section-title ea-removed-title" id="removed-heading">
            <Icon name="trash" size={16} strokeWidth={2.2} />
            Removed
          </h3>
          <ul className="ea-list">
            {removed.map((account) => (
              <li key={accountKey(account)} className="ea-row ea-row-removed">
                <div className="ea-row-main">
                  <p className="ea-removed-name">{draft.accounts[accountKey(account)]?.nickname || account.name}</p>
                  <p className="ea-row-detail">
                    {account.institution} · {formatMoney(account.balance, account.currency)} · Not counted
                  </p>
                </div>
                <button type="button" className="pill-button ea-restore" onClick={() => changeAccount(account, { removed: false })}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="spend-picker-error" role="alert">
          {error}
        </p>
      )}

      <div className="ea-actions">
        <button type="button" className="pill-button" onClick={onClose} disabled={saving}>
          Discard changes
        </button>
        <button type="button" className="pill-button pill-button-primary" onClick={() => void save()} disabled={saving || !changed}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </DetailDialog>
  );
}
