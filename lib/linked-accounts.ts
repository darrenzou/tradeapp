import "server-only";

import { createAdminClient } from "@/lib/auth";
import type { SnapTradeUserCredentials } from "@/lib/snaptrade";

export type PlaidItem = {
  itemId: string;
  accessToken: string;
  institutionName: string | null;
};

export async function getSnapTradeCredentials(
  userId: string,
): Promise<SnapTradeUserCredentials | null> {
  const { data, error } = await createAdminClient()
    .from("snaptrade_users")
    .select("snaptrade_user_id, snaptrade_user_secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to read SnapTrade credentials");
  }

  return data === null
    ? null
    : { userId: data.snaptrade_user_id, userSecret: data.snaptrade_user_secret };
}

export async function saveSnapTradeCredentials(
  userId: string,
  credentials: SnapTradeUserCredentials,
): Promise<void> {
  const { error } = await createAdminClient().from("snaptrade_users").insert({
    user_id: userId,
    snaptrade_user_id: credentials.userId,
    snaptrade_user_secret: credentials.userSecret,
  });

  if (error) {
    throw new Error("Failed to save SnapTrade credentials");
  }
}

export async function listPlaidItems(userId: string): Promise<PlaidItem[]> {
  const { data, error } = await createAdminClient()
    .from("plaid_items")
    .select("item_id, access_token, institution_name")
    .eq("user_id", userId)
    .order("created_at");

  if (error) {
    throw new Error("Failed to read Plaid items");
  }

  return data.map((row) => ({
    itemId: row.item_id,
    accessToken: row.access_token,
    institutionName: row.institution_name,
  }));
}

export async function savePlaidItem(
  userId: string,
  item: PlaidItem,
): Promise<void> {
  const { error } = await createAdminClient().from("plaid_items").upsert({
    item_id: item.itemId,
    user_id: userId,
    access_token: item.accessToken,
    institution_name: item.institutionName,
  });

  if (error) {
    throw new Error("Failed to save Plaid item");
  }
}
