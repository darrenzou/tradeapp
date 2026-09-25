import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";

const fileArgument = process.argv.find((argument) => argument.startsWith("--file="));
const reportArgument = process.argv.find((argument) => argument.startsWith("--report="));
const envFile = resolve(fileArgument?.slice("--file=".length) || ".env");
const reportFile = reportArgument
  ? resolve(reportArgument.slice("--report=".length))
  : null;

const results = new Map();
const serviceChecks = [];
const handledNames = new Set();
const rank = { pass: 0, warn: 1, fail: 2 };

function addResult(name, status, message) {
  if (!name) return;
  handledNames.add(name);
  const current = results.get(name);
  if (!current || rank[status] >= rank[current.status]) {
    results.set(name, { status, message });
  }
}

function addService(service, status, message) {
  serviceChecks.push({ service, status, message });
}

function findFirst(values, names) {
  return names.find((name) => values[name]);
}

function possibleHttpReasons(service, responseStatus, providerCode) {
  if (responseStatus === 401 || responseStatus === 403) {
    return `${service} rejected the credential (${providerCode || `HTTP ${responseStatus}`}). Possible reasons: the value is incomplete or revoked, the paired credentials come from different projects, the wrong environment was selected, or the product is not enabled.`;
  }
  if (responseStatus === 429) {
    return `${service} rate-limited the request. The credential may be valid, but its current quota is exhausted.`;
  }
  if (responseStatus >= 500) {
    return `${service} returned HTTP ${responseStatus}. The provider may be temporarily unavailable; retry before replacing credentials.`;
  }
  return `${service} returned ${providerCode || `HTTP ${responseStatus}`}. Check the provider dashboard, account status, enabled products, and environment.`;
}

function possibleNetworkReasons(service, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `${service} could not be reached (${detail}). Possible reasons: DNS, proxy, firewall, TLS inspection, an unavailable host, or a temporary provider outage.`;
}

function inspectStaticValue(name, value) {
  if (!value.trim()) {
    addResult(name, "fail", "Blank value. Add the value after the equals sign and verify that the intended environment file is being loaded.");
    return;
  }

  const normalized = value.trim().toLowerCase();
  if (
    /^(changeme|replace[_ -]?me|todo|null|undefined|your[_ -])/.test(normalized) ||
    /^<.+>$/.test(normalized) ||
    /^x{4,}$/.test(normalized)
  ) {
    addResult(name, "fail", "The value looks like a placeholder. Replace it with the value from the provider dashboard.");
    return;
  }

  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
    addResult(name, "warn", "Contains an environment-variable reference. Node does not expand ${NAME} references in env files automatically.");
    return;
  }

  if (name.endsWith("_URL")) {
    try {
      new URL(value);
    } catch {
      addResult(name, "fail", "Not a valid URL. Check the scheme, hostname, escaping, quotes, and whitespace.");
      return;
    }
  }

  if (name.startsWith("NEXT_PUBLIC_") && /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD)/.test(name)) {
    addResult(name, "fail", "Secret-looking variable uses NEXT_PUBLIC_, which exposes it to browser code. Keep it server-only.");
    return;
  }

  addResult(name, "pass", "Present and structurally valid. The value was not printed.");
}

