import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { createAuthenticationAdapter } from "@vocab/database/authentication";
import type { DatabaseBinding } from "@vocab/database";
import type { Identity } from "./identity";

export type AuthenticationOptions = {
  database: DatabaseBinding;
  baseURL?: string;
  secret?: string;
  allowedEmails?: string;
  emailMode?: string;
  resendAPIKey?: string;
  emailFrom?: string;
};

export type Authentication = {
  handle(request: Request): Promise<Response>;
  requireUser(headers: Headers, expectedUserId?: string): Promise<Identity>;
};

/** Owns sign-in policy, delivery, sessions, and account checks; not the deployment environment. */
export function createAuthentication(options: AuthenticationOptions): Authentication {
  const baseURL = options.baseURL;
  if (!baseURL || !options.secret || options.secret.length < 32) {
    throw new Error("Set BETTER_AUTH_URL and a BETTER_AUTH_SECRET of at least 32 characters.");
  }
  const allowedEmails = new Set(
    (options.allowedEmails ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedEmails.size === 0) throw new Error("Set ALLOWED_EMAILS before enabling sign-in.");
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname);
  if (!isLocal && !baseURL.startsWith("https://"))
    throw new Error("Authentication requires HTTPS outside localhost.");

  const auth = betterAuth({
    appName: "vocab-builder",
    baseURL,
    secret: options.secret,
    trustedOrigins: [new URL(baseURL).origin],
    advanced: {
      // Keep the security checks enabled in tests as well as production.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/magic-link": { window: 60, max: 3 } },
    },
    database: createAuthenticationAdapter(options.database),
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            if (!allowedEmails.has(newUser.email.toLowerCase()))
              throw new APIError("FORBIDDEN", {
                message: "Sign-in is not available for this address.",
              });
            return { data: newUser };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }, context) => {
          // Keep the app private and avoid spending email quota on arbitrary recipients.
          // Return the same public response for an address that is not allowed.
          if (!allowedEmails.has(email.toLowerCase())) return;
          if (options.emailMode === "log") {
            const requestHost = context?.request
              ? new URL(context.request.url).hostname
              : undefined;
            if (
              !isLocal ||
              !requestHost ||
              !["localhost", "127.0.0.1", "[::1]"].includes(requestHost)
            ) {
              throw new Error("Logging sign-in links is only allowed on localhost.");
            }
            console.info(`[local sign-in] ${url}`);
            return;
          }
          if (!options.resendAPIKey || !options.emailFrom)
            throw new Error("Configure RESEND_API_KEY and EMAIL_FROM to send sign-in emails.");
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.resendAPIKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: options.emailFrom,
              to: [email],
              subject: "Accedi a vocab-builder",
              text: `Apri questo link per accedere a vocab-builder. Scade tra 10 minuti.\n\n${url}\n\nSe non hai richiesto questo link, ignora questa email.`,
            }),
          });
          if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
        },
      }),
    ],
  });
  return {
    handle: (request) => auth.handler(request),
    async requireUser(headers, expectedUserId) {
      const current = await auth.api.getSession({ headers });
      if (!current) throw new Error("Sign in before accessing your progress.");
      if (expectedUserId !== undefined && current.user.id !== expectedUserId) {
        throw new Error("Sign back in to the account that recorded these answers.");
      }
      const { id, email, name } = current.user;
      return { id, email, name };
    },
  };
}
