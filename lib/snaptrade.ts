import "server-only";

import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";

export type SnapTradeUserCredentials = {
  userId: string;
  userSecret: string;
};

type SnapTradeClient = Snaptrade<
  ReturnType<typeof SnaptradeAuth.commercialApiKey>
>;

let client: SnapTradeClient | undefined;

function getSnapTradeClient(): SnapTradeClient {
  const clientId = process.env.SNAPTRADE_CLIENT_ID;
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY;

  if (!clientId || !consumerKey) {
    throw new Error(
      "SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY must be configured",
    );
  }

  if (!client) {
    client = new Snaptrade({
      auth: SnaptradeAuth.commercialApiKey({ clientId, consumerKey }),
    });
  }

  return client;
}

export async function checkSnapTradeConnection() {
  const response = await getSnapTradeClient().apiStatus.check();

  return {
    connected: response.status === 200,
    status: response.status,
  };
}

export async function registerSnapTradeUser(userId: string) {
  const response = await getSnapTradeClient().authentication.registerSnapTradeUser({
    userId,
  });

  return response.data;
}

export async function createBrokerageConnectionUrl(
  credentials: SnapTradeUserCredentials,
  redirectUrl?: string,
) {
  const broker = process.env.SNAPTRADE_BROKER?.trim() || undefined;
  const response = await getSnapTradeClient().authentication.loginSnapTradeUser({
    ...credentials,
    broker,
    connectionType: "read",
    customRedirect: redirectUrl,
  });

  if (!("redirectURI" in response.data) || !response.data.redirectURI) {
    throw new Error("SnapTrade did not return a brokerage connection URL");
  }

  return response.data.redirectURI;
}

export async function listBrokerageAccounts(
  credentials: SnapTradeUserCredentials,
) {
  const response = await getSnapTradeClient().accountInformation.listUserAccounts(
    credentials,
  );

  return response.data;
}

export async function getBrokerageAccountPositions(
  credentials: SnapTradeUserCredentials,
  accountId: string,
) {
  const response =
    await getSnapTradeClient().accountInformation.getAllAccountPositions({
      ...credentials,
      accountId,
    });

  return response.data;
}

export async function getBrokerageAccountBalances(
  credentials: SnapTradeUserCredentials,
  accountId: string,
) {
  const response =
    await getSnapTradeClient().accountInformation.getUserAccountBalance({
      ...credentials,
      accountId,
    });

  return response.data;
}
