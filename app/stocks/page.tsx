"use client";

import { useSignedInUser } from "../use-signed-in-user";
import StocksView from "./stocks-view";

export default function StocksPage() {
  const { username, ...session } = useSignedInUser();

  if (username === null) {
    return (
      <main className="dash-page">
        <p className="stocks-loading" role="status">Loading…</p>
      </main>
    );
  }

  return <StocksView username={username} {...session} />;
}
