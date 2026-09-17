// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { createI18n } from "@vocab/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./error-boundary";

const Boom = (): never => {
  throw new Error('expected phase "recall", session is in "done"');
};

describe("the last line before a blank page", () => {
  beforeEach(() => {
    // React logs the caught error itself; the test is not interested.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stays out of the way when nothing is wrong", () => {
    render(
      <ErrorBoundary>
        <p>ciao</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("ciao")).toBeDefined();
  });

  it("offers a way back instead of unmounting the app", async () => {
    const i18n = await createI18n("it");
    render(
      <I18nProvider i18n={i18n}>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </I18nProvider>
    );

    // The session throws on a call made in the wrong phase, which a double tap
    // can produce. Without this the whole tree unmounts to an empty page.
    expect(
      screen.getByRole("button", { name: "Ricarica la pagina" })
    ).toBeDefined();
    // And it says the day's work is not lost, because it is not.
    expect(screen.getByText(/salvate/iu)).toBeDefined();
  });
});
