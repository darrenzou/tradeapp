import "server-only";

import {
  AccountBase,
  Configuration,
  CountryCode,
  InvestmentsHoldingsGetResponse,
  InvestmentsTransactionsGetResponse,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type Transaction,
  TransactionsUpdateStatus,
} from "plaid";

let client: PlaidApi | undefined;

// The most transaction history Plaid will fetch from an institution (24 months).
export const PLAID_MAX_TRANSACTION_DAYS = 730;

function getPlaidClient() {
  const environment = process.env.PLAID_ENV ?? "sandbox";
  const clientId = process.env.PLAID_CLIENT_ID ?? process.env.CLIENT_ID;
  const secret =
    process.env.PLAID_SECRET ??
    (environment === "production"
      ? process.env.PLAID_PRODUCTION_SECRET ?? process.env.PRODUCTION_SECRET
      : process.env.PLAID_SANDBOX_SECRET ?? process.env.SANDBOX_SECRET);

  if (!clientId || !secret) {
    throw new Error("Plaid client ID and secret must be configured");
  }
  if (!(environment in PlaidEnvironments)) {
    throw new Error("PLAID_ENV must be sandbox or production");
  }

  if (!client) {
    client = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[environment],
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": clientId,
            "PLAID-SECRET": secret,
          },
        },
      }),
    );
  }

  return client;
}

export async function checkPlaidConnection() {
  const response = await getPlaidClient().institutionsSearch({
    query: "Chase",
    country_codes: [CountryCode.Us],
    products: null,
  });

  return {
    connected: response.status === 200,
    status: response.status,
  };
}

export async function createFinancialAccountLinkToken(
  clientUserId: string,
  redirectUri?: string,
) {
  const response = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: clientUserId },
    client_name: "Tradeapp",
    products: [Products.Transactions],
    additional_consented_products: [Products.Liabilities, Products.Investments],
    country_codes: [CountryCode.Us],
    language: "en",
    redirect_uri: redirectUri,
    // Plaid's maximum. It can't be raised on an Item after linking: Items
    // linked with less keep their original history until reconnected.
    transactions: { days_requested: PLAID_MAX_TRANSACTION_DAYS },
  });

  return response.data.link_token;
}

export async function exchangeFinancialAccountPublicToken(
  publicToken: string,
) {
  const response = await getPlaidClient().itemPublicTokenExchange({
    public_token: publicToken,
  });

  return response.data;
}

// Revokes an Item's access token at Plaid. The Item's row is deleted separately.
export async function removeFinancialAccountItem(accessToken: string): Promise<void> {
  await getPlaidClient().itemRemove({ access_token: accessToken });
}

// Includes investment accounts: brokerages SnapTrade does not support, such as
// Merrill Edge and Merrill Benefits OnLine 401(k)s, connect through Plaid.
export async function listFinancialAccounts(
  accessToken: string,
): Promise<AccountBase[]> {
  const response = await getPlaidClient().accountsGet({
    access_token: accessToken,
  });

  return response.data.accounts;
}

const TRANSACTIONS_SYNC_PAGE_SIZE = 500;
const MAX_SYNC_RESTARTS = 3;

export type TransactionHistory = {
  transactions: Transaction[];
  accounts: AccountBase[];
  // False while Plaid is still fetching older history from the institution.
  historicalComplete: boolean;
};

function isSyncMutationError(error: unknown): boolean {
  const code = (error as { response?: { data?: { error_code?: unknown } } })?.response?.data?.error_code;
  return code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
}

// Every posted and pending transaction Plaid holds for an Item, read from the
// start of /transactions/sync. Nothing is stored, so no cursor is kept.
export async function listAllTransactions(accessToken: string): Promise<TransactionHistory> {
  for (let attempt = 0; ; attempt += 1) {
    const byId = new Map<string, Transaction>();
    let accounts: AccountBase[] = [];
    let cursor: string | undefined;
    let status: TransactionsUpdateStatus | undefined;

    try {
      for (;;) {
        const response = await getPlaidClient().transactionsSync({
          access_token: accessToken,
          cursor,
          count: TRANSACTIONS_SYNC_PAGE_SIZE,
        });
        const page = response.data;

        for (const transaction of [...page.added, ...page.modified]) {
          byId.set(transaction.transaction_id, transaction);
        }
        for (const removed of page.removed) {
          byId.delete(removed.transaction_id);
        }
        accounts = page.accounts.length > 0 ? page.accounts : accounts;
        status = page.transactions_update_status;
        cursor = page.next_cursor;

        if (!page.has_more) {
          break;
        }
      }
    } catch (error) {
      // Plaid asks for pagination to restart when data changes mid-read.
      if (isSyncMutationError(error) && attempt < MAX_SYNC_RESTARTS) {
        continue;
      }
      throw error;
    }

    return {
      transactions: [...byId.values()],
      accounts,
      historicalComplete: status !== TransactionsUpdateStatus.NotReady && status !== TransactionsUpdateStatus.InitialUpdateComplete,
    };
  }
}

export async function getInvestmentHoldings(
  accessToken: string,
): Promise<InvestmentsHoldingsGetResponse> {
  const response = await getPlaidClient().investmentsHoldingsGet({
    access_token: accessToken,
  });

  return response.data;
}

const INVESTMENT_TRANSACTIONS_PAGE_SIZE = 500;

// All investment transactions between two YYYY-MM-DD dates (Plaid keeps up
// to 24 months), with the securities they reference and the item's accounts.
export async function listInvestmentTransactions(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<Pick<InvestmentsTransactionsGetResponse, "accounts" | "investment_transactions" | "securities">> {
  const transactions: InvestmentsTransactionsGetResponse["investment_transactions"] = [];
  const securities: InvestmentsTransactionsGetResponse["securities"] = [];
  let accounts: InvestmentsTransactionsGetResponse["accounts"] = [];

  for (;;) {
    const response = await getPlaidClient().investmentsTransactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: INVESTMENT_TRANSACTIONS_PAGE_SIZE,
        offset: transactions.length,
      },
    });
    const page: InvestmentsTransactionsGetResponse = response.data;

    accounts = page.accounts;
    transactions.push(...page.investment_transactions);
    securities.push(...page.securities);

    if (
      page.investment_transactions.length === 0 ||
      transactions.length >= page.total_investment_transactions
    ) {
      return { accounts, investment_transactions: transactions, securities };
    }
  }
}
