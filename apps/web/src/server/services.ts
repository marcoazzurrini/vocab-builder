import { createAuthentication } from "@vocab/authentication/server";
import { createDatabase } from "@vocab/database";
import { env } from "cloudflare:workers";

/** The composition root: only the deployable app knows Worker binding names. */
export const services = () => ({
  authentication: createAuthentication({
    allowedEmails: env.ALLOWED_EMAILS,
    baseURL: env.BETTER_AUTH_URL,
    database: env.DB,
    emailFrom: env.EMAIL_FROM,
    emailMode: env.AUTH_EMAIL_MODE,
    resendAPIKey: env.RESEND_API_KEY,
    secret: env.BETTER_AUTH_SECRET,
  }),
  database: createDatabase(env.DB),
});
