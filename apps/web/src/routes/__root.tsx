import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import "../styles/globals.css";

export const Root = () => {
  const { i18n } = useLingui();
  return (
    <html lang={i18n.locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
};

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  i18n: I18n;
  documentIdentity: { userId: string | null };
}>()({
  component: Root,
  head: () => ({
    links: [
      { href: "/favicon.svg", rel: "icon", type: "image/svg+xml" },
      { href: "/manifest.webmanifest", rel: "manifest" },
      {
        href: "/icons/apple-touch-icon.png",
        rel: "apple-touch-icon",
        sizes: "180x180",
      },
    ],
    meta: [
      { charSet: "utf-8" },
      {
        content:
          "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content",
        name: "viewport",
      },
      {
        content: "#ffffff",
        media: "(prefers-color-scheme: light)",
        name: "theme-color",
      },
      {
        content: "#0a0a0a",
        media: "(prefers-color-scheme: dark)",
        name: "theme-color",
      },
      { content: "light dark", name: "color-scheme" },
      { content: "yes", name: "mobile-web-app-capable" },
      { content: "yes", name: "apple-mobile-web-app-capable" },
      {
        content: "default",
        name: "apple-mobile-web-app-status-bar-style",
      },
      { title: "vocab-builder" },
    ],
  }),
});
