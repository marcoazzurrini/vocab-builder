import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

import "../tokens.css";
import "../index.css";

export const Root = () => (
  <html lang="it">
    <head>
      <HeadContent />
    </head>
    <body>
      <Outlet />
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
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
        content: "width=device-width, initial-scale=1.0, viewport-fit=cover",
        name: "viewport",
      },
      {
        content: "#f4f4f1",
        media: "(prefers-color-scheme: light)",
        name: "theme-color",
      },
      {
        content: "#16171b",
        media: "(prefers-color-scheme: dark)",
        name: "theme-color",
      },
      { title: "vocab-builder" },
    ],
  }),
});
