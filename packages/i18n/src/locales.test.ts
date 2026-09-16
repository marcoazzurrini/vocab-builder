import { describe, expect, it } from "bun:test";

import * as v from "valibot";

import {
  browserLocale,
  parseLocale,
  resolveLocale,
  UiLocaleSchema,
} from "./locales";

describe("interface language", () => {
  it.each([
    ["it-IT,it;q=0.9,en;q=0.8", "it"],
    ["en-GB,en;q=0.9,it;q=0.8", "en"],
    ["fr-FR,fr;q=0.9,it;q=0.8,en;q=0.7", "it"],
    ["it;q=0.1,en;q=0.9", "en"],
    ["en;q=0,it;q=1", "it"],
    ["de-DE", "en"],
    ["", "en"],
    [null, "en"],
  ] as const)("negotiates %s as %s", (header, locale) => {
    expect(browserLocale(header)).toBe(locale);
  });

  it("uses the account preference before the browser or guest cookie", () => {
    expect(
      resolveLocale({
        acceptLanguage: "en",
        cookie: "en",
        user: { uiLocale: "it" },
      })
    ).toBe("it");
  });

  it("uses the browser for an automatic account even with an old guest cookie", () => {
    expect(
      resolveLocale({
        acceptLanguage: "it",
        cookie: "en",
        user: { uiLocale: null },
      })
    ).toBe("it");
  });

  it("remembers a signed-out visitor's manual choice", () => {
    expect(
      resolveLocale({ acceptLanguage: "en", cookie: "it", user: null })
    ).toBe("it");
  });

  it("ignores unsupported cookie values", () => {
    expect(
      resolveLocale({ acceptLanguage: "it", cookie: "fr", user: null })
    ).toBe("it");
    expect(parseLocale("en-US")).toBeNull();
  });

  it("accepts only supported preferences or automatic mode at the API boundary", () => {
    for (const value of ["en", "it", null]) {
      expect(v.safeParse(UiLocaleSchema, value).success).toBe(true);
    }
    for (const value of ["auto", "fr", "en-US", "", undefined, 1]) {
      expect(v.safeParse(UiLocaleSchema, value).success).toBe(false);
    }
  });
});
