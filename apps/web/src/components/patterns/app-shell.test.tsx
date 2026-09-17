// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createI18n } from "@vocab/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";

const renderShell = async (onSignOut = vi.fn<() => void>()) => {
  const i18n = await createI18n("it");
  render(
    <I18nProvider i18n={i18n}>
      <AppShell email="learner@example.com" onSignOut={onSignOut}>
        <h1>Practice</h1>
        <input aria-label="Answer" />
      </AppShell>
    </I18nProvider>
  );
};

describe("responsive app shell", () => {
  afterEach(cleanup);

  it("traps focus in the mobile menu and restores the trigger on Escape", async () => {
    const user = userEvent.setup();
    await renderShell();
    const trigger = screen.getByRole("button", { name: "Apri menu" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBeTruthy()
    );

    for (let index = 0; index < 6; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each Tab depends on the focus established by the previous one.
      await user.tab();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Base UI redirects its focus guards asynchronously.
      await waitFor(() =>
        expect(dialog.contains(document.activeElement)).toBeTruthy()
      );
    }

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes the mobile menu after selecting the current page", async () => {
    const user = userEvent.setup();
    await renderShell();
    await user.click(screen.getByRole("button", { name: "Apri menu" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(dialog).getByRole("button", { name: "Sessione" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the menu when sign-out leaves the current account mounted", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn<() => void>();
    await renderShell(onSignOut);
    await user.click(screen.getByRole("button", { name: "Apri menu" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(dialog).getByRole("button", { name: "Esci" }));
    expect(onSignOut).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Answer" })).toBeDefined();
  });

  it("provides a localized close control and a skip link to main content", async () => {
    const user = userEvent.setup();
    await renderShell();
    const skipLink = screen.getByRole("link", { name: "Vai al contenuto" });
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(screen.getByRole("main").id).toBe("main-content");

    await user.click(screen.getByRole("button", { name: "Apri menu" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(
      within(dialog).getByRole("button", { name: "Chiudi menu" })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
