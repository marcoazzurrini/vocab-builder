// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useVisibleViewport } from "./use-visible-viewport";

const Example = () => {
  const ref = useVisibleViewport();
  return (
    <div ref={ref} data-testid="viewport">
      <input aria-label="Answer" />
    </div>
  );
};

describe("visible viewport", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("tracks keyboard height and Safari panning, then restores navigation", () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 700,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      700
    );
    const { unmount } = render(<Example />);
    const shell = screen.getByTestId("viewport");
    expect({
      height: shell.style.getPropertyValue("--visible-height"),
      keyboard: shell.dataset.keyboard,
    }).toStrictEqual({ height: "700px", keyboard: "false" });
    screen.getByRole("textbox").focus();
    viewport.height = 360;
    viewport.dispatchEvent(new Event("resize"));
    expect({
      height: shell.style.getPropertyValue("--visible-height"),
      keyboard: shell.dataset.keyboard,
    }).toStrictEqual({ height: "360px", keyboard: "true" });
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    expect(shell.style.getPropertyValue("--visible-top")).toBe("40px");
    screen.getByRole("textbox").blur();
    viewport.height = 700;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(shell.dataset.keyboard).toBe("false");
    unmount();
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    expect(shell.style.getPropertyValue("--visible-height")).toBe("700px");
  });

  it("does not treat pinch zoom or hardware keyboard focus as a software keyboard", () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 700,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      700
    );
    render(<Example />);
    const shell = screen.getByTestId("viewport");
    screen.getByRole("textbox").focus();
    expect(shell.dataset.keyboard).toBe("false");
    viewport.scale = 2;
    viewport.height = 350;
    viewport.dispatchEvent(new Event("resize"));
    expect(shell.dataset.keyboard).toBe("false");
    expect(shell.style.getPropertyValue("--visible-height")).toBe("");
  });

  it("clears a keyboard snapshot when zooming and dismissing the keyboard", () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 700,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      700
    );
    render(<Example />);
    const shell = screen.getByTestId("viewport");
    screen.getByRole("textbox").focus();
    viewport.height = 350;
    viewport.dispatchEvent(new Event("resize"));
    expect(shell.dataset.keyboard).toBe("true");
    viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize"));
    screen.getByRole("textbox").blur();
    expect({
      height: shell.style.getPropertyValue("--visible-height"),
      keyboard: shell.dataset.keyboard,
      top: shell.style.getPropertyValue("--visible-top"),
    }).toStrictEqual({ height: "", keyboard: "false", top: "" });
    viewport.scale = 1;
    viewport.height = 700;
    viewport.dispatchEvent(new Event("resize"));
    expect(shell.style.getPropertyValue("--visible-height")).toBe("700px");
  });

  it("leaves the CSS dvh fallback in place without VisualViewport", () => {
    vi.stubGlobal("visualViewport", null);
    render(<Example />);
    expect(screen.getByTestId("viewport").style).toHaveLength(0);
  });
});
