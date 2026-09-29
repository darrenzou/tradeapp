import "server-only";

import { createAdminClient } from "@/lib/auth";
import type { CategoryRuleChange, CategoryRules } from "@/lib/cashflow";

// The categories this user picked. When they can't be read (for example the
// table hasn't been created yet), the page shows Plaid's categories and says
// so.
export async function loadCategoryRules(userId: string, issues: string[]): Promise<CategoryRules> {
  const { data, error } = await createAdminClient()
    .from("category_rules")
    .select("match_key, category")
    .eq("user_id", userId);

  if (error) {
    issues.push("Categories you changed couldn't be loaded, so Plaid's categories are shown.");
    return {};
  }

  return Object.fromEntries(data.map((row) => [row.match_key, row.category]));
}

export async function saveCategoryRules(userId: string, changes: CategoryRuleChange[]): Promise<void> {
  const client = createAdminClient();
  const updatedAt = new Date().toISOString();
  const saved = changes.flatMap((change) =>
    change.category === null
      ? []
      : [{ user_id: userId, match_key: change.key, category: change.category, updated_at: updatedAt }],
  );
  const removed = changes.flatMap((change) => (change.category === null ? [change.key] : []));

  if (saved.length > 0) {
    const { error } = await client.from("category_rules").upsert(saved);

    if (error) {
      throw new Error("Failed to save category rules");
    }
  }

  if (removed.length > 0) {
    const { error } = await client.from("category_rules").delete().eq("user_id", userId).in("match_key", removed);

    if (error) {
      throw new Error("Failed to remove category rules");
    }
  }
}
