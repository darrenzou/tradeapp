// Encrypts provider credentials (Plaid access tokens, SnapTrade user secrets)
// before they are stored, with AES-256-GCM and a key kept outside the
// database (TOKEN_ENCRYPTION_KEY). A database leak alone therefore exposes
// no usable tokens.
//
// Each value is bound to a context string naming its column and owner, used
// as GCM associated data, so a stored value copied into another user's row
// fails to decrypt.
//
// This file avoids `server-only` so Node scripts can import it; it is only
// imported from server code.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(encoded, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  }

  return key;
}

export function isEncryptedToken(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function encryptToken(plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptToken(stored: string, context: string): string {
  if (!isEncryptedToken(stored)) {
    throw new Error("Stored token is not encrypted");
  }

  const packed = Buffer.from(stored.slice(PREFIX.length), "base64url");

  if (packed.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Stored token is malformed");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), packed.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

  return Buffer.concat([
    decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

// Context strings: the column plus the row's owner and identity.
export function plaidAccessTokenContext(userId: string, itemId: string): string {
  return `plaid_items.access_token:${userId}:${itemId}`;
}

export function snaptradeSecretContext(userId: string, snaptradeUserId: string): string {
  return `snaptrade_users.snaptrade_user_secret:${userId}:${snaptradeUserId}`;
}
