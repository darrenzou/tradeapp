import "server-only";

import { parseAllocationTargets, type AllocationTargets } from "@/lib/allocation-targets";
import { createAdminClient } from "@/lib/auth";
import { DEFAULT_OVERVIEW_SETTINGS, parseOverviewSettings, type OverviewSettings } from "@/lib/overview-settings";
import { parseEmployerMatches, type EmployerMatch, type EmployerMatches } from "@/lib/retirement-contributions";

// Postgres and PostgREST codes for a table or column that doesn't exist.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);

// One column of this user's settings row, or null when there's no row yet.
// Until the user_settings migrations run there's nothing to load, and that
// isn't reported; other failures add `issue`.
async function loadColumn(
  userId: string,
  column: "overview" | "allocation_targets" | "employer_matches",
  issues: string[],
  issue: string,
): Promise<unknown> {
  const { data, error } = await createAdminClient()
    .from("user_settings")
    .select(column)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (!MISSING_TABLE_CODES.has(error.code)) {
      issues.push(issue);
    }

    return null;
  }

  return data ? (data as Record<string, unknown>)[column] : null;
}

// Upserts only the given column, leaving the row's other settings as they are.
async function saveColumn(userId: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await createAdminClient()
    .from("user_settings")
    .upsert({ user_id: userId, ...values, updated_at: new Date().toISOString() });

  if (error) {
    throw new Error("Failed to save settings");
  }
}

// This user's Edit accounts choices. When they can't be read, the Overview
// shows every account as linked.
export async function loadOverviewSettings(userId: string, issues: string[]): Promise<OverviewSettings> {
  const value = await loadColumn(
    userId,
    "overview",
    issues,
    "Your account names and hidden accounts couldn't be loaded, so every account is shown as linked.",
  );

  return parseOverviewSettings(value) ?? DEFAULT_OVERVIEW_SETTINGS;
}

export async function saveOverviewSettings(userId: string, settings: OverviewSettings): Promise<void> {
  await saveColumn(userId, { overview: settings });
}

// This user's allocation targets, or null when they haven't set any.
export async function loadAllocationTargets(userId: string, issues: string[]): Promise<AllocationTargets | null> {
  const value = await loadColumn(
    userId,
    "allocation_targets",
    issues,
    "Your allocation targets couldn't be loaded.",
  );

  return parseAllocationTargets(value);
}

export async function saveAllocationTargets(userId: string, targets: AllocationTargets): Promise<void> {
  await saveColumn(userId, { allocation_targets: targets });
}

// The 401(k) employer matches this user set, by account id.
export async function loadEmployerMatches(userId: string, issues: string[]): Promise<EmployerMatches> {
  const value = await loadColumn(
    userId,
    "employer_matches",
    issues,
    "Your 401k employer match couldn't be loaded, so contributions aren't split.",
  );

  return parseEmployerMatches(value);
}

// Sets one account's employer match, or removes it when `match` is null,
// keeping the other accounts' matches.
export async function saveEmployerMatch(
  userId: string,
  accountId: string,
  match: EmployerMatch | null,
): Promise<EmployerMatches> {
  const issues: string[] = [];
  const matches = await loadEmployerMatches(userId, issues);

  if (issues.length > 0) {
    throw new Error("Failed to load settings");
  }

  delete matches[accountId];

  if (match !== null) {
    matches[accountId] = match;
  }

  await saveColumn(userId, { employer_matches: matches });
  return matches;
}
