import { createFileRoute } from "@tanstack/react-router";

async function handle({ request }: { request: Request }) {
  const { services } = await import("../../../server/services");
  return services().authentication.handle(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
});
