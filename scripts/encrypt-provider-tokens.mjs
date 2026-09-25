// Encrypts provider tokens stored before token encryption was added.
//
//   npm run encrypt:tokens                      # uses .env.local
//   npm run encrypt:tokens -- --env-file=path   # another environment's file
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the TOKEN_ENCRYPTION_KEY
// the app uses against that database. Safe to run repeatedly: encrypted
// values are skipped, and each update only applies if the row still holds the
// plaintext that was read. Prints counts only, never token values.

import { createClient } from "@supabase/supabase-js";

import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  plaidAccessTokenContext,
  snaptradeSecretContext,
} from "../lib/token-crypto.ts";

const envFileArg = process.argv.find((arg) => arg.startsWith("--env-file="));
process.loadEnvFile(envFileArg ? envFileArg.slice("--env-file=".length) : ".env.local");

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey || !process.env.TOKEN_ENCRYPTION_KEY) {
  console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TOKEN_ENCRYPTION_KEY must be set.");
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function migrate({ table, column, key, select, context }) {
  const { data, error } = await admin.from(table).select(select);

  if (error) {
    throw new Error(`Failed to read ${table}`);
  }

  const counts = { encrypted: 0, alreadyEncrypted: 0, failed: 0, unreadable: 0 };

  for (const row of data) {
    const stored = row[column];

    if (isEncryptedToken(stored)) {
      // Confirms the key in use can read existing values.
      try {
        decryptToken(stored, context(row));
        counts.alreadyEncrypted += 1;
      } catch {
        counts.unreadable += 1;
      }
      continue;
    }

    const { error: updateError, count } = await admin
      .from(table)
      .update({ [column]: encryptToken(stored, context(row)) }, { count: "exact" })
      .eq(key, row[key])
      .eq(column, stored);

    if (updateError || count !== 1) {
      counts.failed += 1;
    } else {
      counts.encrypted += 1;
    }
  }

  console.log(`${`${table}.${column}`.padEnd(38)} ${JSON.stringify(counts)}`);
  return counts;
}

const results = [
  await migrate({
    table: "plaid_items",
    column: "access_token",
    key: "item_id",
    select: "item_id, user_id, access_token",
    context: (row) => plaidAccessTokenContext(row.user_id, row.item_id),
  }),
  await migrate({
    table: "snaptrade_users",
    column: "snaptrade_user_secret",
    key: "user_id",
    select: "user_id, snaptrade_user_id, snaptrade_user_secret",
    context: (row) => snaptradeSecretContext(row.user_id, row.snaptrade_user_id),
  }),
];

if (results.some((counts) => counts.failed > 0 || counts.unreadable > 0)) {
  console.error("Some rows were not migrated or can't be decrypted with this TOKEN_ENCRYPTION_KEY.");
  process.exitCode = 1;
}
