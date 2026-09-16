import Negotiator from "negotiator";
import * as v from "valibot";

export const locales = ["en", "it"] as const;
export const LocaleSchema = v.picklist(locales);
export type Locale = v.InferOutput<typeof LocaleSchema>;
export const UiLocaleSchema = v.nullable(LocaleSchema);
export type UiLocale = v.InferOutput<typeof UiLocaleSchema>;
export const defaultLocale: Locale = "en";
export const localeCookie = "vocab-ui-locale";

export const parseLocale = (
  value: string | null | undefined
): Locale | null => {
  const parsed = v.safeParse(LocaleSchema, value);
  return parsed.success ? parsed.output : null;
};

/** Match weighted browser preferences, including regional variants and exclusions. */
export const browserLocale = (acceptLanguage: string | null): Locale => {
  const negotiated = new Negotiator({
    headers: { "accept-language": acceptLanguage ?? "" },
  }).language([...locales]);
  return parseLocale(negotiated) ?? defaultLocale;
};

/** An authenticated account's automatic setting deliberately ignores the guest cookie. */
export const resolveLocale = ({
  acceptLanguage,
  cookie,
  user,
}: {
  acceptLanguage: string | null;
  cookie?: string;
  user: { uiLocale: UiLocale } | null;
}): Locale =>
  (user ? user.uiLocale : parseLocale(cookie)) ?? browserLocale(acceptLanguage);
