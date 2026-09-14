import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { env } = await import("cloudflare:workers");
  const { createAuth } = await import("../../../server/auth");
  return createAuth(env).handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
