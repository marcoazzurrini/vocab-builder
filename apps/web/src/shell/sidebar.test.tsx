// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createI18n } from "@vocab/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "./sidebar";

describe("localized sidebar", () => {
  afterEach(cleanup);

  it.each([
    { locale: "en", settings: "Settings", signOut: "Sign out" },
    { locale: "it", settings: "Impostazioni", signOut: "Esci" },
  ] as const)(
    "renders $locale without a language dropdown",
    async ({ locale, settings, signOut }) => {
      const i18n = await createI18n(locale);
      const onSignOut = vi.fn<() => void>();
      render(
        <I18nProvider i18n={i18n}>
          <Sidebar
            email="learner@example.com"
            open
            onClose={vi.fn<() => void>()}
            onSignOut={onSignOut}
          />
        </I18nProvider>
      );

      expect(
        screen.getByRole("button", { name: new RegExp(settings, "u") })
      ).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: signOut }));
      expect(onSignOut).toHaveBeenCalledOnce();
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.getByText("français")).toBeDefined();
    }
  );
});
