"use client";

import { useState, type FormEvent } from "react";

import DetailDialog from "./detail-dialog";

// Asks for the passcode before a new Plaid or SnapTrade connection, since
// each one costs money. onSubmit returns an error to show, or null once it
// has moved on (the caller then closes this).
export default function PasscodeDialog({
  title,
  onSubmit,
  onClose,
}: {
  title: string;
  onSubmit: (passcode: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (passcode.trim() === "") {
      setError("Enter the passcode.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const failed = await onSubmit(passcode);

      if (failed !== null) {
        setError(failed);
        setPasscode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailDialog title={title} onClose={onClose}>
      <p className="detail-caption">Each new connection costs money, so connecting needs the passcode.</p>
      <form onSubmit={(event) => void submit(event)}>
        <div className="ea-box">
          <label className="ea-option ea-option-stacked">
            <span className="ea-option-title">Passcode</span>
            <input
              className="ea-name ia-mask"
              type="password"
              value={passcode}
              inputMode="numeric"
              maxLength={32}
              autoComplete="off"
              autoFocus
              onChange={(event) => setPasscode(event.target.value)}
            />
          </label>
        </div>
        {error && (
          <p className="ia-error" role="alert">
            {error}
          </p>
        )}
        <div className="dash-connect-actions">
          <button type="submit" className="pill-button pill-button-primary" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}
