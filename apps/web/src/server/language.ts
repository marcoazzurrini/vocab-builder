import { createMiddleware, createServerOnlyFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createI18n } from "@vocab/i18n";
import type { Locale } from "@vocab/i18n/locales";
import { localeCookie, resolveLocale } from "@vocab/i18n/locales";

const requestLanguage = createServerOnlyFn(async (headers: Headers) => {
  const { services } = await import("./services");
  const { authentication, database } = services();
  const user = await authentication.getUser(headers);
  const cookie = getCookie(localeCookie);
  const uiLocale = user ? await database.forUser(user.id).uiLocale() : null;
  return {
    locale: resolveLocale({
      acceptLanguage: headers.get("accept-language"),
      cookie,
      user: user ? { uiLocale } : null,
    }),
    userId: user?.id ?? null,
  };
});

export type LanguageResolver = (
  headers: Headers
) => Promise<{ locale: Locale; userId: string | null }>;

export const createLanguageMiddleware = (
  resolve: LanguageResolver = requestLanguage
) =>
  createMiddleware({ type: "request" }).server(
    async ({ request, handlerType, next: run }) => {
      // Server functions and API handlers authenticate independently; only pages need translations.
      if (
        handlerType !== "router" ||
        new URL(request.url).pathname.startsWith("/api/")
      ) {
        return run();
      }
      const language = await resolve(request.headers);
      const i18n = await createI18n(language.locale);
      const result = await run({ context: { i18n, userId: language.userId } });
      // Locale and authentication are personalized; never share rendered HTML across visitors.
      result.response.headers.set("Cache-Control", "private, no-store");
      result.response.headers.set("Content-Language", language.locale);
      return result;
    }
  );

export const languageMiddleware = createLanguageMiddleware();
