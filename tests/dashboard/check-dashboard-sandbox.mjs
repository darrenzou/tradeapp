// End-to-end check of the dashboard against the Plaid and SnapTrade sandboxes.
//
// Starts the app, creates a disposable user, signs in, links a Plaid sandbox
// bank the same way Plaid Link would, checks the dashboard totals against
// Plaid's own account data and live Alpaca quotes, registers the user with
// SnapTrade, and then removes the Plaid item, the SnapTrade user, and the
// Supabase user.
//
// It refuses to run unless PLAID_ENV=sandbox and SNAPTRADE_BROKER=SANDBOX.
// Pass --allow-main to use the main Supabase project when no separate test
// project is configured. No credentials, tokens, or balances are printed.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";

import {
  decryptToken,
  isEncryptedToken,
  plaidAccessTokenContext,
  snaptradeSecretContext,
} from "../../lib/token-crypto.ts";

const SESSION_COOKIE_NAME = "tradeapp_session";
const READINESS_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PLAID_SANDBOX_URL = "https://sandbox.plaid.com";
// First Platypus Bank: the default sandbox login returns checking, savings,
// credit card, loan, and investment accounts.
const PLAID_SANDBOX_INSTITUTION = "ins_109508";

const TEST_USERNAME = `dashcheck_${randomBytes(8).toString("hex")}`;
const TEST_PASSWORD = `DashCheck-${randomBytes(8).toString("hex")}`;
const TEST_INVITE_CODE = randomBytes(18).toString("hex");
const TEST_USERNAME_MAPPING_SECRET = randomBytes(32).toString("hex");
const PROJECT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

class CheckError extends Error {}

