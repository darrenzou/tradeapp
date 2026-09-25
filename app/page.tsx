"use client";

import { useEffect, useState, type FormEvent } from "react";

type Mode = "signin" | "create";
type AuthRequest =
  | {
      action: "create";
      username: string;
      password: string;
      confirmPassword: string;
      inviteCode: string;
    }
  | {
      action: "login";
      username: string;
      password: string;
      remember: boolean;
    };

type AuthenticatedResponse = { authenticated: true; username: string };
type UnauthenticatedResponse = { authenticated: false };
type AuthResponse = AuthenticatedResponse | UnauthenticatedResponse;

const SERVICE_UNAVAILABLE_MESSAGE = "Authentication service unavailable. Try again.";
const REQUEST_FAILED_MESSAGE = "Request failed. Try again.";
const LOGOUT_UNCONFIRMED_MESSAGE =
  "Signed out on this device, but the server could not confirm the session was revoked.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticatedResponse(value: unknown): value is AuthenticatedResponse {
  return (
    isRecord(value) &&
    value.authenticated === true &&
    typeof value.username === "string" &&
    value.username.length > 0
  );
}

function isUnauthenticatedResponse(value: unknown): value is UnauthenticatedResponse {
  return isRecord(value) && value.authenticated === false;
}

function isAuthResponse(value: unknown): value is AuthResponse {
  return isAuthenticatedResponse(value) || isUnauthenticatedResponse(value);
}

function errorMessage(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== "string" || value.error.length === 0) {
    return null;
  }

  return value.error;
}

