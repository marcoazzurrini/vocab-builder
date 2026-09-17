import { Trans, useLingui } from "@lingui/react/macro";
import { MenuIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="flex min-h-svh">
      <a
        href="#main-content"
        className="focus:bg-background focus:text-foreground focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:p-3 focus:ring-2"
      >
        <Trans>Skip to content</Trans>
      </a>
      <div className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-svh w-64 shrink-0 border-r md:block">
        <Sidebar email={email} onClose={closeMenu} onSignOut={onSignOut} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Feature dialogs must not inherit the navigation Sheet's dialog context. */}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <header className="flex items-center gap-3 border-b px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 md:hidden">
            <SheetTrigger
              render={<Button variant="ghost" size="icon-lg" />}
              aria-label={t`Open menu`}
            >
              <MenuIcon aria-hidden="true" />
            </SheetTrigger>
            <span className="text-lg font-semibold">
              <Wordmark />
            </span>
          </header>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="pl-[env(safe-area-inset-left)]"
          >
            <SheetHeader className="shrink-0 pt-[calc(env(safe-area-inset-top)+1rem)]">
              <SheetTitle>
                <Trans>Menu</Trans>
              </SheetTitle>
              <SheetClose
                render={<Button variant="ghost" size="icon-sm" />}
                className="absolute top-[calc(env(safe-area-inset-top)+0.75rem)] right-3"
                aria-label={t`Close menu`}
              >
                <XIcon aria-hidden="true" />
              </SheetClose>
            </SheetHeader>
            <Sidebar email={email} onClose={closeMenu} onSignOut={onSignOut} />
          </SheetContent>
        </Sheet>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] pt-12 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:pt-20"
        >
          {children}
        </main>
      </div>
    </div>
  );
};
