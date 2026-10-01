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
const deferred = () => {
  // SAFETY: Promise executors run synchronously before this helper returns.
  let release!: () => void;
  let fail!: (reason: Error) => void;
  // eslint-disable-next-line promise/avoid-new -- Tests control acknowledgement order; ES2023 lacks Promise.withResolvers.
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, reject: fail, resolve: release };
};
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
  const tree = (active: boolean) => (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <div hidden={!active}>
          <SessionScreen
            userId={userId}
            transport={transport}
            active={active}
          />
        </div>
      </QueryClientProvider>
    </I18nProvider>
  );
  const result = render(tree(true));
  await advance(1);
  return {
    ...result,
    setActive: (active: boolean) => result.rerender(tree(active)),
  };
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

  it("excludes time in Account and preserves the current draft when returning", async () => {
    const { setActive } = await mount();
    await start();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "chi" } });
    await advance(60_000);
    const bar = screen.getByRole("progressbar");
    const progress = bar.getAttribute("aria-valuenow");
    setActive(false);
    await advance(120_000);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(bar.getAttribute("aria-valuenow")).toBe(progress);
    expect(save).not.toHaveBeenCalled();
    setActive(true);
    expect(screen.getByDisplayValue("chi")).toBe(input);
    await advance(30_000);
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
  });

  it("does not resume an explicitly paused session after visiting Account", async () => {
    const { setActive } = await mount();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    setActive(false);
    await advance(120_000);
    setActive(true);
    expect(
      screen.getByRole("heading", { name: "Session paused" })
    ).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(save).not.toHaveBeenCalled();
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

  it("explains an unavailable restart and starts recall only when it becomes due", async () => {
    const data = snapshot();
    const nextDueAt = new Date(Date.now() + 60_000);
    data.teachings = [
      {
        initialRecallAt: nextDueAt.toISOString(),
        reviewedAt: new Date().toISOString(),
        wordId: word.id,
      },
    ];
    await mount(data);
    await start();
    expect({
      canContinue:
        screen.queryByRole("button", { name: "Continue practicing" }) !== null,
      heading: screen.getByRole("heading", { name: "You're caught up" })
        .textContent,
      showsNextDue:
        screen.queryByText(/Nothing is due right now\. Next review:/u) !== null,
    }).toStrictEqual({
      canContinue: false,
      heading: "You're caught up",
      showsNextDue: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await advance(1);
    expect({
      answer: screen.queryByRole("textbox"),
      heading: screen.getByRole("heading", { name: "You're caught up" })
        .textContent,
    }).toStrictEqual({ answer: null, heading: "You're caught up" });
    await advance(60_000);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await advance(1);
    expect(screen.getByRole("textbox")).toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("explains an empty catalogue instead of offering an impossible continuation", async () => {
    await mount({ cards: [], guesses: [], words: [] });
    await start();
    expect(
      screen.getByRole("heading", { name: "You're caught up" })
    ).toBeDefined();
    expect(
      screen.getByText(/No more practice is available right now/u)
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Continue practicing" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await advance(1);
    expect(
      screen.getByRole("heading", { name: "You're caught up" })
    ).toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("restores the new-word budget after a time-limited block", async () => {
    const data = snapshot();
    data.words.push({
      ...word,
      freqRank: 2,
      gloss: "gatto",
      id: "w2",
      text: "chat",
    });
    await mount(data);
    await start();
    await advance(301_000);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chien" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    // Keep the reviewed word in the catalogue, with its acknowledged schedule.
    data.cards = [
      {
        schedule: JSON.stringify({
          difficulty: 5,
          due: new Date(Date.now() + 60_000),
          elapsed_days: 0,
          lapses: 0,
          last_review: new Date(),
          learning_steps: 0,
          reps: 1,
          scheduled_days: 0,
          stability: 1,
          state: 1,
        }),
        wordId: word.id,
      },
    ];
    await advance(1);
    expect(
      screen.getByRole("heading", { name: "Session finished" })
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue practicing" })
    );
    await advance(1);
    expect(screen.getByRole("heading", { name: "chat" })).toBeDefined();
  });

  it("waits for an outstanding teaching write before checking for more practice", async () => {
    const pending = deferred();
    save.mockReturnValueOnce(pending.promise);
    const data: ReviewSnapshot = { cards: [], guesses: [], words: [word] };
    await mount(data);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(1);
    const check = screen.getByRole("button", { name: "Check again" });
    fireEvent.click(check);
    await advance(1);
    expect(screen.queryByRole("heading", { name: "chien" })).toBeNull();
    // A detached control cannot trigger another restart or another answer.
    fireEvent.click(check);
    data.teachings = [
      {
        initialRecallAt: new Date(Date.now() + 60_000).toISOString(),
        reviewedAt: new Date().toISOString(),
        wordId: word.id,
      },
    ];
    pending.resolve();
    await advance(1);
    expect(
      screen.getByRole("heading", { name: "You're caught up" })
    ).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps write recovery available when a restart's outstanding save fails", async () => {
    const pending = deferred();
    save.mockReturnValueOnce(pending.promise);
    await mount({ cards: [], guesses: [], words: [word] });
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(1);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await advance(1);
    pending.reject(new Error("network down"));
    await advance(1);
    expect(screen.getByRole("alert").textContent).toContain("network down");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "chien" })).toBeNull();
    expect(save).toHaveBeenCalledOnce();
  });

  it("stays finished rather than restarting when a first recall becomes due", async () => {
    await mount({ cards: [], guesses: [], words: [word] });
    expect(speech.speak).not.toHaveBeenCalled();
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await advance(1);
    expect(
      screen.getByRole("heading", { name: "You're caught up" })
    ).toBeDefined();
    await advance(120_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(
      screen.getByRole("heading", { name: "You're caught up" })
    ).toBeDefined();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0].phase).toBe("teach");
  });
});
