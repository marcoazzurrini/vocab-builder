import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ErrorBoundary } from "./error-boundary";
import { Sidebar } from "./sidebar";
import { Wordmark } from "./wordmark";

export const AppShell = ({
  email,
  onSignOut,
  children,
}: {
  email: string;
  onSignOut: () => void;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="shell">
      <Sidebar
        email={email}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSignOut={onSignOut}
      />
      {menuOpen && (
        <div
          className="scrim"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="col">
        <header>
          <button
            type="button"
            className="menu-btn"
            onClick={() => setMenuOpen(true)}
            aria-label={t`Open menu`}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <span className="wordmark">
            <Wordmark />
          </span>
        </header>
        <main>
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
};
