// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "./lib/repository";
import type { Word } from "./session/types";

const loadDeck = vi.fn<(lang: string, now: Date) => Promise<Deck>>();
const upsertCard = vi.fn<() => Promise<void>>();
const insertAttempt = vi.fn<() => Promise<void>>();

vi.mock("./lib/speak", () => ({ speak: vi.fn(), warmUpVoices: vi.fn() }));

vi.mock("./lib/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/repository")>();
  return {
    ...actual,
    loadDeck: (lang: string, now: Date) => loadDeck(lang, now),
    upsertCard: () => upsertCard(),
    insertAttempt: () => insertAttempt(),
  };
});

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
    upsertCard.mockReset().mockResolvedValue(undefined);
    insertAttempt.mockReset().mockResolvedValue(undefined);
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
    insertAttempt.mockImplementation(() => new Promise<void>((r) => (release = r)));

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

  it("reports a write failure it cannot act on", async () => {
    insertAttempt.mockRejectedValue(new Error("network down"));

    render(<SessionScreen userId="u1" />);
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua")); // the guess's write fails

    expect(await screen.findByText(/network down/)).toBeDefined();
  });
});