function fail(message) {
  throw new CheckError(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function env(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function cents(value) {
  return Math.round(value * 100);
}

function selectProject(allowMain) {
  const test = {
    url: env("TEST_SUPABASE_URL"),
    serviceRoleKey: env("TEST_SUPABASE_SERVICE_ROLE_KEY"),
    publicKey: env("TEST_SUPABASE_PUBLISHABLE_KEY") ?? env("TEST_SUPABASE_ANON_KEY"),
  };
  const main = {
    url: env("SUPABASE_URL"),
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    publicKey: env("SUPABASE_PUBLISHABLE_KEY") ?? env("SUPABASE_ANON_KEY"),
  };

  if (test.url && test.serviceRoleKey && test.publicKey && test.url !== main.url) {
    return test;
  }

  assert(
    allowMain,
    "No separate test Supabase project is configured. Pass --allow-main to use disposable data in the main project.",
  );
  assert(main.url && main.serviceRoleKey && main.publicKey, "Main Supabase configuration is incomplete.");
  return main;
}

function plaidCredentials() {
  const clientId = env("PLAID_CLIENT_ID") ?? env("CLIENT_ID");
  const secret = env("PLAID_SECRET") ?? env("PLAID_SANDBOX_SECRET") ?? env("SANDBOX_SECRET");
  assert(clientId && secret, "Plaid sandbox client ID and secret are not configured.");
  return { client_id: clientId, secret };
}

async function plaid(path, body) {
  const response = await fetch(`${PLAID_SANDBOX_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...plaidCredentials(), ...body }),
  });
  const json = await response.json().catch(() => null);
  assert(response.ok && json !== null, `Plaid sandbox ${path} failed (${json?.error_code ?? response.status}).`);
  return json;
}

async function alpacaQuotes(symbols) {
  const keyId = env("ALPACA_KEY");
  const secretKey = env("ALPACA_SECRET");
  assert(keyId && secretKey, "Alpaca keys are not configured.");
  const quotes = new Map();
  if (symbols.length === 0) {
    return quotes;
  }
  const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
  url.searchParams.set("symbols", [...new Set(symbols)].join(","));
  url.searchParams.set("feed", "iex");
  const response = await fetch(url, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey } });
  assert(response.ok, `Alpaca snapshots returned ${response.status}.`);
  for (const [symbol, snapshot] of Object.entries(await response.json())) {
    if (snapshot?.latestTrade?.p > 0) {
      quotes.set(symbol, snapshot.latestTrade.p);
    }
  }
  return quotes;
}

function snaptradeClient() {
  const clientId = env("SNAPTRADE_CLIENT_ID");
  const consumerKey = env("SNAPTRADE_CONSUMER_KEY");
  assert(clientId && consumerKey, "SnapTrade credentials are not configured.");
  return new Snaptrade({ auth: SnaptradeAuth.commercialApiKey({ clientId, consumerKey }) });
}

async function call(baseUrl, path, { method = "GET", cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : { Origin: baseUrl }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json, response };
}

function sessionCookie(response) {
  const cookie = response
    .headers.getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert(cookie, "Login did not set a session cookie.");
  return cookie.split(";", 1)[0];
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function reservePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForReady(child, baseUrl) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assert(child.exitCode === null, "The local app server exited before it became ready.");
    try {
      const response = await fetch(`${baseUrl}/api/auth`, { signal: AbortSignal.timeout(3_000) });
      if (response.status === 200) {
        return;
      }
    } catch {
      // Still compiling.
    }
    await delay(250);
  }
  fail("The local app server did not become ready in time.");
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(SHUTDOWN_TIMEOUT_MS).then(() => false)])) {
    return;
  }
  child.kill("SIGKILL");
}

function checkSummary(dashboard, context) {
  const liabilities = new Set(["credit", "loan"]);
  const sum = (kinds) =>
    dashboard.accounts
      .filter((account) => kinds(account.kind))
      .reduce((total, account) => total + cents(account.balance), 0);

  const assets = sum((kind) => !liabilities.has(kind));
  const credit = sum((kind) => kind === "credit");
  const loans = sum((kind) => kind === "loan");

  assert(cents(dashboard.assets) === assets, `${context}: assets do not equal the sum of asset accounts.`);
  assert(cents(dashboard.creditCardBalance) === credit, `${context}: credit card balance does not equal the sum of cards.`);
  assert(cents(dashboard.loanBalance) === loans, `${context}: loan balance does not equal the sum of loans.`);
  assert(
    cents(dashboard.netWorth) === assets - credit - loans,
    `${context}: net worth is not assets minus credit cards minus loans.`,
  );
}

async function runCheck() {
  process.loadEnvFile(".env.local");
  assert(env("PLAID_ENV") === "sandbox", "PLAID_ENV must be sandbox for this check.");
  assert(env("SNAPTRADE_BROKER")?.toUpperCase() === "SANDBOX", "SNAPTRADE_BROKER must be SANDBOX for this check.");

  const project = selectProject(process.argv.slice(2).includes("--allow-main"));
  const admin = createClient(project.url, project.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const childEnv = {
    ...process.env,
    SUPABASE_URL: project.url,
    SUPABASE_SERVICE_ROLE_KEY: project.serviceRoleKey,
    SUPABASE_PUBLISHABLE_KEY: project.publicKey,
    SUPABASE_ANON_KEY: project.publicKey,
    AUTH_INVITE_CODE: TEST_INVITE_CODE,
    AUTH_USERNAME_MAPPING_SECRET: TEST_USERNAME_MAPPING_SECRET,
  };

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: PROJECT_ROOT, env: childEnv, stdio: "ignore", windowsHide: true },
  );

  let userId = null;
  const cleanupProblems = [];

  try {
    await waitForReady(child, baseUrl);

    const created = await call(baseUrl, "/api/auth", {
      method: "POST",
      body: {
        action: "create",
        username: TEST_USERNAME,
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
        inviteCode: TEST_INVITE_CODE,
      },
    });
    assert(created.status === 201, `Account creation returned ${created.status}.`);

    const login = await call(baseUrl, "/api/auth", {
      method: "POST",
      body: { action: "login", username: TEST_USERNAME, password: TEST_PASSWORD, remember: false },
    });
    assert(login.status === 200 && login.body?.authenticated === true, `Login returned ${login.status}.`);
    const cookie = sessionCookie(login.response);

    const session = await call(baseUrl, "/api/auth", { cookie });
    assert(session.body?.authenticated === true, "Session lookup failed after login.");
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    userId = users?.users.find((user) => user.app_metadata?.tradeapp_username === TEST_USERNAME)?.id ?? null;
    assert(userId, "Could not find the disposable user for cleanup.");
    console.log("ok   signed in as a disposable user");

    const empty = await call(baseUrl, "/api/dashboard", { cookie });
    assert(empty.status === 200, `Empty dashboard returned ${empty.status}.`);
    assert(
      empty.body.netWorth === 0 && empty.body.accounts.length === 0 && empty.body.brokerageConnected === false &&
        empty.body.plaidConnectionCount === 0,
      "A new user's dashboard is not empty.",
    );
    console.log("ok   empty dashboard shows $0 and no accounts");

    const linkToken = await call(baseUrl, "/api/plaid/link-token", { method: "POST", cookie });
    assert(linkToken.status === 200, `Plaid link token returned ${linkToken.status}.`);
    assert(linkToken.body.linkToken.startsWith("link-sandbox-"), "Link token is not a sandbox token.");
    console.log("ok   Plaid Link token issued by the sandbox");

    // Stand-in for completing Plaid Link with user_good / pass_good.
    const { public_token: publicToken } = await plaid("/sandbox/public_token/create", {
      institution_id: PLAID_SANDBOX_INSTITUTION,
      initial_products: ["transactions"],
    });
    const exchanged = await call(baseUrl, "/api/plaid/exchange", {
      method: "POST",
      cookie,
      body: { publicToken, institutionName: "First Platypus Bank" },
    });
    assert(exchanged.status === 200, `Plaid exchange returned ${exchanged.status}.`);
    console.log("ok   Plaid sandbox bank connected and stored");

    const { data: items } = await admin.from("plaid_items").select("item_id, access_token").eq("user_id", userId);
    assert(items?.length === 1, "The Plaid item was not stored for the user.");
    assert(isEncryptedToken(items[0].access_token), "The Plaid access token was stored unencrypted.");
    const accessToken = decryptToken(items[0].access_token, plaidAccessTokenContext(userId, items[0].item_id));
    assert(accessToken.startsWith("access-sandbox-"), "The stored Plaid access token doesn't decrypt to a sandbox token.");
    assert(
      exchanged.body && !JSON.stringify(exchanged.body).includes(accessToken),
      "The Plaid access token was returned to the browser.",
    );
    console.log("ok   Plaid access token stored encrypted and decrypts with TOKEN_ENCRYPTION_KEY");

    // A plaintext token saved before encryption existed is still read, and
    // is encrypted in place on first use.
    await admin.from("plaid_items").update({ access_token: accessToken }).eq("item_id", items[0].item_id);
    const legacyRead = await call(baseUrl, "/api/dashboard", { cookie });
    assert(legacyRead.status === 200 && legacyRead.body.issues.length === 0, "Dashboard failed to read a plaintext (pre-encryption) token.");
    let reencrypted = false;
    for (let attempt = 0; attempt < 20 && !reencrypted; attempt += 1) {
      const { data: row } = await admin.from("plaid_items").select("access_token").eq("item_id", items[0].item_id).single();
      reencrypted = isEncryptedToken(row.access_token);
      if (!reencrypted) {
        await delay(250);
      }
    }
    assert(reencrypted, "A plaintext token was not re-encrypted after being read.");
    console.log("ok   pre-encryption plaintext token still works and is re-encrypted on first read");

    const dashboard = await call(baseUrl, "/api/dashboard", { cookie });
    assert(dashboard.status === 200, `Dashboard returned ${dashboard.status}.`);
    assert(!JSON.stringify(dashboard.body).includes(accessToken), "The dashboard leaked the Plaid access token.");
    assert(dashboard.body.issues.length === 0, `Dashboard reported issues: ${dashboard.body.issues.join(" ")}`);
    checkSummary(dashboard.body, "Plaid dashboard");

    // Independent expectation from Plaid's own data for the same item.
    const { accounts } = await plaid("/accounts/get", { access_token: accessToken });
    const kindByPlaidType = {
      depository: "cash",
      credit: "credit",
      loan: "loan",
      investment: "investment",
      brokerage: "investment",
      other: "other",
    };
    const expected = { cash: 0, credit: 0, loan: 0, other: 0 };
    const plaidInvestments = new Map();
    for (const account of accounts) {
      const kind = kindByPlaidType[account.type];
      if (kind === "investment" && account.balances.current !== null) {
        plaidInvestments.set(account.account_id, account.balances.current);
      } else if (kind !== undefined && account.balances.current !== null) {
        expected[kind] += cents(account.balances.current);
      }
    }
    const byKind = (kind) => dashboard.body.accounts.filter((account) => account.kind === kind);
    const sumCents = (list) => list.reduce((total, account) => total + cents(account.balance), 0);
    const kinds = new Set(dashboard.body.accounts.map((account) => account.kind));
    assert(kinds.has("cash") && kinds.has("credit"), "Expected checking/savings and a credit card from the sandbox bank.");
    assert(cents(dashboard.body.creditCardBalance) === expected.credit, "Credit card balance does not match Plaid.");
    assert(cents(dashboard.body.loanBalance) === expected.loan, "Loan balance does not match Plaid.");
    assert(
      sumCents([...byKind("cash"), ...byKind("other")]) === expected.cash + expected.other,
      "Cash and other balances do not match Plaid.",
    );
    console.log(
      `ok   dashboard totals match Plaid (${dashboard.body.accounts.length} accounts: ` +
        `${[...kinds].sort().join(", ")})`,
    );

    // Live pricing: recompute each investment account from Plaid holdings and
    // the test's own Alpaca quotes. Prices can move between the app's request
    // and ours, so live accounts get a small tolerance.
    const investments = byKind("investment");
    assert(investments.length === plaidInvestments.size, "Plaid investment accounts (IRA, 401k) are missing from the dashboard.");
    const holdingsData = await plaid("/investments/holdings/get", { access_token: accessToken });
    const securities = new Map(holdingsData.securities.map((security) => [security.security_id, security]));
    const priced = holdingsData.holdings
      .map((holding) => ({ holding, security: securities.get(holding.security_id) }))
      .filter(({ security }) => ["equity", "etf"].includes(security?.type) && /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(security?.ticker_symbol ?? ""));
    const quotes = await alpacaQuotes(priced.map(({ security }) => security.ticker_symbol));
    let liveAccounts = 0;
    for (const [accountId, plaidBalance] of plaidInvestments) {
      const shown = investments.find((account) => account.id === `plaid:${accountId}`);
      assert(shown, "A Plaid investment account is missing from the dashboard.");
      let expectedValue = plaidBalance;
      for (const { holding, security } of priced) {
        const price = quotes.get(security.ticker_symbol);
        if (holding.account_id === accountId && price !== undefined && holding.institution_value !== null) {
          expectedValue += holding.quantity * price - holding.institution_value;
        }
      }
      if (shown.live) {
        liveAccounts += 1;
        assert(typeof shown.live.dayChange === "number" && !Number.isNaN(Date.parse(shown.live.asOf)), "Live account is missing its day change or quote time.");
        assert(Math.abs(shown.balance - expectedValue) <= Math.max(1, Math.abs(expectedValue) * 0.005), "A live account value is not the Plaid balance repriced with Alpaca quotes.");
      } else {
        assert(cents(shown.balance) === cents(plaidBalance), "An account without live prices does not match its Plaid balance.");
      }
    }
    assert(liveAccounts > 0, "No Plaid investment account was repriced with live Alpaca quotes.");
    assert(dashboard.body.pricesAsOf !== null, "Dashboard did not report when live prices were taken.");
    console.log(`ok   ${liveAccounts} of ${investments.length} Plaid investment accounts repriced with live Alpaca quotes`);

    // Stocks page: holdings combined by symbol, totals, and IRR inputs.
    const stocks = await call(baseUrl, "/api/stocks", { cookie });
    assert(stocks.status === 200, `Stocks returned ${stocks.status}.`);
    const s = stocks.body;
    assert(s.rows.length > 0, "Stocks page shows no holdings for the sandbox bank.");
    assert(new Set(s.rows.map((row) => row.key)).size === s.rows.length, "A symbol appears in more than one stocks row.");
    const near = (a, b) => Math.abs(a - b) <= 0.01;
    assert(near(s.totalValue, s.holdingsValue + s.cashValue + s.otherInvestmentsValue), "Total portfolio value is not holdings + cash + other.");
    assert(near(s.holdingsValue, s.rows.reduce((total, row) => total + row.marketValue, 0)), "Holdings value is not the sum of rows.");
    assert(near(s.dayPnl, s.rows.reduce((total, row) => total + (row.dayPnl ?? 0), 0)), "Today's P&L is not the sum of rows.");
    const bankCash = dashboard.body.accounts
      .filter((account) => account.kind === "cash" || account.kind === "other")
      .reduce((total, account) => total + account.balance, 0);
    assert(s.cashValue >= bankCash - 0.01, "Cash is missing bank balances.");
    assert(!s.rows.some((row) => /cash|dollar/i.test(row.securityType ?? "")), "Cash positions appear as stocks rows.");
    for (const row of s.rows) {
      assert(near(row.portfolioPercent * s.totalValue, row.marketValue), `${row.key}: % of portfolio is wrong.`);
      if (row.averagePrice !== null) {
        assert(near(row.totalPnl, row.marketValue - row.averagePrice * row.shares), `${row.key}: total P&L is not market value minus cost.`);
      }
      if (row.live) {
        assert(row.dayChangePercent !== null && row.dayPnl !== null, `${row.key}: live row is missing today's change.`);
      }
    }
    assert(s.rows.some((row) => row.live), "No stocks row uses live prices.");
    assert(s.rows.some((row) => row.irrStatus !== "unavailable"), "No stocks row has an IRR from Plaid transaction history.");
    assert(s.irrHoldings.included > 0 && s.irr !== null, "Portfolio IRR is missing.");
    assert(!JSON.stringify(s).includes(accessToken), "The stocks response leaked the Plaid access token.");
    console.log(
      `ok   stocks page: ${s.rows.length} holdings, ${s.rows.filter((row) => row.live).length} live, ` +
        `${s.irrHoldings.included} with IRR; totals add up`,
    );

    const brokerage = await call(baseUrl, "/api/snaptrade/connect", { method: "POST", cookie });
    assert(brokerage.status === 200, `SnapTrade connect returned ${brokerage.status}.`);
    assert(new URL(brokerage.body.url).protocol === "https:", "SnapTrade did not return an https portal URL.");
    const again = await call(baseUrl, "/api/snaptrade/connect", { method: "POST", cookie });
    assert(again.status === 200, "A second SnapTrade connect (existing user) failed.");
    const { data: snaptradeRow } = await admin
      .from("snaptrade_users")
      .select("snaptrade_user_id, snaptrade_user_secret")
      .eq("user_id", userId)
      .single();
    assert(isEncryptedToken(snaptradeRow.snaptrade_user_secret), "The SnapTrade user secret was stored unencrypted.");
    decryptToken(snaptradeRow.snaptrade_user_secret, snaptradeSecretContext(userId, snaptradeRow.snaptrade_user_id));
    console.log("ok   SnapTrade user registered (secret stored encrypted) and connection portal URL issued");

    const withBrokerage = await call(baseUrl, "/api/dashboard", { cookie });
    assert(withBrokerage.status === 200 && withBrokerage.body.brokerageConnected === true, "Dashboard did not load with SnapTrade registered.");
    assert(withBrokerage.body.issues.length === 0, `Dashboard reported issues: ${withBrokerage.body.issues.join(" ")}`);
    checkSummary(withBrokerage.body, "Dashboard with SnapTrade");
    console.log("ok   dashboard loads with SnapTrade registered");

    const signedOut = await call(baseUrl, "/api/dashboard");
    assert(signedOut.status === 401, "Dashboard is readable without a session.");
    const stocksSignedOut = await call(baseUrl, "/api/stocks");
    assert(stocksSignedOut.status === 401, "Stocks are readable without a session.");
    const foreign = await fetch(`${baseUrl}/api/plaid/link-token`, {
      method: "POST",
      headers: { Origin: "http://foreign.invalid", Cookie: cookie },
    });
    assert(foreign.status === 403, "Cross-origin Plaid request was not rejected.");
    console.log("ok   signed-out and cross-origin requests rejected");
  } finally {
    if (userId !== null) {
      const { data: items } = await admin.from("plaid_items").select("item_id, access_token").eq("user_id", userId);
      for (const item of items ?? []) {
        try {
          const token = isEncryptedToken(item.access_token)
            ? decryptToken(item.access_token, plaidAccessTokenContext(userId, item.item_id))
            : item.access_token;
          await plaid("/item/remove", { access_token: token });
        } catch {
          cleanupProblems.push("Plaid sandbox item");
        }
      }

      const { data: snaptradeUser } = await admin
        .from("snaptrade_users")
        .select("snaptrade_user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (snaptradeUser) {
        await snaptradeClient()
          .authentication.deleteSnapTradeUser({ userId: snaptradeUser.snaptrade_user_id })
          .catch(() => cleanupProblems.push("SnapTrade user"));
      }

      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) {
        cleanupProblems.push(`Supabase user ${TEST_USERNAME}`);
      }
    }

    await stopChild(child);

    if (cleanupProblems.length > 0) {
      process.exitCode = 1;
      console.error(`Cleanup incomplete; remove manually: ${cleanupProblems.join(", ")}.`);
    } else if (userId !== null) {
      console.log("ok   cleaned up Plaid item, SnapTrade user, and Supabase user");
    }
  }
}

runCheck().catch((error) => {
  process.exitCode = 1;
  console.error(
    error instanceof CheckError ? `Dashboard check failed: ${error.message}` : "Dashboard check failed unexpectedly.",
  );
});
