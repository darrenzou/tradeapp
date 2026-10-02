// Finds accounts that show up more than once because they are linked through
// more than one connection. A joint account comes back once for each owner's
// login, so linking both logins at the same bank (or brokerage) returns the
// same account twice, with different ids and the same balance and
// transactions. Pure, so it runs in scripts and tests as well as on the server.

import type { AccountBase } from "plaid";

// What a provider tells us about one linked account.
export type AccountIdentity = {
  // LinkedAccount id, e.g. plaid:abc or snaptrade:xyz.
  id: string;
  source: "plaid" | "snaptrade";
  // The Plaid Item or SnapTrade brokerage authorization it came through. Each
  // connection lists an account once, so copies are always in different ones.
  connection: string;
  // Institution name, or null when the provider didn't give one.
  institution: string | null;
  // Account type as the provider reports it, e.g. depository/checking.
  type: string;
  // Account number as the provider shows it: Plaid's last 4 digits,
  // SnapTrade's full or masked number. Null when not reported.
  number: string | null;
  // An id the institution keeps the same across logins and connections:
  // Plaid's persistent_account_id (Chase only) or SnapTrade's
  // institution_account_id. Null when not reported.
  persistentId: string | null;
};

function normalized(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase().replace(/\s+/g, " ");
  return text ? text : null;
}

// Two entries are the same account when they come from different connections
// to the same provider and either share the institution's persistent account
// id, or (when one of them has none) share institution, account type, and
// account number. Different persistent ids always mean different accounts.
export function isSameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  if (a.source !== b.source || a.connection === b.connection) {
    return false;
  }

  const institution = normalized(a.institution);

  if (institution === null || institution !== normalized(b.institution)) {
    return false;
  }

  const persistentA = normalized(a.persistentId);
  const persistentB = normalized(b.persistentId);

  if (persistentA !== null && persistentB !== null) {
    return persistentA === persistentB;
  }

  const number = normalized(a.number);
  return number !== null && number === normalized(b.number) && normalized(a.type) === normalized(b.type);
}

// Returns each duplicate's id mapped to the id of the copy that is kept.
// Accounts earlier in the list are kept over later copies, so callers order
// it by which copy they'd rather use.
export function findDuplicateAccounts(accounts: AccountIdentity[]): Map<string, string> {
  const kept: { keeper: AccountIdentity; connections: Set<string> }[] = [];
  const duplicates = new Map<string, string>();

  for (const account of accounts) {
    // A group never takes two accounts from one connection: those are
    // different accounts, however alike they look.
    const group = kept.find(
      ({ keeper, connections }) => !connections.has(account.connection) && isSameAccount(keeper, account),
    );

    if (group === undefined) {
      kept.push({ keeper: account, connections: new Set([account.connection]) });
    } else {
      group.connections.add(account.connection);
      duplicates.set(account.id, group.keeper.id);
    }
  }

  return duplicates;
}

// A Plaid account's name as the app shows it, with its last four digits.
export function plaidAccountName(account: Pick<AccountBase, "name" | "mask">): string {
  return account.mask ? `${account.name} ••${account.mask}` : account.name;
}

export function plaidAccountIdentity(
  item: { itemId: string; institutionName: string | null },
  account: AccountBase,
): AccountIdentity {
  return {
    id: `plaid:${account.account_id}`,
    source: "plaid",
    connection: item.itemId,
    institution: item.institutionName,
    type: `${account.type}/${account.subtype ?? ""}`,
    number: account.mask,
    persistentId: account.persistent_account_id ?? null,
  };
}
