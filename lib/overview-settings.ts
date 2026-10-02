import type { LinkedAccount } from "@/lib/net-worth";

// How a user arranged the Overview's accounts in Edit accounts. Hidden
// accounts still count in net worth and section totals; removed ones don't.
export type AccountSetting = {
  // Shown instead of the bank's name; absent to use the bank's.
  nickname?: string;
  hidden?: boolean;
  removed?: boolean;
};

export type OverviewSettings = {
  // Accounts with a $0 balance stay off the list until their balance changes.
  hideZeroBalances: boolean;
  // Cash & savings and Investments shown as one "Savings & investments" section.
  combineSavingsAndInvestments: boolean;
  // Section ids in the order picked; sections not listed follow in the
  // default order.
  sectionOrder: string[];
  // Account keys (see accountKey) in the order picked, across all sections.
  accountOrder: string[];
  accounts: Record<string, AccountSetting>;
};

export const DEFAULT_OVERVIEW_SETTINGS: OverviewSettings = {
  hideZeroBalances: false,
  combineSavingsAndInvestments: false,
  sectionOrder: [],
  accountOrder: [],
  accounts: {},
};

export const MAX_NICKNAME_LENGTH = 60;
const MAX_KEY_LENGTH = 300;
const MAX_ACCOUNTS = 200;
const SECTION_ID = /^[a-z]{1,20}$/;

// Identifies an account across reconnects: Plaid gives a reconnected bank's
// accounts new ids, but the provider, bank and name (with its last four
// digits) stay the same. Accounts given a settingsKey use that instead.
export function accountKey(
  account: Pick<LinkedAccount, "source" | "institution" | "name"> & { settingsKey?: string },
): string {
  return account.settingsKey ?? `${account.source}|${account.institution}|${account.name}`;
}

// Gives every account its own settings key. When two accounts at the same
// bank share a name (no last four digits to tell them apart), each one's key
// also carries its id, so a nickname or hide on one doesn't apply to the
// other.
export function withSettingsKeys<T extends Pick<LinkedAccount, "id" | "source" | "institution" | "name">>(
  accounts: T[],
): (T & { settingsKey: string })[] {
  const counts = new Map<string, number>();

  for (const account of accounts) {
    const key = accountKey({ source: account.source, institution: account.institution, name: account.name });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return accounts.map((account) => {
    const key = accountKey({ source: account.source, institution: account.institution, name: account.name });
    return { ...account, settingsKey: counts.get(key)! > 1 ? `${key}|${account.id}` : key };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, pattern: (item: string) => boolean): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) {
    return null;
  }

  return value.every((item) => typeof item === "string" && pattern(item)) ? [...new Set(value as string[])] : null;
}

// Settings as sent by the browser or read back from storage, or null when
// they aren't valid. Defaults fill anything missing; empty entries are
// dropped.
export function parseOverviewSettings(value: unknown): OverviewSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const sectionOrder = stringList(value.sectionOrder ?? [], (item) => SECTION_ID.test(item));
  const accountOrder = stringList(value.accountOrder ?? [], (item) => item.length > 0 && item.length <= MAX_KEY_LENGTH);
  const rawAccounts = value.accounts ?? {};

  if (
    sectionOrder === null ||
    accountOrder === null ||
    !isRecord(rawAccounts) ||
    Object.keys(rawAccounts).length > MAX_ACCOUNTS ||
    (value.hideZeroBalances !== undefined && typeof value.hideZeroBalances !== "boolean") ||
    (value.combineSavingsAndInvestments !== undefined && typeof value.combineSavingsAndInvestments !== "boolean")
  ) {
    return null;
  }

  const accounts: Record<string, AccountSetting> = {};

  for (const [key, raw] of Object.entries(rawAccounts)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || !isRecord(raw)) {
      return null;
    }

    const { nickname, hidden, removed } = raw;

    if (
      (nickname !== undefined && typeof nickname !== "string") ||
      (hidden !== undefined && typeof hidden !== "boolean") ||
      (removed !== undefined && typeof removed !== "boolean")
    ) {
      return null;
    }

    const trimmed = typeof nickname === "string" ? nickname.trim().slice(0, MAX_NICKNAME_LENGTH) : "";
    const setting: AccountSetting = {
      ...(trimmed ? { nickname: trimmed } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(removed ? { removed: true } : {}),
    };

    if (Object.keys(setting).length > 0) {
      accounts[key] = setting;
    }
  }

  return {
    hideZeroBalances: value.hideZeroBalances === true,
    combineSavingsAndInvestments: value.combineSavingsAndInvestments === true,
    sectionOrder,
    accountOrder,
    accounts,
  };
}
