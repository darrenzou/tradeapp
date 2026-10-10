"use client";

// The last loaded copy of each page's data, saved in this browser's
// IndexedDB so the app can show it when the phone is offline. Only written
// for sessions signed in with "Remember me", and wiped on sign-out, when the
// session ends, and when a different user signs in (see client-cache.ts).
//
// Everything here is best effort: IndexedDB can be missing or blocked
// (private browsing, storage cleared by the browser), and the app then works
// as before, online only.

const DB_NAME = "tradeapp-offline";
const DB_VERSION = 1;
const STORE = "snapshot";
// The username the saved entries belong to.
const OWNER_KEY = "owner";
const ENTRY_PREFIX = "entry:";

export type SavedEntry = { data: unknown; fetchedAt: number };
export type OfflineSnapshot = { username: string; entries: Record<string, SavedEntry> };

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const db = request.result;
        // Lets another tab upgrade or delete the database.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

function finished(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

async function withStore(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<boolean> {
  const db = await openDb();

  if (db === null) {
    return false;
  }

  try {
    const transaction = db.transaction(STORE, mode);
    run(transaction.objectStore(STORE));
    return await finished(transaction);
  } catch {
    return false;
  }
}

// Saves one page's data for `username`, replacing anything saved for another user.
export async function saveOfflineEntry(username: string, key: string, entry: SavedEntry): Promise<void> {
  await withStore("readwrite", (store) => {
    const owner = store.get(OWNER_KEY);
    owner.onsuccess = () => {
      if (owner.result !== username) {
        store.clear();
        store.put(username, OWNER_KEY);
      }
      store.put({ data: entry.data, fetchedAt: entry.fetchedAt }, `${ENTRY_PREFIX}${key}`);
    };
  });
}

// Reads everything saved, or null when nothing is (or storage is unavailable).
export async function loadOfflineSnapshot(): Promise<OfflineSnapshot | null> {
  let username: unknown = null;
  const entries: Record<string, SavedEntry> = {};

  const ok = await withStore("readonly", (store) => {
    const owner = store.get(OWNER_KEY);
    owner.onsuccess = () => {
      username = owner.result;
    };

    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;

      if (current === null) {
        return;
      }

      const value = current.value as Partial<SavedEntry> | null;

      if (
        typeof current.key === "string" &&
        current.key.startsWith(ENTRY_PREFIX) &&
        value !== null &&
        typeof value === "object" &&
        typeof value.fetchedAt === "number"
      ) {
        entries[current.key.slice(ENTRY_PREFIX.length)] = { data: value.data, fetchedAt: value.fetchedAt };
      }

      current.continue();
    };
  });

  return ok && typeof username === "string" && username.length > 0 ? { username, entries } : null;
}

export async function clearOfflineSnapshot(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
