import { env } from "cloudflare:workers";
import { createAuthentication } from "@vocab/authentication/server";
import { createDatabase } from "@vocab/database";

/** The composition root: only the deployable app knows Worker binding names. */
export function services() {
  return {
    authentication: createAuthentication({
      database: env.DB,
      baseURL: env.BETTER_AUTH_URL,
      secret: env.BETTER_AUTH_SECRET,
      allowedEmails: env.ALLOWED_EMAILS,
      emailMode: env.AUTH_EMAIL_MODE,
      resendAPIKey: env.RESEND_API_KEY,
      emailFrom: env.EMAIL_FROM,
    }),
    database: createDatabase(env.DB),
  };
}
