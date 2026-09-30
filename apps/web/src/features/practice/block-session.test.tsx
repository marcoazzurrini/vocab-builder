// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createI18n } from "@vocab/i18n";
import { DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { ReviewSnapshot, Word } from "@vocab/spaced-repetition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionScreen } from "./session-screen";
import * as speech from "./speak";
import type { PracticeTransport } from "./transport";

const word: Word = {
  freqRank: 1,
  gloss: "cane",
  hint: null,
  id: "w1",
  image: null,
  kind: "word",
  text: "chien",
};
const snapshot = (): ReviewSnapshot => ({
  cards: [],
  guesses: [],
  teachings: [
    {
      initialRecallAt: new Date(Date.now() - 1000).toISOString(),
      reviewedAt: new Date(Date.now() - 61_000).toISOString(),
      wordId: word.id,
    },
  ],
  words: [word],
});
let queryClient: QueryClient;
const save = vi.fn<PracticeTransport["persistAnswer"]>();
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const mount = async (data = snapshot(), userId = "u1") => {
  const i18n = await createI18n("en");
  const transport: PracticeTransport = {
    loadPractice: () =>
      Promise.resolve({ settings: DEFAULT_SETTINGS, snapshot: data }),
    persistAnswer: save,
  };
  const result = render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <SessionScreen userId={userId} transport={transport} />
      </QueryClientProvider>
    </I18nProvider>
  );
  await advance(1);
  return result;
};
const start = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await advance(1);
};

describe("bounded practice sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient();
    save.mockReset().mockResolvedValue();
    vi.spyOn(speech, "speak").mockReturnValue();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows only a title, duration choices, and the start action", async () => {
    await mount();
    const heading = screen.getByRole("heading", { name: "Start session" });
    expect(heading.closest("section")?.textContent).toBe(
      "Start session3 min5 min10 minStart session"
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows remaining time without a toggle during practice or pause", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "3 minutes" }));
    await start();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("About 3 min left")).toBeDefined();
    expect(screen.queryByRole("switch")).toBeNull();
    await advance(60_000);
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("does not submit or remove an answer when the time goal is reached", async () => {
    await mount();
    await start();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chi" } });
    await advance(301_000);
    expect(screen.getByRole("textbox").getAttribute("value")).toBe("chi");
    expect(
      screen.getByText("Finish this word at your own pace.")
    ).toBeDefined();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chien" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await advance(1);
    expect(save).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
  });

  it("keeps corrective feedback visible past the goal until Continue", async () => {
    await mount();
    await start();
    await advance(301_000);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await advance(1);
    expect(screen.getByText("not quite")).toBeDefined();
    expect(
      screen.queryByRole("heading", { name: "Session finished" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
  });

  it("does not carry an abandoned draft into a new block", async () => {
    await mount();
    await start();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chi" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continue practicing" })
    );
    await advance(1);
    expect(screen.getByRole("textbox").getAttribute("value")).toBe("");
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves unfinished feedback through save recovery at the time goal", async () => {
    save.mockRejectedValueOnce(new Error("offline"));
    await mount();
    await start();
    await advance(301_000);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    await advance(1);
    expect(screen.getByText("offline")).toBeDefined();
    await advance(600_000);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await advance(1);
    expect(screen.getByText("not quite")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].id).toBe(save.mock.calls[0]?.[0].id);
  });

  it.each(["teach", "recall"] as const)(
    "keeps an unanswered %s prompt after a rejected local write at the goal",
    async (phase) => {
      await mount(
        phase === "teach"
          ? { cards: [], guesses: [], words: [word] }
          : snapshot()
      );
      await start();
      await advance(301_000);
      const submit = () => {
        if (phase === "recall") {
          fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "chien" },
          });
        }
        fireEvent.click(
          screen.getByRole("button", {
            name: phase === "teach" ? "Continue" : "Good",
          })
        );
      };
      const write = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("storage full");
        });
      submit();
      await advance(1);
      expect(screen.getByText("storage full")).toBeDefined();
      expect(save).not.toHaveBeenCalled();

      write.mockRestore();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await advance(1);
      expect(
        screen.queryByRole("heading", { name: "Session finished" })
      ).toBeNull();
      submit();
      await advance(1);
      expect(save.mock.calls.map(([answer]) => answer.phase)).toStrictEqual([
        phase,
      ]);
      expect(
        screen.getByRole("heading", { name: "Session finished" })
      ).toBeDefined();
    }
  );

  it("pauses without losing a draft and excludes time away", async () => {
    await mount();
    await start();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chi" } });
    await advance(60_000);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    await advance(600_000);
    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));
    expect(screen.getByRole("textbox").getAttribute("value")).toBe("chi");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "20"
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect(save).not.toHaveBeenCalled();
  });

  it("does not count hidden-tab time", async () => {
    await mount();
    await start();
    await advance(60_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(600_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "20"
    );
    await advance(30_000);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "30"
    );
  });

  it("remembers elapsed practice and resumes paused after refresh", async () => {
    const first = await mount();
    await start();
    await advance(60_000);
    first.unmount();
    await mount();
    expect(
      screen.getByRole("heading", { name: "Session paused" })
    ).toBeDefined();
    await advance(600_000);
    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "20"
    );
  });

  it("stays finished rather than restarting when a first recall becomes due", async () => {
    await mount({ cards: [], guesses: [], words: [word] });
    expect(speech.speak).not.toHaveBeenCalled();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(1);
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
    await advance(120_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].phase).toBe("teach");
  });
});
