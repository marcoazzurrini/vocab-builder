import { setupI18n } from "@lingui/core";
import type { I18n } from "@lingui/core";

import type { Locale } from "./locales";

const catalogs = {
  en: () => import("./locales/en/messages.po"),
  it: () => import("./locales/it/messages.po"),
};

export const loadCatalog = async (locale: Locale) => {
  const { messages } = await catalogs[locale]();
  return messages;
};

export const activateLocale = async (i18n: I18n, locale: Locale) => {
  const messages = await loadCatalog(locale);
  i18n.loadAndActivate({ locale, messages });
};

/** Never retain this mutable instance in a server module singleton. */
export const createI18n = async (locale: Locale) => {
  const i18n = setupI18n();
  await activateLocale(i18n, locale);
  return i18n;
};
