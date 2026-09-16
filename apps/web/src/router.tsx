import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  // Start creates a router per SSR request. Never share authenticated caches globally.
  const queryClient = new QueryClient();
  const router = createRouter({
    context: { queryClient },
    defaultPreloadStaleTime: 0,
    routeTree,
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ queryClient, router });
  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
