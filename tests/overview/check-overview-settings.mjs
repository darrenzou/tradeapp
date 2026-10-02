// Checks how Edit accounts settings from the browser or storage are read.
// No network or credentials needed.
//
//   node tests/overview/check-overview-settings.mjs

import assert from "node:assert/strict";

import {
  DEFAULT_OVERVIEW_SETTINGS,
  accountKey,
  parseOverviewSettings,
  withSettingsKeys,
} from "../../lib/overview-settings.ts";

const key = accountKey({ source: "plaid", institution: "Chase", name: "Checking ••1234" });
assert.equal(key, "plaid|Chase|Checking ••1234");

// Two accounts at one bank with the same name each get their own key, so a
// nickname on one doesn't rename the other; a unique name keeps the plain key.
const keyed = withSettingsKeys([
  { id: "a1", source: "snaptrade", institution: "Fidelity", name: "Individual" },
  { id: "a2", source: "snaptrade", institution: "Fidelity", name: "Individual" },
  { id: "p1", source: "plaid", institution: "Chase", name: "Checking ••1234" },
]);
assert.deepEqual(
  keyed.map(accountKey),
  ["snaptrade|Fidelity|Individual|a1", "snaptrade|Fidelity|Individual|a2", key],
);

// Missing fields take the defaults.
assert.deepEqual(parseOverviewSettings({}), DEFAULT_OVERVIEW_SETTINGS);

// Nicknames are trimmed and capped; empty entries and false flags are dropped.
assert.deepEqual(
  parseOverviewSettings({
    hideZeroBalances: true,
    sectionOrder: ["credit", "cash", "credit"],
    accountOrder: [key, key],
    accounts: {
      [key]: { nickname: "  Bills  ", hidden: false },
      "plaid|Ally|Savings": { nickname: " ", hidden: false, removed: false },
      "snaptrade|Schwab|Brokerage": { hidden: true, removed: true, nickname: "x".repeat(80) },
    },
  }),
  {
    hideZeroBalances: true,
    combineSavingsAndInvestments: false,
    sectionOrder: ["credit", "cash"],
    accountOrder: [key],
    accounts: {
      [key]: { nickname: "Bills" },
      "snaptrade|Schwab|Brokerage": { nickname: "x".repeat(60), hidden: true, removed: true },
    },
  },
);

// Anything of the wrong shape is refused rather than partly saved.
for (const bad of [
  null,
  [],
  "settings",
  { hideZeroBalances: "yes" },
  { combineSavingsAndInvestments: 1 },
  { sectionOrder: ["Cash & savings"] },
  { sectionOrder: "cash" },
  { accountOrder: [null] },
  { accountOrder: [""] },
  { accounts: [] },
  { accounts: { [key]: { nickname: 5 } } },
  { accounts: { [key]: { hidden: "true" } } },
  { accounts: { [key]: "hidden" } },
  { accounts: { ["k".repeat(301)]: { hidden: true } } },
  { accountOrder: Array.from({ length: 201 }, (_, index) => `a${index}`) },
]) {
  assert.equal(parseOverviewSettings(bad), null, JSON.stringify(bad)?.slice(0, 80));
}

console.log("Overview settings checks passed.");