async function checkPlaid(values) {
  const environment = (
    values.PLAID_ENV ??
    (values.PLAID_PRODUCTION_SECRET || values.PRODUCTION_SECRET ? "production" : "sandbox")
  ).toLowerCase();
  const clientName = findFirst(values, ["PLAID_CLIENT_ID", "CLIENT_ID"]);
  const secretName = findFirst(
    values,
    environment === "production"
      ? ["PLAID_PRODUCTION_SECRET", "PRODUCTION_SECRET", "PLAID_SECRET"]
      : ["PLAID_SANDBOX_SECRET", "SANDBOX_SECRET", "PLAID_SECRET"],
  );

  if (!clientName && !secretName) return;

  if (!new Set(["sandbox", "production"]).has(environment)) {
    addResult(clientName, "fail", "PLAID_ENV must be sandbox or production.");
    addResult(secretName, "fail", "PLAID_ENV must be sandbox or production.");
    addService("Plaid", "fail", "Invalid PLAID_ENV. A misspelling selects an invalid Plaid host.");
    return;
  }

  if (!clientName || !secretName) {
    const missing = !clientName ? "client ID" : `${environment} secret`;
    addResult(clientName || secretName, "fail", `Plaid authentication needs both values; the ${missing} is missing.`);
    addService("Plaid", "fail", `Missing Plaid ${missing}.`);
    return;
  }

  try {
    const response = await fetch(`https://${environment}.plaid.com/institutions/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Plaid-Version": "2020-09-14",
        "PLAID-CLIENT-ID": values[clientName],
        "PLAID-SECRET": values[secretName],
      },
      body: JSON.stringify({ query: "Chase", products: null, country_codes: ["US"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = possibleHttpReasons("Plaid", response.status, body.error_code);
      addResult(clientName, "fail", message);
      addResult(secretName, "fail", message);
      addService(`Plaid ${environment}`, "fail", message);
      return;
    }

    const message = `Authenticated successfully against Plaid ${environment}.`;
    addResult(clientName, "pass", message);
    addResult(secretName, "pass", message);
    addService(`Plaid ${environment}`, "pass", message);
  } catch (error) {
    const message = possibleNetworkReasons("Plaid", error);
    addResult(clientName, "warn", message);
    addResult(secretName, "warn", message);
    addService(`Plaid ${environment}`, "warn", message);
  }
}

async function checkSnapTrade(values) {
  const clientName = "SNAPTRADE_CLIENT_ID";
  const keyName = "SNAPTRADE_CONSUMER_KEY";
  if (!values[clientName] && !values[keyName]) return;

  if (!values[clientName] || !values[keyName]) {
    const missing = !values[clientName] ? clientName : keyName;
    addResult(values[clientName] ? clientName : keyName, "fail", `SnapTrade requires ${missing}.`);
    addService("SnapTrade", "fail", `Missing ${missing}.`);
    return;
  }

  try {
    const { Snaptrade, SnaptradeAuth } = await import("snaptrade-typescript-sdk");
    const snaptrade = new Snaptrade({
      auth: SnaptradeAuth.commercialApiKey({
        clientId: values[clientName],
        consumerKey: values[keyName],
      }),
    });
    const response = await snaptrade.apiStatus.check();

    if (response.status !== 200) {
      const message = possibleHttpReasons("SnapTrade", response.status);
      addResult(clientName, "fail", message);
      addResult(keyName, "fail", message);
      addService("SnapTrade", "fail", message);
      return;
    }

    const message = "Authenticated successfully against SnapTrade.";
    addResult(clientName, "pass", message);
    addResult(keyName, "pass", message);
    addService("SnapTrade", "pass", message);
  } catch (error) {
    const responseStatus = error?.response?.status;
    const message = responseStatus
      ? possibleHttpReasons("SnapTrade", responseStatus)
      : possibleNetworkReasons("SnapTrade", error);
    addResult(clientName, responseStatus ? "fail" : "warn", message);
    addResult(keyName, responseStatus ? "fail" : "warn", message);
    addService("SnapTrade", responseStatus ? "fail" : "warn", message);
  }
}

async function checkSupabaseGroup(values, label, urlName, keyNames) {
  const presentKeyNames = keyNames.filter((name) => values[name]);
  if (!values[urlName] && presentKeyNames.length === 0) return;

  if (!values[urlName]) {
    for (const name of presentKeyNames) {
      addResult(name, "fail", `${label} cannot be tested because ${urlName} is missing.`);
    }
    addService(label, "fail", `Missing ${urlName}.`);
    return;
  }

  if (presentKeyNames.length === 0) {
    addResult(urlName, "fail", `${label} has no publishable, anonymous, service-role, or secret API key to test.`);
    addService(label, "fail", "No API key is configured.");
    return;
  }

  let successfulKeys = 0;
  for (const keyName of presentKeyNames) {
    try {
      const isPublicKey = /(ANON|PUBLISHABLE)/.test(keyName);
      const endpoint = isPublicKey ? "/auth/v1/settings" : "/rest/v1/";
      const response = await fetch(`${values[urlName].replace(/\/$/, "")}${endpoint}`, {
        headers: {
          apikey: values[keyName],
          Accept: isPublicKey ? "application/json" : "application/openapi+json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message = possibleHttpReasons(label, response.status, body.code || body.message);
        addResult(keyName, "fail", message);
        addService(`${label} with ${keyName}`, "fail", message);
        continue;
      }

      successfulKeys += 1;
      const message = `Accepted by ${label}'s ${isPublicKey ? "Auth" : "REST"} API.`;
      addResult(keyName, "pass", message);
      addService(`${label} with ${keyName}`, "pass", message);
    } catch (error) {
      const message = possibleNetworkReasons(label, error);
      addResult(keyName, "warn", message);
      addService(`${label} with ${keyName}`, "warn", message);
    }
  }

  if (successfulKeys > 0) {
    addResult(urlName, "pass", `${label} URL responded and accepted ${successfulKeys} configured key(s).`);
  } else {
    addResult(urlName, "fail", `${label} URL did not accept any configured key. The URL may belong to a different project, or all keys may be expired/revoked.`);
  }
}

