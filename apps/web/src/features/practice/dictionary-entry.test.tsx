// @vitest-environment jsdom
import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createI18n } from "@vocab/i18n";
import type { EntryPresentation } from "@vocab/spaced-repetition";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictionaryEntry } from "./dictionary-entry";

const PRESENTATION: EntryPresentation = {
  context: "Per indicare dove si trova qualcuno o qualcosa.",
  example: { text: "être à la maison", translation: "essere a casa" },
  explanation: "Scrivi solo il verbo, non l’intero esempio.",
  grammar: "verbo · infinito",
  meaning: "essere",
};

let i18n: I18n;
const Wrapper = ({ children }: PropsWithChildren) => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => testingRender(ui, { wrapper: Wrapper });
const onListen = vi.fn<() => void>();
const onContinue = vi.fn<() => void>();
const entry = (
  answer = "être",
  meaning = "essere",
  presentation: EntryPresentation = PRESENTATION
) => (
  <DictionaryEntry
    answer={answer}
    meaning={meaning}
    presentation={{ ...presentation, meaning }}
    onListen={onListen}
    onContinue={onContinue}
  />
);

describe("the focused teaching entry", () => {
  beforeEach(async () => {
    i18n = await createI18n("it");
    onListen.mockReset();
    onContinue.mockReset();
  });
  afterEach(cleanup);

  it("keeps pronunciation beside the headword and Continue as a separate action", async () => {
    const user = userEvent.setup();
    render(entry());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("être");
    await user.click(screen.getByRole("button", { name: "Ascolta" }));
    expect(onListen).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continua" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("presents grammar, context, and explanation immediately without a disclosure control", () => {
    render(entry());
    expect(screen.getByText(PRESENTATION.grammar ?? "")).toBeDefined();
    expect(screen.getByText(PRESENTATION.context ?? "")).toBeDefined();
    expect(screen.getByText(PRESENTATION.explanation ?? "")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Note d’uso" })).toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("replaces all visible teaching content when the word changes", () => {
    const { rerender } = render(entry());
    rerender(
      entry("avoir", "avere", {
        ...PRESENTATION,
        context: "Possedere qualcosa.",
        explanation: "Avoir è l’infinito del verbo avere.",
      })
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("avoir");
    expect(screen.getByText("avere")).toBeDefined();
    expect(screen.getByText("Possedere qualcosa.")).toBeDefined();
    expect(
      screen.getByText("Avoir è l’infinito del verbo avere.")
    ).toBeDefined();
    expect(screen.queryByText(PRESENTATION.context ?? "")).toBeNull();
  });

  it("omits empty notes and examples for a plain entry", () => {
    render(
      <DictionaryEntry
        answer="chien"
        meaning="cane"
        onListen={onListen}
        onContinue={onContinue}
      />
    );
    expect(screen.getByText("cane")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Note d’uso" })).toBeNull();
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("shows legacy teaching notes directly with the entry", () => {
    render(
      <DictionaryEntry
        answer="chien"
        meaning="cane"
        note="Un animale domestico."
        onListen={onListen}
        onContinue={onContinue}
      />
    );
    expect(screen.getByText("Un animale domestico.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Note d’uso" })).toBeNull();
  });
});
