import "server-only";

import {
  AccountBase,
  Configuration,
  CountryCode,
  InvestmentsHoldingsGetResponse,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";

let client: PlaidApi | undefined;

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
    transactions: { days_requested: 180 },
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

export async function syncFinancialTransactions(
  accessToken: string,
  cursor?: string,
) {
  const response = await getPlaidClient().transactionsSync({
    access_token: accessToken,
    cursor,
  });

  return response.data;
}

export async function getInvestmentHoldings(
  accessToken: string,
): Promise<InvestmentsHoldingsGetResponse> {
  const response = await getPlaidClient().investmentsHoldingsGet({
    access_token: accessToken,
  });

  return response.data;
}
