import "server-only";

import { parseAllocationTargets, type AllocationTargets } from "@/lib/allocation-targets";
import { createAdminClient } from "@/lib/auth";
import { DEFAULT_OVERVIEW_SETTINGS, parseOverviewSettings, type OverviewSettings } from "@/lib/overview-settings";

// Postgres and PostgREST codes for a table that doesn't exist.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

// One column of this user's settings row, or null when there's no row yet.
// Until the user_settings migration runs there's nothing to load, and that
// isn't reported; other failures add `issue`.
async function loadColumn(
  userId: string,
  column: "overview" | "allocation_targets",
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
