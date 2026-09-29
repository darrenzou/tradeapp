"use client";

import { errorMessage, isRecord, readJson } from "./client-api";

type PlaidLinkHandler = { open: () => void; destroy: () => void };
type PlaidLinkMetadata = { institution?: { name?: string } | null };

declare global {
  interface Window {
    Plaid?: {
      create: (config: {
        token: string;
        onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
        onExit: () => void;
      }) => PlaidLinkHandler;
    };
  }
}

type ApiFetch = (input: string, init?: RequestInit) => Promise<Response | null>;

export type PlaidLinkResult = { publicToken: string; institutionName: string | null };

const PLAID_LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

let plaidScriptPromise: Promise<void> | null = null;

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) {
    return Promise.resolve();
  }

  plaidScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      plaidScriptPromise = null;
      script.remove();
      reject(new Error("Plaid Link failed to load"));
    };
    document.head.appendChild(script);
  });

  return plaidScriptPromise;
}

export class PlaidLinkError extends Error {}

// Opens Plaid Link. Resolves with the public token once the user links a
// bank, or null when they close Link or the session has ended. Rejects with
// a PlaidLinkError carrying a user-facing message when Link can't start.
export async function openPlaidLink(apiFetch: ApiFetch): Promise<PlaidLinkResult | null> {
  let response: Response | null;

  try {
    [response] = await Promise.all([apiFetch("/api/plaid/link-token", { method: "POST" }), loadPlaidScript()]);
  } catch {
    throw new PlaidLinkError("Bank connection is unavailable.");
  }

  if (response === null) {
    return null;
  }

  const body = await readJson(response);
  const plaid = window.Plaid;

  if (!response.ok || !isRecord(body) || typeof body.linkToken !== "string" || !plaid) {
    throw new PlaidLinkError(errorMessage(body, "Bank connection is unavailable."));
  }

  const linkToken = body.linkToken;

  return new Promise((resolve) => {
    const handler = plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        resolve({ publicToken, institutionName: metadata.institution?.name ?? null });
      },
      onExit: () => {
        handler.destroy();
        resolve(null);
      },
    });
    handler.open();
  });
}

// saved: false with no error means the session ended (the fetcher handles that).
export type SaveResult = { saved: boolean; error: string | null };

// Saves a linked bank. With replacesItemId, the bank it replaces is removed
// once the new link is saved.
export async function saveBankConnection(
  apiFetch: ApiFetch,
  link: PlaidLinkResult,
  replacesItemId?: string,
): Promise<SaveResult> {
  try {
    const response = await apiFetch("/api/plaid/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...link, replacesItemId: replacesItemId ?? null }),
    });

    if (response === null) {
      return { saved: false, error: null };
    }

    return response.ok
      ? { saved: true, error: null }
      : { saved: false, error: errorMessage(await readJson(response), "Bank connection couldn't be saved.") };
  } catch {
    return { saved: false, error: "Bank connection couldn't be saved." };
  }
}
