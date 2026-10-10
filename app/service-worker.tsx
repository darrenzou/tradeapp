"use client";

import { useEffect } from "react";

// Registers public/sw.js, which keeps the app's pages on the device so it
// opens offline, and asks it to save a fresh copy of the main pages each time
// the app opens online. Production only, so `next dev` always serves fresh code.
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(async () => {
        const registration = await navigator.serviceWorker.ready;

        if (navigator.onLine) {
          registration.active?.postMessage("save-pages");
        }
      })
      .catch(() => undefined);
  }, []);

  return null;
}
