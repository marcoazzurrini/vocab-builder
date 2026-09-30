// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createI18n } from "@vocab/i18n";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./app-shell";
import type { AppSection } from "./app-shell";

const ShellExample = ({ onSignOut }: { onSignOut: () => void }) => {
  const [section, setSection] = useState<AppSection>("session");
  return (
    <AppShell
      email="learner@example.com"
      onSignOut={onSignOut}
      section={section}
      onSectionChange={setSection}
      notice={<p role="alert">Account notice</p>}
    >
      <h1>Practice</h1>
      <input aria-label="Answer" />
    </AppShell>
  );
};

const renderShell = async (onSignOut = vi.fn<() => void>()) => {
  const i18n = await createI18n("it");
  render(
    <I18nProvider i18n={i18n}>
      <ShellExample onSignOut={onSignOut} />
    </I18nProvider>
  );
  return within(
    screen.getByRole("navigation", { name: "Navigazione principale" })
  );
};

describe("responsive app shell", () => {
  afterEach(cleanup);

  it("offers only two working mobile destinations without a hamburger or dialog", async () => {
    const navigation = await renderShell();
    expect(navigation.getAllByRole("button")).toHaveLength(2);
    expect(
      navigation
        .getByRole("button", { name: "Sessione" })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(
      navigation
        .getByRole("button", { name: "Account" })
        .getAttribute("aria-current")
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Apri menu" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches sections without unmounting practice or losing the typed answer", async () => {
    const user = userEvent.setup();
    const navigation = await renderShell();
    const answer = screen.getByRole("textbox", { name: "Answer" });
    await user.type(answer, "bonj");
    await user.click(navigation.getByRole("button", { name: "Account" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(answer.isConnected).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Account" })).toBeDefined();
    await user.click(navigation.getByRole("button", { name: "Sessione" }));
    expect(screen.getByDisplayValue("bonj")).toBe(answer);
    expect(screen.queryByRole("heading", { name: "Account" })).toBeNull();
  });

  it("supports keyboard navigation and account sign-out", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn<() => void>();
    const navigation = await renderShell(onSignOut);
    navigation.getByRole("button", { name: "Account" }).focus();
    await user.keyboard("{Enter}");
    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByText("learner@example.com")).toBeDefined();
    expect(
      navigation
        .getByRole("button", { name: "Account" })
        .getAttribute("aria-current")
    ).toBe("page");
    await user.click(within(account).getByRole("button", { name: "Esci" }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toBe("Account notice");
  });

  it("keeps the desktop Session action and skip link working after switching sections", async () => {
    const user = userEvent.setup();
    const navigation = await renderShell();
    const skipLink = screen.getByRole("link", { name: "Vai al contenuto" });
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(screen.getByRole("main").id).toBe("main-content");
    await user.click(navigation.getByRole("button", { name: "Account" }));
    const sidebar = screen.getByRole("complementary", { name: "Menu" });
    const session = within(sidebar).getByRole("button", { name: "Sessione" });
    expect(session.getAttribute("aria-current")).toBeNull();
    await user.click(session);
    expect(screen.getByRole("textbox")).toBeDefined();
    expect(session.getAttribute("aria-current")).toBe("page");
  });
});
