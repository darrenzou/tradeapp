"use client";

import { useSignedInUser } from "../use-signed-in-user";
import SpendingView from "./spending-view";

export default function SpendingPage() {
  const { username, ...session } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <SpendingView username={username} {...session} />;
}
