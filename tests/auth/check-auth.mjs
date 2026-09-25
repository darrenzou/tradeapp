import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { createClient } from "@supabase/supabase-js";

const SESSION_COOKIE_NAME = "tradeapp_session";
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_REQUEST_TIMEOUT_MS = 3_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const LIST_USERS_PAGE_SIZE = 100;

const TEST_PASSWORD_A = "AuthCheck-A-2026!";
const TEST_PASSWORD_B = "AuthCheck-B-2026!";
const TEST_USERNAME_A = `authcheck_a_${randomBytes(8).toString("hex")}`;
const TEST_USERNAME_B = `authcheck_b_${randomBytes(8).toString("hex")}`;
const TEST_INVITE_CODE = randomBytes(18).toString("hex");
const TEST_USERNAME_MAPPING_SECRET = randomBytes(32).toString("hex");
const PROJECT_ROOT = resolve(
  resolve(fileURLToPath(new URL(".", import.meta.url))),
  "..",
  "..",
);

class AuthCheckError extends Error {}

function fail(message) {
  throw new AuthCheckError(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function nonEmptyEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNodeError(value) {
  return typeof value === "object" && value !== null && "code" in value;
}

function loadLocalEnvironment() {
  try {
    process.loadEnvFile(".env.local");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    fail("Unable to load the local environment file.");
  }
}

function projectUrlKey(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function readProject(prefix) {
  const url = nonEmptyEnv(`${prefix}URL`);
  const serviceRoleKey = nonEmptyEnv(`${prefix}SERVICE_ROLE_KEY`);
  const publishableKey = nonEmptyEnv(`${prefix}PUBLISHABLE_KEY`);
  const anonKey = nonEmptyEnv(`${prefix}ANON_KEY`);

  return {
    url,
    serviceRoleKey,
    publicKey: publishableKey ?? anonKey,
  };
}

function requireValidProject(project, label) {
  assert(
    project.url !== null && project.serviceRoleKey !== null && project.publicKey !== null,
    `${label} Supabase configuration is incomplete.`,
  );

  try {
    const parsed = new URL(project.url);
    assert(parsed.protocol === "http:" || parsed.protocol === "https:", `${label} Supabase URL is invalid.`);
  } catch {
    fail(`${label} Supabase URL is invalid.`);
  }
}

function selectProject(allowMain) {
  const mainProject = readProject("SUPABASE_");
  const testProject = readProject("TEST_SUPABASE_");
  const hasSeparateTestProject =
    testProject.url !== null &&
    testProject.serviceRoleKey !== null &&
    testProject.publicKey !== null &&
    (mainProject.url === null || projectUrlKey(testProject.url) !== projectUrlKey(mainProject.url));

  if (hasSeparateTestProject) {
    requireValidProject(testProject, "Test");
    return { ...testProject, label: "test" };
  }

  if (!allowMain) {
    fail(
      "A separate test Supabase project is not fully configured or is the main project. " +
        "Set TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY, and TEST_SUPABASE_PUBLISHABLE_KEY " +
        "or TEST_SUPABASE_ANON_KEY, or pass --allow-main to opt in to disposable users in the main project.",
    );
  }

  requireValidProject(mainProject, "Main");
  return { ...mainProject, label: "main" };
}

function deriveAlias(username) {
  const digest = createHmac("sha256", TEST_USERNAME_MAPPING_SECRET)
    .update(username, "utf8")
    .digest("hex");
  return `${username}.${digest}@users.tradeapp.invalid`;
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const value = response.headers.get("set-cookie");
  return value === null ? [] : [value];
}

function assertNoStore(response, context) {
  assert(
    response.headers.get("cache-control")?.toLowerCase() === "no-store",
    `${context} did not return Cache-Control: no-store.`,
  );
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    fail(`${context} returned a non-JSON response.`);
  }

  return { response, body, text };
}

async function requestJson(url, options, context) {
  let response;

  try {
    response = await fetch(url, { cache: "no-store", ...options });
  } catch {
    fail(`${context} request failed.`);
  }

  assertNoStore(response, context);
  return readJsonResponse(response, context);
}

function expectStatus(result, status, context) {
  assert(result.response.status === status, `${context} returned an unexpected status.`);
}

function expectError(result, status, error, context) {
  expectStatus(result, status, context);
  assert(
    typeof result.body === "object" && result.body !== null && result.body.error === error,
    `${context} returned an unexpected error.`,
  );
}

function expectUnauthenticated(result, context) {
  expectStatus(result, 200, context);
  assert(
    typeof result.body === "object" && result.body !== null && result.body.authenticated === false,
    `${context} did not return unauthenticated status.`,
  );
}

function expectAuthenticated(result, username, context) {
  expectStatus(result, 200, context);
  assert(
    typeof result.body === "object" &&
      result.body !== null &&
      result.body.authenticated === true &&
      result.body.username === username,
    `${context} did not return the expected username.`,
  );
  assert(!result.text.includes("access_token"), `${context} exposed an access token.`);
  assert(!result.text.includes("refresh_token"), `${context} exposed a refresh token.`);
  assert(!result.text.includes("users.tradeapp.invalid"), `${context} exposed an internal alias.`);
}

function sessionCookieHeader(result, context) {
  const cookies = getSetCookieHeaders(result.response);
  const cookie = cookies.find((value) =>
    value.toLowerCase().startsWith(`${SESSION_COOKIE_NAME}=`),
  );

  assert(cookie !== undefined, `${context} did not set a session cookie.`);
  const pair = cookie.split(";", 1)[0];
  assert(pair.split("=", 2)[1]?.length > 0, `${context} set an empty session cookie.`);
  return {
    pair,
    attributes: cookie
      .split(";")
      .slice(1)
      .map((value) => value.trim().toLowerCase()),
  };
}

function expectNoCookies(result, context) {
  assert(getSetCookieHeaders(result.response).length === 0, `${context} set a cookie.`);
}

function expectSessionCookie(result, context, remember) {
  const { pair, attributes } = sessionCookieHeader(result, context);

  assert(attributes.includes("httponly"), `${context} cookie is not HttpOnly.`);
  assert(attributes.includes("samesite=strict"), `${context} cookie does not use SameSite=Strict.`);
  assert(attributes.includes("path=/"), `${context} cookie does not use Path=/.`);
  assert(!attributes.includes("secure"), `${context} local HTTP cookie unexpectedly uses Secure.`);

  const hasMaxAge = attributes.some((value) => value.startsWith("max-age="));
  const hasExpires = attributes.some((value) => value.startsWith("expires="));

  if (remember) {
    assert(attributes.includes("max-age=2592000"), `${context} cookie does not persist for 30 days.`);
  } else {
    assert(!hasMaxAge && !hasExpires, `${context} cookie unexpectedly persists.`);
  }

  return pair;
}

function expiredSessionCookie(cookie) {
  const [name, value] = cookie.split("=", 2);
  const session = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  session.expires_at = 1;
  return `${name}=${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;
}

function expectClearedCookie(result, context) {
  const cookies = getSetCookieHeaders(result.response);
  const cookie = cookies.find((value) =>
    value.toLowerCase().startsWith(`${SESSION_COOKIE_NAME}=`),
  );

  assert(cookie !== undefined, `${context} did not clear the session cookie.`);
  const attributes = cookie
    .split(";")
    .slice(1)
    .map((value) => value.trim().toLowerCase());
  assert(attributes.includes("max-age=0"), `${context} did not expire the session cookie.`);
}

async function postAuth(baseUrl, body, context, cookie) {
  return requestJson(
    `${baseUrl}/api/auth`,
    {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    },
    context,
  );
}

async function getAuth(baseUrl, context, cookie) {
  return requestJson(
    `${baseUrl}/api/auth`,
    {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    },
    context,
  );
}

async function reserveLoopbackPort() {
  const { createServer } = await import("node:net");
  const server = createServer();

  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (port === null) {
          reject(new Error("No loopback port was allocated."));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function spawnApp(childEnvironment, port) {
  return spawn(
    process.execPath,
    [resolve(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: PROJECT_ROOT,
      env: childEnvironment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveExit) => {
    child.once("exit", resolveExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForReady(child, baseUrl) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("The local app server exited before the auth endpoint became ready.");
    }

    let response;
    try {
      response = await fetch(`${baseUrl}/api/auth`, {
        cache: "no-store",
        signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The development server may still be compiling or accepting connections.
      await delay(250);
      continue;
    }

    assertNoStore(response, "Auth readiness check");

    if (response.status === 200) {
      const text = await response.text();
      let body;

      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }

      if (typeof body === "object" && body !== null && body.authenticated === false) {
        return;
      }
    } else {
      await response.arrayBuffer();
    }

    await delay(250);
  }

  fail("The local app server did not make the auth endpoint ready in time.");
}

function createAdminClient(project) {
  return createClient(project.url, project.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

async function listDisposableUsers(project, aliases) {
  const adminClient = createAdminClient(project);
  const found = new Map();

  for (let page = 1; ; page += 1) {
    const result = await adminClient.auth.admin.listUsers({
      page,
      perPage: LIST_USERS_PAGE_SIZE,
    });

    if (result.error) {
      fail("Supabase admin user listing failed during auth check cleanup.");
    }

    const users = result.data.users;
    for (const user of users) {
      if (typeof user.email === "string" && aliases.has(user.email)) {
        found.set(user.email, user.id);
      }
    }

    if (found.size === aliases.size || users.length < LIST_USERS_PAGE_SIZE) {
      break;
    }
  }

  return { adminClient, found };
}

async function cleanupDisposableUsers(project, disposableUsers) {
  const aliases = new Map(disposableUsers.map(({ alias, username }) => [alias, username]));
  const manualRemoval = new Set();
  let listed;

  try {
    listed = await listDisposableUsers(project, aliases);
  } catch {
    for (const username of aliases.values()) {
      manualRemoval.add(username);
    }
    return manualRemoval;
  }

  for (const [alias, username] of aliases) {
    const userId = listed.found.get(alias);
    if (userId === undefined) {
      continue;
    }

    try {
      const result = await listed.adminClient.auth.admin.deleteUser(userId);
      if (result.error) {
        manualRemoval.add(username);
      }
    } catch {
      manualRemoval.add(username);
    }
  }

  return manualRemoval;
}

async function stopChild(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }

    const stopped = await Promise.race([
      waitForChildExit(child).then(() => true),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
    ]);

    if (stopped) {
      return true;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    return await Promise.race([
      waitForChildExit(child).then(() => true),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
    ]);
  } catch {
    return false;
  }
}

async function runCheck() {
  loadLocalEnvironment();
  const allowMain = process.argv.slice(2).includes("--allow-main");
  const project = selectProject(allowMain);
  const aliases = [
    { alias: deriveAlias(TEST_USERNAME_A), username: TEST_USERNAME_A },
    { alias: deriveAlias(TEST_USERNAME_B), username: TEST_USERNAME_B },
  ];
  const childEnvironment = { ...process.env };
  childEnvironment.SUPABASE_URL = project.url;
  childEnvironment.SUPABASE_SERVICE_ROLE_KEY = project.serviceRoleKey;
  childEnvironment.AUTH_INVITE_CODE = TEST_INVITE_CODE;
  childEnvironment.AUTH_USERNAME_MAPPING_SECRET = TEST_USERNAME_MAPPING_SECRET;

  childEnvironment.SUPABASE_PUBLISHABLE_KEY = project.publicKey;
  childEnvironment.SUPABASE_ANON_KEY = project.publicKey;

  let child = null;
  let failure = null;
  let cleanupFailure = null;

  try {
    const port = await reserveLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawnApp(childEnvironment, port);
    await waitForReady(child, baseUrl);

    const wrongInvite = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_A,
        password: TEST_PASSWORD_A,
        confirmPassword: TEST_PASSWORD_A,
        inviteCode: "wrong-auth-check-invite",
      },
      "Wrong invitation registration",
    );
    expectError(wrongInvite, 400, "Unable to create account.", "Wrong invitation registration");
    expectNoCookies(wrongInvite, "Wrong invitation registration");

    const mismatchedPassword = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_B,
        password: TEST_PASSWORD_B,
        confirmPassword: `${TEST_PASSWORD_B}mismatch`,
        inviteCode: TEST_INVITE_CODE,
      },
      "Mismatched password registration",
    );
    expectError(mismatchedPassword, 400, "Passwords do not match.", "Mismatched password registration");
    expectNoCookies(mismatchedPassword, "Mismatched password registration");

    const oversizedPassword = "\u00e9".repeat(37);
    const oversizedPasswordRegistration = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_A,
        password: oversizedPassword,
        confirmPassword: oversizedPassword,
        inviteCode: TEST_INVITE_CODE,
      },
      "Over-72-byte password registration",
    );
    expectError(
      oversizedPasswordRegistration,
      400,
      "Password must be at most 72 bytes.",
      "Over-72-byte password registration",
    );
    expectNoCookies(oversizedPasswordRegistration, "Over-72-byte password registration");

    const beforeCreation = await listDisposableUsers(
      project,
      new Map(aliases.map(({ alias, username }) => [alias, username])),
    );
    assert(beforeCreation.found.size === 0, "Rejected registrations created a disposable user.");

    const createA = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_A,
        password: TEST_PASSWORD_A,
        confirmPassword: TEST_PASSWORD_A,
        inviteCode: TEST_INVITE_CODE,
      },
      "Account A registration",
    );
    expectStatus(createA, 201, "Account A registration");
    assert(
      createA.body?.message === "Account created. Sign in to continue.",
      "Account A registration returned an unexpected response.",
    );
    expectNoCookies(createA, "Account A registration");

    const duplicateA = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_A,
        password: TEST_PASSWORD_A,
        confirmPassword: TEST_PASSWORD_A,
        inviteCode: TEST_INVITE_CODE,
      },
      "Duplicate account A registration",
    );
    expectError(duplicateA, 400, "Unable to create account.", "Duplicate account A registration");
    expectNoCookies(duplicateA, "Duplicate account A registration");

    const createB = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_B,
        password: TEST_PASSWORD_B,
        confirmPassword: TEST_PASSWORD_B,
        inviteCode: TEST_INVITE_CODE,
      },
      "Account B registration",
    );
    expectStatus(createB, 201, "Account B registration");
    assert(
      createB.body?.message === "Account created. Sign in to continue.",
      "Account B registration returned an unexpected response.",
    );
    expectNoCookies(createB, "Account B registration");

    const duplicateB = await postAuth(
      baseUrl,
      {
        action: "create",
        username: TEST_USERNAME_B,
        password: TEST_PASSWORD_B,
        confirmPassword: TEST_PASSWORD_B,
        inviteCode: TEST_INVITE_CODE,
      },
      "Duplicate account B registration",
    );
    expectError(duplicateB, 400, "Unable to create account.", "Duplicate account B registration");
    expectNoCookies(duplicateB, "Duplicate account B registration");

    const foreignOriginLogin = await requestJson(
      `${baseUrl}/api/auth`,
      {
        method: "POST",
        headers: { Origin: "https://foreign.example", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", username: TEST_USERNAME_A, password: TEST_PASSWORD_A }),
      },
      "Foreign-origin login",
    );
    expectError(foreignOriginLogin, 403, "Request not allowed.", "Foreign-origin login");
    expectNoCookies(foreignOriginLogin, "Foreign-origin login");

    const unknownLogin = await postAuth(
      baseUrl,
      {
        action: "login",
        username: `authcheck_u_${randomBytes(6).toString("hex")}`,
        password: TEST_PASSWORD_A,
      },
      "Unknown-user login",
    );
    const wrongPasswordLogin = await postAuth(
      baseUrl,
      {
        action: "login",
        username: TEST_USERNAME_A,
        password: `${TEST_PASSWORD_A}wrong`,
      },
      "Wrong-password login",
    );
    assert(
      unknownLogin.response.status === wrongPasswordLogin.response.status &&
        unknownLogin.text === wrongPasswordLogin.text,
      "Unknown-user and wrong-password login responses differ.",
    );

    const loginA = await postAuth(
      baseUrl,
      { action: "login", username: ` ${TEST_USERNAME_A.toUpperCase()} `, password: TEST_PASSWORD_A },
      "Account A login",
    );
    expectAuthenticated(loginA, TEST_USERNAME_A, "Account A login");
    const loginCookieA = expectSessionCookie(loginA, "Account A login", false);

    const loginB = await postAuth(
      baseUrl,
      { action: "login", username: TEST_USERNAME_B, password: TEST_PASSWORD_B, remember: true },
      "Account B login",
    );
    expectAuthenticated(loginB, TEST_USERNAME_B, "Account B login");
    const loginCookieB = expectSessionCookie(loginB, "Account B login", true);

    const refreshA = await getAuth(baseUrl, "Account A session refresh", expiredSessionCookie(loginCookieA));
    expectAuthenticated(refreshA, TEST_USERNAME_A, "Account A session refresh");
    const cookieA = expectSessionCookie(refreshA, "Account A session refresh", false);
    assert(cookieA !== loginCookieA, "Account A session refresh did not rotate the session cookie.");

    const refreshB = await getAuth(baseUrl, "Account B session refresh", expiredSessionCookie(loginCookieB));
    expectAuthenticated(refreshB, TEST_USERNAME_B, "Account B session refresh");
    const cookieB = expectSessionCookie(refreshB, "Account B session refresh", true);
    assert(cookieB !== loginCookieB, "Account B session refresh did not rotate the session cookie.");

    const sessionA = await getAuth(baseUrl, "Account A session lookup", cookieA);
    expectAuthenticated(sessionA, TEST_USERNAME_A, "Account A session lookup");
    const sessionB = await getAuth(baseUrl, "Account B session lookup", cookieB);
    expectAuthenticated(sessionB, TEST_USERNAME_B, "Account B session lookup");
    assert(
      sessionA.body.username !== sessionB.body.username,
      "Disposable account sessions are not distinct.",
    );

    const tamperedCookie = `${cookieA}!`;
    const tamperedSession = await getAuth(baseUrl, "Tampered session lookup", tamperedCookie);
    expectUnauthenticated(tamperedSession, "Tampered session lookup");
    expectClearedCookie(tamperedSession, "Tampered session lookup");

    const logoutA = await postAuth(baseUrl, { action: "logout" }, "Account A logout", cookieA);
    expectUnauthenticated(logoutA, "Account A logout");
    expectClearedCookie(logoutA, "Account A logout");

    const loggedOutA = await getAuth(baseUrl, "Account A post-logout session lookup", cookieA);
    expectUnauthenticated(loggedOutA, "Account A post-logout session lookup");
    expectClearedCookie(loggedOutA, "Account A post-logout session lookup");

    const activeB = await getAuth(baseUrl, "Account B isolation session lookup", cookieB);
    expectAuthenticated(activeB, TEST_USERNAME_B, "Account B isolation session lookup");

    const logoutB = await postAuth(baseUrl, { action: "logout" }, "Account B logout", cookieB);
    expectUnauthenticated(logoutB, "Account B logout");
    expectClearedCookie(logoutB, "Account B logout");

    const loggedOutB = await getAuth(baseUrl, "Account B post-logout session lookup", cookieB);
    expectUnauthenticated(loggedOutB, "Account B post-logout session lookup");
    expectClearedCookie(loggedOutB, "Account B post-logout session lookup");

    const repeatLogout = await postAuth(baseUrl, { action: "logout" }, "Repeat logout");
    expectUnauthenticated(repeatLogout, "Repeat logout");
    expectClearedCookie(repeatLogout, "Repeat logout");
  } catch (error) {
    failure = error instanceof AuthCheckError ? error : new AuthCheckError("Auth check failed.");
  } finally {
    cleanupFailure = await cleanupDisposableUsers(project, aliases);

    if (cleanupFailure.size > 0) {
      process.exitCode = 1;
      console.error(
        `Auth check cleanup failed. Manually remove disposable usernames: ${[...cleanupFailure].join(", ")}.`,
      );
    }

    if (child !== null) {
      const stopped = await stopChild(child);
      if (!stopped) {
        process.exitCode = 1;
        console.error("Auth check could not confirm that its local app server stopped.");
      }
    }
  }

  if (failure !== null) {
    process.exitCode = 1;
    throw failure;
  }
}

runCheck().catch((error) => {
  process.exitCode = 1;
  if (error instanceof AuthCheckError) {
    console.error(`Auth check failed: ${error.message}`);
  } else {
    console.error("Auth check failed unexpectedly.");
  }
});
