import type { IconName } from "./theme-ui";
import type { LinkedAccount } from "@/lib/net-worth";
import { accountKey, type OverviewSettings } from "@/lib/overview-settings";

export type Section = {
  id: string;
  title: string;
  kinds: LinkedAccount["kind"][];
  color: string;
  // The heading band's background and text colors.
  tint: string;
  ink: string;
  icon: IconName;
};

// Account groups on the Overview, in their default order. Empty ones are
// left out.
export const SECTIONS: Section[] = [
  { id: "cash", title: "Cash & savings", kinds: ["cash"], color: "#2e6a62", tint: "#d5e8e6", ink: "#1f4b45", icon: "cash" },
  {
    id: "investments",
    title: "Investments",
    kinds: ["investment"],
    color: "#6e9a33",
    tint: "#ddedb5",
    ink: "#34511a",
    icon: "trendUp",
  },
  { id: "other", title: "Other assets", kinds: ["other"], color: "#9da398", tint: "#e4e6e0", ink: "#3f4a3c", icon: "home" },
  { id: "credit", title: "Credit cards", kinds: ["credit"], color: "#a4532a", tint: "#f3dccb", ink: "#7a3f24", icon: "card" },
  { id: "loans", title: "Loans", kinds: ["loan"], color: "#7a5a2e", tint: "#ece2cf", ink: "#5c4220", icon: "receipt" },
];

// Cash & savings and Investments as one, when the user combines them.
const COMBINED: Section = {
  id: "savings",
  title: "Savings & investments",
  kinds: ["cash", "investment"],
  color: "#2e6a62",
  tint: "#d5e8e6",
  ink: "#1f4b45",
  icon: "cash",
};

// The sections in the user's order, with savings and investments combined
// if they asked for that.
export function orderedSections(settings: OverviewSettings): Section[] {
  const sections = settings.combineSavingsAndInvestments
    ? SECTIONS.flatMap((section) =>
        section.id === "cash" ? [COMBINED] : section.id === "investments" ? [] : [section],
      )
    : SECTIONS;
  // The combined section takes the place of whichever of its two parts came
  // first, and splitting it puts both parts where it was.
  const aliases: Record<string, string[]> = { savings: ["cash", "investments"], cash: ["savings"], investments: ["savings"] };
  const rank = (section: Section) => {
    const index = [section.id, ...(aliases[section.id] ?? [])]
      .map((id) => settings.sectionOrder.indexOf(id))
      .filter((found) => found !== -1)
      .reduce((best, found) => Math.min(best, found), Number.MAX_SAFE_INTEGER);
    return index === Number.MAX_SAFE_INTEGER ? settings.sectionOrder.length + sections.indexOf(section) : index;
  };

  return [...sections].sort((a, b) => rank(a) - rank(b));
}

// Accounts in the user's order; ones they haven't placed keep the order
// they were linked in, after the placed ones.
export function orderedAccounts(accounts: LinkedAccount[], settings: OverviewSettings): LinkedAccount[] {
  const rank = (account: LinkedAccount) => {
    const index = settings.accountOrder.indexOf(accountKey(account));
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
    .map(({ account }) => account);
}

export function groupAccounts(
  accounts: LinkedAccount[],
  settings: OverviewSettings,
): { section: Section; accounts: LinkedAccount[] }[] {
  const ordered = orderedAccounts(accounts, settings);

  return orderedSections(settings)
    .map((section) => ({ section, accounts: ordered.filter((account) => section.kinds.includes(account.kind)) }))
    .filter((group) => group.accounts.length > 0);
}

export function displayName(account: LinkedAccount, settings: OverviewSettings): string {
  return settings.accounts[accountKey(account)]?.nickname ?? account.name;
}

export function isHiddenAtZero(account: LinkedAccount, settings: OverviewSettings): boolean {
  return settings.hideZeroBalances && account.balance === 0;
}

// Hidden accounts stay off the Overview list but still count in totals.
export function isHidden(account: LinkedAccount, settings: OverviewSettings): boolean {
  return settings.accounts[accountKey(account)]?.hidden === true || isHiddenAtZero(account, settings);
}
