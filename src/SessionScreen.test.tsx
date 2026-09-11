// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createEmptyCard, State } from "ts-fsrs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "./lib/deck";
import { DEFAULT_SETTINGS } from "./lib/deck";
import type { AnswerCommand } from "./lib/commands";
import type { Word } from "./session/types";

const loadDeck = vi.fn<(lang: string, now: Date) => Promise<Deck>>();
const persistAnswer = vi.fn<(command: AnswerCommand, expectedUserId: string) => Promise<void>>();

vi.mock("./lib/speak", () => ({ speak: vi.fn(), warmUpVoices: vi.fn() }));

vi.mock("./lib/repository", () => ({
  loadSettings: () => Promise.resolve(DEFAULT_SETTINGS),
  loadDeck: (lang: string, now: Date) => loadDeck(lang, now),
  persistAnswer: (command: AnswerCommand, expectedUserId: string) =>
    persistAnswer(command, expectedUserId),
}));

const { SessionScreen } = await import("./SessionScreen");

const CHIEN: Word = {
  id: "w1",
  text: "chien",
  gloss: "cane",
  hint: null,
  image: "🐶",
  kind: "word",
  freqRank: 1,
};

function deck(words: Word[] = [CHIEN]): Deck {
  return { words, cards: [], introducedToday: 0 };
}

function becomeVisible() {
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("the session screen", () => {
  beforeEach(() => {
    loadDeck.mockReset().mockResolvedValue(deck());
    persistAnswer.mockReset().mockResolvedValue(undefined);
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
    render(<SessionScreen userId="u1" />);
    expect(await screen.findByText("cane")).toBeDefined();
    // The answer is absent from the guess screen, not merely hidden.
    expect(screen.queryByText("chien")).toBeNull();
  });

  it("does not rebuild the session mid-card when the tab comes back", async () => {
    // Rebuilding here would throw away the prompt on screen.
    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");

    becomeVisible();
    await waitFor(() => expect(loadDeck).toHaveBeenCalledTimes(1));
  });

  it("rebuilds when the tab comes back on a finished session", async () => {
    // `done` is final, so without this the end screen is what a phone shows
    // hours later, with the day's cards waiting behind it.
    loadDeck.mockResolvedValue(deck([]));
    render(<SessionScreen userId="u1" />);
    await screen.findByText("sessione finita");

    becomeVisible();
    await waitFor(() => expect(loadDeck).toHaveBeenCalledTimes(2));
  });

  it("rebuilds when the tab comes back on a new day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");

    // Left open across midnight: the rule would start serving tomorrow's
    // reviews while the allowance is still yesterday's.
    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible();

    await waitFor(() => expect(loadDeck).toHaveBeenCalledTimes(2));
  });

  it("waits for writes in flight before rebuilding the deck", async () => {
    // A rebuild that reads the database past its own unfinished writes serves
    // the card just answered again. The deck must not be re-read until the
    // queue has drained.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    let release!: () => void;
    persistAnswer.mockImplementation(() => new Promise<void>((r) => (release = r)));

    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua")); // a guess, whose write hangs

    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible(); // a new day, so a rebuild is wanted — but not yet

    await new Promise((r) => setTimeout(r, 20));
    expect(loadDeck).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(loadDeck).toHaveBeenCalledTimes(2));
  });

  it("pauses caught up, then rebuilds itself when the next card comes due", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T09:00:00"));

    const learning = {
      ...createEmptyCard(new Date("2026-08-10T08:00:00")),
      reps: 1,
      state: State.Learning,
      due: new Date("2026-08-10T09:04:00"),
    };
    loadDeck.mockResolvedValue({
      words: [CHIEN],
      cards: [{ wordId: "w1", fsrs: learning }],
      introducedToday: 15, // allowance spent, so nothing new can fill the gap
    });

    render(<SessionScreen userId="u1" />);
    await screen.findByText("scrivi la parola francese");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chien" } });
    fireEvent.click(screen.getByText("Bene"));

    // Nothing else to do, and the card's next step is minutes away: the
    // honest screen, not a fake end of session.
    expect(await screen.findByText("Tutto fatto, per ora")).toBeDefined();
    expect(screen.queryByText("Bravo")).toBeNull();

    // When the due time passes, the screen rebuilds on its own.
    vi.advanceTimersByTime(60 * 60_000);
    await waitFor(() => expect(loadDeck).toHaveBeenCalledTimes(2));
  });

  it("retries the same stored answer under its original account", async () => {
    persistAnswer.mockRejectedValueOnce(new Error("network down"));
    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText(/network down/);
    expect(window.localStorage.length).toBe(1);
    const first = persistAnswer.mock.calls[0]!;
    expect(first[1]).toBe("u1");
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledTimes(2));
    expect(persistAnswer.mock.calls[1]).toEqual(first);
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });

  it("reports a write failure it cannot act on", async () => {
    persistAnswer.mockRejectedValue(new Error("network down"));

    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua")); // the guess's write fails

    expect(await screen.findByText(/network down/)).toBeDefined();
  });
});
