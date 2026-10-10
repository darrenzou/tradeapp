"use client";

import Link from "next/link";
import { useEffect } from "react";

import { rememberPage, type AppPage } from "./client-api";
import type { CachedResource } from "./client-cache";
import RefreshButton from "./refresh-button";

type AppHeaderProps = {
  username: string;
  active: AppPage;
  busy: boolean;
  onSignOut: () => void;
  onSessionExpired: () => void;
  // Data shown only on this page, refreshed along with every page's.
  alsoRefresh?: CachedResource;
};

const NAV_ITEMS = [
  { id: "overview", href: "/", label: "Overview" },
  { id: "stocks", href: "/stocks", label: "Stocks" },
  { id: "spending", href: "/spending", label: "Spending" },
] as const;

export default function AppHeader({
  username,
  active,
  busy,
  onSignOut,
  onSessionExpired,
  alsoRefresh,
}: AppHeaderProps) {
  // Reopening the app returns to this page (see takeResumePath).
  useEffect(() => rememberPage(active), [active]);

  return (
    <header className="dash-header">
      <nav className="dash-nav" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={item.id === active ? "dash-nav-link dash-nav-active" : "dash-nav-link"}
            aria-current={item.id === active ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="dash-user">
        <RefreshButton alsoRefresh={alsoRefresh} onSessionExpired={onSessionExpired} />
        <button
          type="button"
          className="dash-icon-button"
          onClick={onSignOut}
          disabled={busy}
          aria-label={`Sign out ${username}`}
          title="Sign out"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