function base64UrlBuffer(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyHs256Jwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = base64UrlBuffer(parts[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function checkSupabaseJwtSecret(values) {
  const name = "SUPABASE_JWT_SECRET";
  if (!values[name]) return;
  const legacyJwtName = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"].find(
    (candidate) => values[candidate]?.split(".").length === 3,
  );

  if (!legacyJwtName) {
    addResult(name, "warn", "Present, but no legacy Supabase JWT key is available for a safe local signature comparison. New sb_secret_/sb_publishable_ keys cannot validate the JWT secret.");
    return;
  }

  if (verifyHs256Jwt(values[legacyJwtName], values[name])) {
    addResult(name, "pass", `Correctly verifies the signature of ${legacyJwtName}.`);
  } else {
    addResult(name, "fail", `Does not verify ${legacyJwtName}. Possible reasons: it belongs to another Supabase project, it was rotated, or the paired key is not current.`);
  }
}

async function checkPostgres(values) {
  const urlNames = ["POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "POSTGRES_PRISMA_URL"].filter(
    (name) => values[name],
  );
  const componentNames = ["POSTGRES_DATABASE", "POSTGRES_HOST", "POSTGRES_PASSWORD", "POSTGRES_USER"].filter(
    (name) => values[name],
  );
  if (urlNames.length === 0 && componentNames.length === 0) return;

  let successfulUrl = null;
  const parsedUrls = new Map();

  for (const name of urlNames) {
    let parsed;
    try {
      parsed = new URL(values[name]);
      if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
        throw new Error("URL must use postgres:// or postgresql://");
      }
      parsedUrls.set(name, parsed);
    } catch (error) {
      addResult(name, "fail", `Invalid PostgreSQL URL. ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let sql;
    try {
      sql = postgres(values[name], {
        max: 1,
        connect_timeout: 15,
        idle_timeout: 1,
        prepare: false,
      });
      await sql.unsafe("select 1 as connection_test");
      successfulUrl ||= name;
      const message = "Connected and authenticated successfully; a read-only SELECT 1 query completed.";
      addResult(name, "pass", message);
      addService(`Postgres via ${name}`, "pass", message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `PostgreSQL connection failed (${detail}). Possible reasons: wrong username/password, a rotated database password, incorrect host/port, pooler versus direct-connection mismatch, missing SSL requirements, DNS/IPv6 restrictions, or a paused Supabase project.`;
      addResult(name, "fail", message);
      addService(`Postgres via ${name}`, "fail", message);
    } finally {
      if (sql) await sql.end({ timeout: 1 }).catch(() => {});
    }
  }

  const preferred = parsedUrls.get("POSTGRES_URL_NON_POOLING") ?? (successfulUrl ? parsedUrls.get(successfulUrl) : null);
  const comparisons = {
    POSTGRES_DATABASE: preferred ? decodeURIComponent(preferred.pathname.replace(/^\//, "")) : null,
    POSTGRES_HOST: preferred?.hostname ?? null,
    POSTGRES_PASSWORD: preferred ? decodeURIComponent(preferred.password) : null,
    POSTGRES_USER: preferred ? decodeURIComponent(preferred.username) : null,
  };

  for (const name of componentNames) {
    if (!successfulUrl) {
      addResult(name, "fail", "Could not validate this component because none of the configured PostgreSQL URLs authenticated successfully.");
    } else if (comparisons[name] && values[name] === comparisons[name]) {
      addResult(name, "pass", `Matches the corresponding component in the validated ${successfulUrl} connection.`);
    } else {
      addResult(name, "warn", `Does not match the preferred validated connection URL. This can be intentional for pooler usernames/hosts, but may also indicate stale Vercel or Supabase environment values.`);
    }
  }
}

async function checkAlpaca(values) {
  const keyName = findFirst(values, ["ALPACA_KEY", "ALPACA_API_KEY", "APCA_API_KEY_ID"]);
  const secretName = findFirst(values, ["ALPACA_SECRET", "ALPACA_API_SECRET", "APCA_API_SECRET_KEY"]);
  if (!keyName && !secretName) return;

  if (!keyName || !secretName) {
    addResult(keyName || secretName, "fail", "Alpaca requires both an API key and secret.");
    addService("Alpaca", "fail", "Missing the API key or secret.");
    return;
  }

  try {
    const response = await fetch("https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL&feed=iex", {
      headers: {
        "APCA-API-KEY-ID": values[keyName],
        "APCA-API-SECRET-KEY": values[secretName],
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = possibleHttpReasons("Alpaca", response.status, body.code || body.message);
      addResult(keyName, "fail", message);
      addResult(secretName, "fail", message);
      addService("Alpaca market data", "fail", message);
      return;
    }

    const message = "Authenticated successfully and retrieved a read-only IEX market-data snapshot.";
    addResult(keyName, "pass", message);
    addResult(secretName, "pass", message);
    addService("Alpaca market data", "pass", message);
  } catch (error) {
    const message = possibleNetworkReasons("Alpaca", error);
    addResult(keyName, "warn", message);
    addResult(secretName, "warn", message);
    addService("Alpaca market data", "warn", message);
  }
}

function checkVercelOidc(values) {
  const name = "VERCEL_OIDC_TOKEN";
  if (!values[name]) return;
  try {
    const parts = values[name].split(".");
    if (parts.length !== 3) throw new Error("not a three-part JWT");
    const payload = JSON.parse(base64UrlBuffer(parts[1]).toString("utf8"));
    if (typeof payload.exp !== "number") throw new Error("missing exp claim");

    if (payload.exp * 1000 <= Date.now()) {
      addResult(name, "fail", "The OIDC token is expired. These tokens are intentionally short-lived; refresh/pull the Vercel environment or obtain a new token in the deployment context.");
      addService("Vercel OIDC", "fail", "Token is structurally valid but expired.");
      return;
    }

    addResult(name, "pass", "JWT structure is valid and its expiration time is still in the future. The token value and claims were not printed.");
    addService("Vercel OIDC", "pass", "Token is structurally valid and unexpired.");
  } catch (error) {
    const message = `OIDC token is invalid (${error instanceof Error ? error.message : String(error)}). It may be truncated, copied from a stale environment, or not be a Vercel OIDC JWT.`;
    addResult(name, "fail", message);
    addService("Vercel OIDC", "fail", message);
  }
}

function formatStatus(status) {
  return status.toUpperCase().padEnd(5);
}

async function saveReport(lines) {
  if (!reportFile) return;
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${lines.join("\n")}\n`, "utf8");
}

let source;
try {
  source = await readFile(envFile, "utf8");
} catch (error) {
  const lines = [
    `FAIL  Could not read ${envFile}`,
    `      ${error instanceof Error ? error.message : "The file may not exist or may not be readable."}`,
  ];
  console.error(lines.join("\n"));
  await saveReport(lines);
  process.exit(1);
}

let values;
try {
  values = parseEnv(source);
} catch (error) {
  const lines = [
    `FAIL  ${envFile} could not be parsed.`,
    `      ${error instanceof Error ? error.message : String(error)} Possible reasons: an unclosed quote, malformed assignment, or unsupported variable name.`,
  ];
  console.error(lines.join("\n"));
  await saveReport(lines);
  process.exit(1);
}

const assignmentNames = source
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
  .filter(Boolean);
const duplicates = assignmentNames.filter((name, index) => assignmentNames.indexOf(name) !== index);

for (const [name, value] of Object.entries(values)) inspectStaticValue(name, value);
for (const name of new Set(duplicates)) {
  addResult(name, "fail", "Assigned more than once. Node uses the final assignment, which can hide an old or incorrect value.");
}

await checkPlaid(values);
await checkSnapTrade(values);
await checkSupabaseGroup(
  values,
  "Supabase primary",
  "SUPABASE_URL",
  ["SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"],
);
await checkSupabaseGroup(
  values,
  "Supabase test",
  "TEST_SUPABASE_URL",
  ["TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_PUBLISHABLE_KEY"],
);
checkSupabaseJwtSecret(values);
await checkPostgres(values);
await checkAlpaca(values);
checkVercelOidc(values);

for (const name of Object.keys(values)) {
  if (!handledNames.has(name) && results.get(name)?.status === "pass") {
    addResult(name, "warn", "Present and structurally valid, but no safe live validator is registered for this variable name.");
  }
}

const lines = [
  `Environment diagnostics: ${envFile}`,
  "Secret values are never printed or written to the report.",
  "",
  "Variables",
];

if (Object.keys(values).length === 0) {
  lines.push("FAIL  No variables were found.");
  lines.push("      Add NAME=value assignments or select the correct file.");
} else {
  for (const name of Object.keys(values).sort()) {
    const result = results.get(name);
    lines.push(`${formatStatus(result.status)} ${name}`);
    lines.push(`      ${result.message}`);
  }
}

if (serviceChecks.length > 0) {
  lines.push("", "Service checks");
  for (const check of serviceChecks) {
    lines.push(`${formatStatus(check.status)} ${check.service}`);
    lines.push(`      ${check.message}`);
  }
}

const counts = { pass: 0, warn: 0, fail: 0 };
for (const result of results.values()) counts[result.status] += 1;
lines.push("", "Summary");
lines.push(`      ${Object.keys(values).length} variable(s): ${counts.pass} passed, ${counts.warn} warning(s), ${counts.fail} failed.`);
if (reportFile) lines.push(`      Redacted report: ${reportFile}`);

console.log(lines.join("\n"));
await saveReport(lines);
if (counts.fail > 0 || Object.keys(values).length === 0) process.exitCode = 1;
