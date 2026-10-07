import { Suspense } from "react";

import PnlPage from "./pnl-page";

export default function PnlRoute() {
  // The page reads ?month= on the device, so the saved offline copy stays
  // the same for every month.
  return (
    <Suspense
      fallback={
        <main className="dash-page">
          <p className="stocks-loading" role="status">Loading…</p>
        </main>
      }
    >
      <PnlPage />
    </Suspense>
  );
}
