// Checks how accounts linked through more than one connection, such as a
// joint account linked from both owners' logins, are recognized as one
// account. Made-up accounts; no network or credentials needed.
//
//   node tests/accounts/check-account-dedupe.mjs

import assert from "node:assert/strict";

import { findDuplicateAccounts, isSameAccount, plaidAccountIdentity } from "../../lib/account-dedupe.ts";

function plaid(itemId, account, institutionName = "Chase") {
  return plaidAccountIdentity(
    { itemId, institutionName },
    { type: "depository", subtype: "checking", mask: "1234", persistent_account_id: undefined, ...account },
  );
}

function snaptrade(overrides) {
  return {
    id: `snaptrade:${overrides.id}`,
    source: "snaptrade",
    connection: "auth-1",
    institution: "Fidelity",
    type: "INVESTMENT",
    number: "X12345678",
    persistentId: null,
    ...overrides,
  };
}

// Joint checking linked from both owners' Chase logins: the second copy goes.
{
  const mine = plaid("item-mine", { account_id: "a1", name: "Joint checking" });
  const theirs = plaid("item-theirs", { account_id: "b1", name: "Our checking" });
  const duplicates = findDuplicateAccounts([mine, theirs]);
  assert.deepEqual([...duplicates], [["plaid:b1", "plaid:a1"]], "joint account linked twice");
}

// Same last 4 digits but a different account type is a different account.
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a" }), plaid("i2", { account_id: "b", subtype: "savings" })),
  false,
  "checking and savings with the same last 4",
);

// Different banks with the same last 4 digits are different accounts.
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a" }), plaid("i2", { account_id: "b" }, "Bank of America")),
  false,
  "same last 4 at two banks",
);

// Two accounts inside one connection are never merged, however alike.
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a" }), plaid("i1", { account_id: "b" })),
  false,
  "two accounts in one connection",
);

// No last 4 digits and no persistent id: nothing to match on.
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a", mask: null }), plaid("i2", { account_id: "b", mask: null })),
  false,
  "accounts without account numbers",
);

// Chase's persistent account id settles it either way.
assert.equal(
  isSameAccount(
    plaid("i1", { account_id: "a", persistent_account_id: "p1" }),
    plaid("i2", { account_id: "b", persistent_account_id: "p1", mask: "9999" }),
  ),
  true,
  "matching persistent ids",
);
assert.equal(
  isSameAccount(
    plaid("i1", { account_id: "a", persistent_account_id: "p1" }),
    plaid("i2", { account_id: "b", persistent_account_id: "p2" }),
  ),
  false,
  "different persistent ids with the same last 4",
);
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a", persistent_account_id: "p1" }), plaid("i2", { account_id: "b" })),
  true,
  "persistent id on one copy only falls back to the account number",
);

// Institution names differ only in case and spacing.
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a" }, "Chase "), plaid("i2", { account_id: "b" }, "chase")),
  true,
  "institution name case",
);
assert.equal(
  isSameAccount(plaid("i1", { account_id: "a" }, null), plaid("i2", { account_id: "b" }, null)),
  false,
  "unknown institution",
);

// Joint brokerage account from two SnapTrade connections.
{
  const a = snaptrade({ id: "s1", connection: "auth-1" });
  const b = snaptrade({ id: "s2", connection: "auth-2" });
  assert.equal(isSameAccount(a, b), true, "SnapTrade account number");
  assert.equal(
    isSameAccount(
      snaptrade({ id: "s1", connection: "auth-1", persistentId: "F1" }),
      snaptrade({ id: "s2", connection: "auth-2", persistentId: "F1", number: "****5678" }),
    ),
    true,
    "SnapTrade institution account id",
  );
}

// Never across providers: Plaid and SnapTrade describe accounts differently.
assert.equal(
  isSameAccount(
    snaptrade({ id: "s1", institution: "Chase", number: "1234", type: "depository/checking" }),
    plaid("i1", { account_id: "a" }),
  ),
  false,
  "Plaid and SnapTrade",
);

// Three logins to one bank: both extra copies map to the first.
{
  const duplicates = findDuplicateAccounts([
    plaid("i1", { account_id: "a" }),
    plaid("i2", { account_id: "b" }),
    plaid("i3", { account_id: "c" }),
  ]);
  assert.deepEqual([...duplicates], [["plaid:b", "plaid:a"], ["plaid:c", "plaid:a"]], "three copies");
}

// Two different accounts in one login that both look like one account in
// another login: only one of them is taken as its copy.
{
  const duplicates = findDuplicateAccounts([
    plaid("i1", { account_id: "a" }),
    plaid("i2", { account_id: "b" }),
    plaid("i1", { account_id: "c" }),
  ]);
  assert.deepEqual([...duplicates], [["plaid:b", "plaid:a"]], "one copy per connection");
}

// Personal accounts in each login stay; only the shared one is dropped.
{
  const duplicates = findDuplicateAccounts([
    plaid("mine", { account_id: "joint-a", mask: "1111" }),
    plaid("mine", { account_id: "my-card", type: "credit", subtype: "credit card", mask: "2222" }),
    plaid("theirs", { account_id: "joint-b", mask: "1111" }),
    plaid("theirs", { account_id: "their-card", type: "credit", subtype: "credit card", mask: "3333" }),
  ]);
  assert.deepEqual([...duplicates], [["plaid:joint-b", "plaid:joint-a"]], "only the joint account");
}

console.log("Account duplicate checks passed.");
