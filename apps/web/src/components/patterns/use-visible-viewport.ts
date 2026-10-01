import { useEffect, useRef } from "react";

/** iOS resizes the visual viewport, not dvh, when its software keyboard opens. */
export const useVisibleViewport = () => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = ref.current;
    if (!viewport || !shell) {
      return;
    }
    const update = () => {
      // Pinch zoom must remain browser-owned, not reflow the app around the zoom.
      if (viewport.scale !== 1) {
        // Drop any keyboard-sized snapshot: dismissal while zoomed must not
        // strand the user in a short shell with permanently hidden navigation.
        shell.style.removeProperty("--visible-height");
        shell.style.removeProperty("--visible-top");
        shell.dataset.keyboard = "false";
        return;
      }
      shell.style.setProperty("--visible-height", `${viewport.height}px`);
      shell.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
      const focused = document.activeElement;
      const editing =
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        (focused instanceof HTMLElement && focused.isContentEditable);
      const reduced =
        document.documentElement.clientHeight - viewport.height > 100;
      shell.dataset.keyboard = String(
        reduced && (editing || shell.dataset.keyboard === "true")
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);

  return ref;
};
