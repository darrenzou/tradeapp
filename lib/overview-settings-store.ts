import "server-only";

import { createAdminClient } from "@/lib/auth";
import { DEFAULT_OVERVIEW_SETTINGS, parseOverviewSettings, type OverviewSettings } from "@/lib/overview-settings";

// Postgres and PostgREST codes for a table that doesn't exist.
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

// This user's Edit accounts choices. When they can't be read (for example
// the table hasn't been created yet), the Overview shows every account as
// linked and says so.
export async function loadOverviewSettings(userId: string, issues: string[]): Promise<OverviewSettings> {
  const { data, error } = await createAdminClient()
    .from("overview_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // Until the overview_settings migration runs there's nothing to load, and
    // the Overview simply shows every account as linked.
    if (!MISSING_TABLE_CODES.has(error.code)) {
      issues.push("Your account names and hidden accounts couldn't be loaded, so every account is shown as linked.");
    }

    return DEFAULT_OVERVIEW_SETTINGS;
  }

  return (data && parseOverviewSettings(data.settings)) ?? DEFAULT_OVERVIEW_SETTINGS;
}

export async function saveOverviewSettings(userId: string, settings: OverviewSettings): Promise<void> {
  const { error } = await createAdminClient()
    .from("overview_settings")
    .upsert({ user_id: userId, settings, updated_at: new Date().toISOString() });

  if (error) {
    throw new Error("Failed to save overview settings");
  }
}
