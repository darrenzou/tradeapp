"use client";

import Link from "next/link";
import { useEffect } from "react";

import { rememberPage, type AppPage } from "./client-api";

type AppHeaderProps = {
  username: string;
  active: AppPage;
  busy: boolean;
  onSignOut: () => void;
};

const NAV_ITEMS = [
  { id: "overview", href: "/", label: "Overview" },
  { id: "stocks", href: "/stocks", label: "Stocks" },
] as const;

export default function AppHeader({ username, active, busy, onSignOut }: AppHeaderProps) {
  // Reopening the app returns to this page (see takeResumePath).
  useEffect(() => rememberPage(active), [active]);

  return (
    <header className="dash-header">
      <div className="dash-header-start">
        <div className="auth-logo dash-logo">
          <span className="auth-logo-mark" aria-hidden="true">T</span>
          <span>Tradeapp</span>
        </div>
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
      </div>
      <div className="dash-user">
        <span>{username}</span>
        <button type="button" className="dash-link-button" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </div>
    </header>
  );
}
