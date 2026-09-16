import { setupI18n } from "@lingui/core";
import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { getGlobalStartContext } from "@tanstack/react-start";
import { activateLocale } from "@vocab/i18n";
import { defaultLocale, parseLocale } from "@vocab/i18n/locales";
import { Fragment } from "react";

import { routeTree } from "./routeTree.gen";

export const createAppRouter = (i18n: I18n, userId: string | null = null) => {
  // Start creates a router per SSR request. Never share authenticated caches globally.
  const queryClient = new QueryClient();
  const documentIdentity = { userId };
  const router = createRouter({
    context: { documentIdentity, i18n, queryClient },
    defaultPreloadStaleTime: 0,
    dehydrate: () => ({
      locale: parseLocale(i18n.locale) ?? defaultLocale,
      userId: documentIdentity.userId,
    }),
    // Start awaits the catalog before hydrating React. The identity records which
    // account the document was rendered for; it does not authorize requests.
    hydrate: async ({ locale, userId: hydratedUserId }) => {
      documentIdentity.userId = hydratedUserId;
      await activateLocale(i18n, locale);
    },
    routeTree,
    scrollRestoration: true,
  });
  // Query's integration composes the language dehydration/hydration hooks.
  setupRouterSsrQueryIntegration({ queryClient, router });
  const QueryProvider = router.options.Wrap ?? Fragment;
  router.options.Wrap = function Wrap({ children }) {
    return (
      <I18nProvider i18n={i18n}>
        <QueryProvider>{children}</QueryProvider>
      </I18nProvider>
    );
  };
  return router;
};

export const getRouter = () => {
  const context = getGlobalStartContext();
  return createAppRouter(context?.i18n ?? setupI18n(), context?.userId ?? null);
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
