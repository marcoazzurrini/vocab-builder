import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import "../tokens.css";
import "../index.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "UTF-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0, viewport-fit=cover" },
      { name: "theme-color", content: "#f4f4f1", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#16171b", media: "(prefers-color-scheme: dark)" },
      { title: "vocab-builder" },
    ],
    links: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
  }),
  component: Root,
});

export function Root() {
  return (
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
}
