import { Trans, useLingui } from "@lingui/react/macro";
import { BookOpenIcon, UserRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

import { Sidebar } from "./sidebar";
import { useVisibleViewport } from "./use-visible-viewport";
import { Wordmark } from "./wordmark";

export type AppSection = "session" | "account";

export const AppShell = ({
  email,
  onSignOut,
  section,
  onSectionChange,
  notice,
  children,
}: {
  email: string;
  onSignOut: () => void;
  section: AppSection;
  onSectionChange: (section: AppSection) => void;
  notice?: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const name = email.split("@")[0] || email;
  const viewportRef = useVisibleViewport();

  return (
    <div ref={viewportRef} className="app-shell flex min-h-dvh">
      <a
        href="#main-content"
        className="focus:bg-background focus:text-foreground focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:p-3 focus:ring-2"
      >
        <Trans>Skip to content</Trans>
      </a>
      <div className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-dvh w-64 shrink-0 border-r lg:block">
        <Sidebar
          email={email}
          sessionActive={section === "session"}
          onClose={() => onSectionChange("session")}
          onSignOut={onSignOut}
        />
      </div>
      <div className="app-body flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="app-header flex items-center justify-between gap-4 lg:hidden">
          <span className="text-lg font-semibold tracking-tight">
            <Wordmark />
          </span>
          <span className="text-muted-foreground text-sm" lang="fr">
            français
          </span>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="app-content mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6"
        >
          {notice}
          {/* Keep practice mounted: switching sections must not discard a draft or pending answer. */}
          <section
            className="session-region"
            hidden={section !== "session"}
            aria-label={t`Session`}
          >
            {children}
          </section>
          <section
            hidden={section !== "account"}
            aria-labelledby="account-title"
          >
            <div className="flex flex-col gap-8 py-4 sm:py-8">
              <h1
                id="account-title"
                className="text-3xl font-semibold tracking-tight"
              >
                <Trans>Account</Trans>
              </h1>
              <div className="bg-muted/50 flex flex-col gap-5 rounded-2xl p-5">
                <div className="flex min-w-0 items-center gap-4">
                  <Avatar size="lg" aria-hidden="true">
                    <AvatarFallback>
                      {name.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {name}
                    </p>
                    <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
                      {email}
                    </p>
                  </div>
                </div>
                <Separator />
                <dl className="flex flex-wrap items-center justify-between gap-3">
                  <dt className="text-muted-foreground text-sm">
                    <Trans>Learning language</Trans>
                  </dt>
                  <dd lang="fr">français</dd>
                </dl>
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full sm:w-fit"
                onClick={onSignOut}
              >
                <Trans>Sign out</Trans>
              </Button>
            </div>
          </section>
        </main>
        <nav
          className="mobile-navigation lg:hidden"
          aria-label={t`Main navigation`}
        >
          <Button
            type="button"
            variant="navigation"
            size="tab"
            aria-current={section === "session" ? "page" : undefined}
            aria-controls="main-content"
            onClick={() => onSectionChange("session")}
          >
            <BookOpenIcon aria-hidden="true" data-icon="inline-start" />
            <Trans>Session</Trans>
          </Button>
          <Button
            type="button"
            variant="navigation"
            size="tab"
            aria-current={section === "account" ? "page" : undefined}
            aria-controls="main-content"
            onClick={() => onSectionChange("account")}
          >
            <UserRoundIcon aria-hidden="true" data-icon="inline-start" />
            <Trans>Account</Trans>
          </Button>
        </nav>
      </div>
    </div>
  );
};
