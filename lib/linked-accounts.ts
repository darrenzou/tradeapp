import "server-only";

import { createAdminClient } from "@/lib/auth";
import type { SnapTradeUserCredentials } from "@/lib/snaptrade";
import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  plaidAccessTokenContext,
  snaptradeSecretContext,
} from "@/lib/token-crypto";

export type PlaidItem = {
  itemId: string;
  accessToken: string;
  institutionName: string | null;
  // When the Item was linked; absent before it is saved.
  createdAt?: string;
};

// Provider tokens are stored encrypted (see lib/token-crypto.ts). Values
// saved before encryption was added are still plaintext; they are read as-is
// and encrypted in place so each database migrates itself as users sign in.
function readStoredToken(
  stored: string,
  context: string,
  reencrypt: (encrypted: string) => Promise<unknown>,
): string {
  if (isEncryptedToken(stored)) {
    return decryptToken(stored, context);
  }

  // Best effort: a failed write leaves the plaintext for the next read or
  // for scripts/encrypt-provider-tokens.mjs.
  reencrypt(encryptToken(stored, context)).catch(() => undefined);
  return stored;
}

export async function getSnapTradeCredentials(
  userId: string,
): Promise<SnapTradeUserCredentials | null> {
  const client = createAdminClient();
  const { data, error } = await client
    .from("snaptrade_users")
    .select("snaptrade_user_id, snaptrade_user_secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to read SnapTrade credentials");
  }

  if (data === null) {
    return null;
  }

  const stored = data.snaptrade_user_secret;
  const userSecret = readStoredToken(
    stored,
    snaptradeSecretContext(userId, data.snaptrade_user_id),
    async (encrypted) =>
      client
        .from("snaptrade_users")
        .update({ snaptrade_user_secret: encrypted })
        .eq("user_id", userId)
        .eq("snaptrade_user_secret", stored),
  );

  return { userId: data.snaptrade_user_id, userSecret };
}

export async function saveSnapTradeCredentials(
  userId: string,
  credentials: SnapTradeUserCredentials,
): Promise<void> {
  const { error } = await createAdminClient().from("snaptrade_users").insert({
    user_id: userId,
    snaptrade_user_id: credentials.userId,
    snaptrade_user_secret: encryptToken(
      credentials.userSecret,
      snaptradeSecretContext(userId, credentials.userId),
    ),
  });

  if (error) {
    throw new Error("Failed to save SnapTrade credentials");
  }
}

export async function listPlaidItems(userId: string): Promise<PlaidItem[]> {
  const client = createAdminClient();
  const { data, error } = await client
    .from("plaid_items")
    .select("item_id, access_token, institution_name, created_at")
    .eq("user_id", userId)
    .order("created_at");

  if (error) {
    throw new Error("Failed to read Plaid items");
  }

  return data.map((row) => ({
    itemId: row.item_id,
    accessToken: readStoredToken(
      row.access_token,
      plaidAccessTokenContext(userId, row.item_id),
      async (encrypted) =>
        client
          .from("plaid_items")
          .update({ access_token: encrypted })
          .eq("item_id", row.item_id)
          .eq("access_token", row.access_token),
    ),
    institutionName: row.institution_name,
    createdAt: row.created_at,
  }));
}

export async function savePlaidItem(
  userId: string,
  item: PlaidItem,
): Promise<void> {
  const { error } = await createAdminClient().from("plaid_items").upsert({
    item_id: item.itemId,
    user_id: userId,
    access_token: encryptToken(item.accessToken, plaidAccessTokenContext(userId, item.itemId)),
    institution_name: item.institutionName,
  });

  if (error) {
    throw new Error("Failed to save Plaid item");
  }
}

// Replaces one of the user's Items with a newly linked one (e.g. to fetch
// more history): revokes the old Item at Plaid, best effort, then deletes its
// row. Does nothing if the old Item isn't the user's.
export async function retirePlaidItem(
  userId: string,
  itemId: string,
  revoke: (accessToken: string) => Promise<void>,
): Promise<void> {
  const item = (await listPlaidItems(userId)).find((candidate) => candidate.itemId === itemId);

  if (item === undefined) {
    return;
  }

  await revoke(item.accessToken).catch(() => undefined);

  const { error } = await createAdminClient()
    .from("plaid_items")
    .delete()
    .eq("user_id", userId)
    .eq("item_id", itemId);

  if (error) {
    throw new Error("Failed to remove Plaid item");
  }
}
