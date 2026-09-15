// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ReviewSnapshot,
  AnswerCommand,
  Word,
} from "@vocab/spaced-repetition";
import { DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionScreen } from "./session-screen";
import type { PracticeTransport } from "./transport";
import { usePracticeSession } from "./use-practice-session";

const loadSnapshot = vi.fn<(lang: string) => Promise<ReviewSnapshot>>();
const persistAnswer =
  vi.fn<(command: AnswerCommand, expectedUserId: string) => Promise<void>>();

const transport: PracticeTransport = {
  loadSettings: () => Promise.resolve(DEFAULT_SETTINGS),
  loadSnapshot,
  persistAnswer,
};

const CHIEN: Word = {
  freqRank: 1,
  gloss: "cane",
  hint: null,
  id: "w1",
  image: "🐶",
  kind: "word",
  text: "chien",
};

const deck = (words: Word[] = [CHIEN]): ReviewSnapshot => ({
  cards: [],
  guesses: [],
  words,
});

const deferred = <T,>() => {
  // SAFETY: The Promise executor runs synchronously and assigns release before this helper returns.
  let release!: (value: T) => void;
  // eslint-disable-next-line promise/avoid-new -- Tests must control completion order; ES2023 lacks Promise.withResolvers.
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
};

const becomeVisible = () => {
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("the session screen", () => {
  beforeEach(() => {
    loadSnapshot.mockReset().mockResolvedValue(deck());
    persistAnswer.mockReset().mockResolvedValue();
    window.localStorage.clear();
  });
  afterEach(() => {
    // Not automatic: Testing Library only registers its own cleanup when
    // vitest runs with `globals: true`, and this project does not.
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks for a guess once the deck has loaded", async () => {
    render(<SessionScreen transport={transport} userId="u1" />);
    await expect(screen.findByText("cane")).resolves.toBeDefined();
    // The answer is absent from the guess screen, not merely hidden.
    expect(screen.queryByText("chien")).toBeNull();
  });

  it("does not rebuild the session mid-card when the tab comes back", async () => {
    // Rebuilding here would throw away the prompt on screen.
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");

    becomeVisible();
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledOnce());
  });

  it("rebuilds when the tab comes back on a finished session", async () => {
    // `done` is final, so without this the end screen is what a phone shows
    // hours later, with the day's cards waiting behind it.
    loadSnapshot.mockResolvedValue(deck([]));
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("sessione finita");

    becomeVisible();
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("rebuilds when the tab comes back on a new day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");

    // Left open across midnight: the rule would start serving tomorrow's
    // reviews while the allowance is still yesterday's.
    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible();

    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("waits for writes in flight before rebuilding the deck", async () => {
    // A rebuild that reads the database past its own unfinished writes serves
    // the card just answered again. The deck must not be re-read until the
    // queue has drained.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    const pending = deferred<null>();
    persistAnswer.mockImplementation(async () => {
      await pending.promise;
    });

    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");
    // A guess, whose write hangs.
    fireEvent.click(screen.getByText("Continua"));

    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    // A new day, so a rebuild is wanted — but not yet.
    becomeVisible();

    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(loadSnapshot).toHaveBeenCalledOnce();

    pending.resolve(null);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("pauses caught up, then rebuilds itself when the next card comes due", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T09:00:00"));

    const learning = {
      difficulty: 5,
      due: new Date("2026-08-10T09:04:00"),
      elapsed_days: 0,
      lapses: 0,
      learning_steps: 0,
      reps: 1,
      scheduled_days: 0,
      stability: 1,
      state: 1,
    };
    loadSnapshot.mockResolvedValue({
      cards: [{ schedule: JSON.stringify(learning), wordId: "w1" }],
      // Allowance spent.
      guesses: Array.from({ length: 15 }, (_, i) => ({
        reviewedAt: new Date().toISOString(),
        wordId: `introduced-${i}`,
      })),
      words: [CHIEN],
    });

    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("scrivi la parola francese");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chien" },
    });
    fireEvent.click(screen.getByText("Bene"));

    // Nothing else to do, and the card's next step is minutes away: the
    // honest screen, not a fake end of session.
    await expect(
      screen.findByText("Tutto fatto, per ora")
    ).resolves.toBeDefined();
    expect(screen.queryByText("Bravo")).toBeNull();

    // When the due time passes, the screen rebuilds on its own.
    vi.advanceTimersByTime(60 * 60_000);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
  });

  it("does not accept answers against an old snapshot during a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));
    const pending = deferred<ReviewSnapshot>();
    loadSnapshot
      .mockResolvedValueOnce(deck())
      .mockReturnValueOnce(pending.promise);
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");
    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible();
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Continua")).toBeNull();
    await act(() => {
      pending.resolve(deck());
      return pending.promise;
    });
    await expect(screen.findByText("cane")).resolves.toBeDefined();
  });

  it("ignores a previous account's response after a keyed remount", async () => {
    const pending = deferred<ReviewSnapshot>();
    loadSnapshot.mockReturnValueOnce(pending.promise);
    loadSnapshot.mockResolvedValueOnce(
      deck([{ ...CHIEN, gloss: "gatto", id: "w2", text: "chat" }])
    );
    const mounted = render(
      <SessionScreen transport={transport} key="u1" userId="u1" />
    );
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledOnce());
    mounted.rerender(
      <SessionScreen transport={transport} key="u2" userId="u2" />
    );
    await screen.findByText("gatto");
    await act(() => {
      pending.resolve(deck());
      return pending.promise;
    });
    expect(screen.queryByText("cane")).toBeNull();
    expect(screen.getByText("gatto")).toBeDefined();
  });

  it("retries the same stored answer under its original account", async () => {
    persistAnswer.mockRejectedValueOnce(new Error("network down"));
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText(/network down/u);
    expect(window.localStorage).toHaveLength(1);
    const [first] = persistAnswer.mock.calls;
    expect(first?.[1]).toBe("u1");
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledTimes(2));
    expect(persistAnswer.mock.calls[1]).toStrictEqual(first);
    await waitFor(() => expect(window.localStorage).toHaveLength(0));
  });

  it("recovers from a rejected local write without sending or losing the unanswered prompt", async () => {
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage full");
      });

    expect(() => fireEvent.click(screen.getByText("Continua"))).not.toThrow();
    const alert = await screen.findByRole("alert");
    expect({
      alert: alert.textContent,
      answer: screen.queryByText("chien"),
      calls: persistAnswer.mock.calls,
      stored: window.localStorage.length,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({
      alert: "Salvataggio non riuscito: storage full",
      answer: null,
      calls: [],
      stored: 0,
      textbox: null,
    });

    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await screen.findByText("cane");
    expect({
      alert: screen.queryByRole("alert"),
      calls: persistAnswer.mock.calls,
      loads: loadSnapshot.mock.calls.length,
      textbox: screen.getByRole("textbox"),
    }).toStrictEqual({
      alert: null,
      calls: [],
      loads: 2,
      textbox: expect.any(HTMLInputElement),
    });

    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText("chien");
    await waitFor(() => {
      expect({
        calls: persistAnswer.mock.calls,
        stored: window.localStorage.length,
      }).toStrictEqual({
        calls: [
          [expect.objectContaining({ phase: "guess", wordId: "w1" }), "u1"],
        ],
        stored: 0,
      });
    });
  });

  it("never exposes the stale prompt between clearing an error and starting a retry reload", async () => {
    const visiblePrompts: string[] = [];
    const { result } = renderHook(() => {
      const practice = usePracticeSession("u1", transport);
      if (
        !practice.writeError &&
        !practice.loadError &&
        practice.view?.phase === "guess"
      ) {
        visiblePrompts.push(practice.view.prompt.gloss);
      }
      return practice;
    });
    await waitFor(() => expect(result.current.view?.phase).toBe("guess"));
    const submitOldPrompt = result.current.submitGuess;
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage full");
      });
    act(() => result.current.submitGuess(""));
    expect(result.current.writeError).toBe("storage full");
    write.mockRestore();
    loadSnapshot.mockResolvedValue(
      deck([{ ...CHIEN, gloss: "gatto", id: "w2", text: "chat" }])
    );
    visiblePrompts.length = 0;
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() =>
      expect(result.current.view).toMatchObject({
        phase: "guess",
        prompt: { gloss: "gatto" },
      })
    );
    expect(visiblePrompts).not.toContain("cane");
    act(() => submitOldPrompt("chien"));
    expect(result.current.view).toMatchObject({
      phase: "guess",
      prompt: { gloss: "gatto" },
    });
    expect(persistAnswer).not.toHaveBeenCalled();
  });

  it("reports a write failure it cannot act on", async () => {
    persistAnswer.mockRejectedValue(new Error("network down"));

    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText("cane");
    // The guess's write fails.
    fireEvent.click(screen.getByText("Continua"));

    await expect(screen.findByText(/network down/u)).resolves.toBeDefined();
  });
});