function createdMessage(value: unknown): string | null {
  if (!isRecord(value) || typeof value.message !== "string" || value.message.length === 0) {
    return null;
  }

  return value.message;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureMessage(response: Response, body: unknown): string {
  if (response.status === 503) {
    return SERVICE_UNAVAILABLE_MESSAGE;
  }

  if (response.status === 400 || response.status === 401) {
    return errorMessage(body) ?? REQUEST_FAILED_MESSAGE;
  }

  return REQUEST_FAILED_MESSAGE;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("signin");
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"error" | "success">("error");
  const [authenticatedUsername, setAuthenticatedUsername] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const isCreating = mode === "create";
  const isPending = isInitializing || isMutating;

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const response = await fetch("/api/auth", {
          credentials: "same-origin",
          cache: "no-store",
        });
        const body = await readJson(response);

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setStatus(failureMessage(response, body));
          return;
        }

        if (!isAuthResponse(body)) {
          setStatus(REQUEST_FAILED_MESSAGE);
          return;
        }

        setAuthenticatedUsername(body.authenticated ? body.username : null);
      } catch {
        if (!cancelled) {
          setStatus(SERVICE_UNAVAILABLE_MESSAGE);
        }
      } finally {
        if (!cancelled) {
          setIsInitializing(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  function switchMode() {
    setStatus("");
    setStatusTone("error");
    setMode(isCreating ? "signin" : "create");
  }

  async function submitAuth(payload: AuthRequest, form: HTMLFormElement) {
    setIsMutating(true);

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);

      if (!response.ok) {
        setStatus(failureMessage(response, body));
        return;
      }

      if (payload.action === "create") {
        const message = createdMessage(body);

        if (message === null) {
          setStatus(REQUEST_FAILED_MESSAGE);
          return;
        }

        form.reset();
        setAuthenticatedUsername(null);
        setMode("signin");
        setStatusTone("success");
        setStatus(message);
        return;
      }

      if (!isAuthenticatedResponse(body)) {
        setStatus(REQUEST_FAILED_MESSAGE);
        return;
      }

      form.reset();
      setAuthenticatedUsername(body.username);
      setStatus("");
    } catch {
      setStatus(SERVICE_UNAVAILABLE_MESSAGE);
    } finally {
      setIsMutating(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    setStatusTone("error");

    const form = event.currentTarget;
    const values = new FormData(form);
    const username = values.get("username");
    const password = values.get("password");

    if (typeof username !== "string" || typeof password !== "string") {
      setStatus(REQUEST_FAILED_MESSAGE);
      return;
    }

    if (isCreating) {
      const confirmPassword = values.get("confirmPassword");
      const inviteCode = values.get("inviteCode");

      if (typeof confirmPassword !== "string" || typeof inviteCode !== "string") {
        setStatus(REQUEST_FAILED_MESSAGE);
        return;
      }

      if (password !== confirmPassword) {
        setStatus("Passwords do not match. Please try again.");
        return;
      }

      void submitAuth(
        { action: "create", username, password, confirmPassword, inviteCode },
        form,
      );
      return;
    }

    void submitAuth(
      {
        action: "login",
        username,
        password,
        remember: values.get("remember") === "on",
      },
      form,
    );
  }

  async function handleLogout() {
    setStatus("");
    setStatusTone("error");
    setIsMutating(true);

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      const body = await readJson(response);

      if (response.status === 503 && isUnauthenticatedResponse(body)) {
        setAuthenticatedUsername(null);
        setMode("signin");
        setStatus(LOGOUT_UNCONFIRMED_MESSAGE);
        return;
      }

      if (!response.ok) {
        setStatus(failureMessage(response, body));
        return;
      }

      if (!isUnauthenticatedResponse(body)) {
        setStatus(REQUEST_FAILED_MESSAGE);
        return;
      }

      setAuthenticatedUsername(null);
      setMode("signin");
    } catch {
      setStatus(SERVICE_UNAVAILABLE_MESSAGE);
    } finally {
      setIsMutating(false);
    }
  }

  const heading =
    authenticatedUsername !== null ? "You're signed in" : isCreating ? "Create your account" : "Welcome back";
  const intro =
    authenticatedUsername !== null
      ? "Your private workspace is ready."
      : isCreating
        ? "Start with a username and password."
        : "Sign in to your private workspace.";

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <section className="auth-brand" aria-label="About Tradeapp">
          <div className="auth-logo">
            <span className="auth-logo-mark" aria-hidden="true">T</span>
            <span>Tradeapp</span>
          </div>
          <div className="auth-brand-content">
            <p className="auth-eyebrow auth-brand-eyebrow">PRIVATE FINANCE, MADE SIMPLE</p>
            <h1>A clearer view of what matters.</h1>
            <p className="auth-brand-description">Keep your household finances in one calm, shared place.</p>
            <div className="auth-benefits" aria-label="Benefits">
              <p><span className="auth-benefit-dot" aria-hidden="true" />Track the full picture</p>
              <p><span className="auth-benefit-dot" aria-hidden="true" />Plan together</p>
              <p><span className="auth-benefit-dot" aria-hidden="true" />Move with confidence</p>
            </div>
          </div>
          <div className="auth-brand-decoration" aria-hidden="true" />
        </section>

        <section className="auth-form-panel" aria-labelledby="auth-heading">
          <div className="auth-form-content">
            <p className="auth-eyebrow">WELCOME TO TRADEAPP</p>
            <h2 id="auth-heading">{heading}</h2>
            <p className="auth-intro">{intro}</p>
            <div className="auth-card">
              {authenticatedUsername === null ? (
                <form key={mode} onSubmit={handleSubmit}>
                  <div className="auth-field">
                    <label htmlFor="auth-username">Username</label>
                    <input id="auth-username" name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
                  </div>
                  <div className="auth-field">
                    <label htmlFor="auth-password">Password</label>
                    <input id="auth-password" name="password" type="password" autoComplete={isCreating ? "new-password" : "current-password"} required />
                  </div>
                  {isCreating ? (
                    <>
                      <div className="auth-field">
                        <label htmlFor="auth-confirm-password">Confirm password</label>
                        <input id="auth-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required />
                      </div>
                      <div className="auth-field auth-invite-field">
                        <label htmlFor="auth-invite-code">Invitation code</label>
                        <input id="auth-invite-code" name="inviteCode" type="password" autoComplete="off" required />
                      </div>
                    </>
                  ) : (
                    <label className="auth-remember" htmlFor="auth-remember">
                      <input id="auth-remember" name="remember" type="checkbox" />
                      <span>Remember me</span>
                    </label>
                  )}
                  <button className="auth-submit" type="submit" disabled={isPending}>
                    {isCreating ? "Create account" : "Sign in"}
                  </button>
                  <button className="auth-switch" type="button" onClick={switchMode} disabled={isPending}>
                    {isCreating ? "Back to sign in" : "Create account"}
                  </button>
                </form>
              ) : (
                <div className="auth-authenticated">
                  <p>Signed in as <strong>{authenticatedUsername}</strong>.</p>
                  <button className="auth-submit" type="button" onClick={() => void handleLogout()} disabled={isPending}>
                    Sign out
                  </button>
                </div>
              )}
              <p className={statusTone === "success" ? "auth-status auth-status-success" : "auth-status"} aria-live="polite" role={status ? "status" : undefined}>
                {status}
              </p>
            </div>
            <p className="auth-footnote">Private by design. Built for the people you trust.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
