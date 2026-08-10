import { createEmptyCard, State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { pickNext } from "./queue";
import type { Card, Word } from "./types";

const NOW = new Date("2026-08-10T09:00:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function word(id: string, freqRank: number): Word {
  return {
    id,
    text: `mot-${id}`,
    gloss: `parola-${id}`,
    hint: null,
    image: null,
    kind: "word",
    freqRank,
  };
}

function card(id: string, wordId: string, due: Date, state: State): Card {
  return {
    id,
    wordId,
    fsrs: { ...createEmptyCard(NOW), due, state, reps: state === State.New ? 0 : 1 },
  };
}

const WORDS = [word("w1", 1), word("w2", 2), word("w3", 3)];

describe("next-card rule", () => {
  it("shows a due learning card before introducing anything new", () => {
    const due = card("c1", "w1", new Date(NOW.getTime() - MINUTE), State.Learning);
    const next = pickNext({ cards: [due], words: WORDS, now: NOW, allowanceLeft: 5 });
    expect(next).toEqual({ kind: "card", card: due, pulledForward: false });
  });

  it("introduces a new word before doing reviews", () => {
    // New words first so their second recall lands inside the review block,
    // which is the longest gap the session can give them for free.
    const review = card("c1", "w1", NOW, State.Review);
    const next = pickNext({ cards: [review], words: WORDS, now: NOW, allowanceLeft: 1 });
    expect(next).toEqual({ kind: "introduce", word: WORDS[1] });
  });

  it("introduces new words in frequency order", () => {
    const shuffled = [word("w3", 3), word("w1", 1), word("w2", 2)];
    const next = pickNext({ cards: [], words: shuffled, now: NOW, allowanceLeft: 1 });
    expect(next).toEqual({ kind: "introduce", word: expect.objectContaining({ id: "w1" }) });
  });

  it("falls through to reviews once the allowance is spent", () => {
    const review = card("c1", "w1", NOW, State.Review);
    const next = pickNext({ cards: [review], words: WORDS, now: NOW, allowanceLeft: 0 });
    expect(next).toEqual({ kind: "card", card: review, pulledForward: false });
  });

  it("never exceeds the allowance even with words left", () => {
    const next = pickNext({ cards: [], words: WORDS, now: NOW, allowanceLeft: 0 });
    expect(next).toEqual({ kind: "done" });
  });

  it("pulls a learning card forward rather than waiting", () => {
    const soon = card("c1", "w1", new Date(NOW.getTime() + 8 * MINUTE), State.Learning);
    const next = pickNext({ cards: [soon], words: [], now: NOW, allowanceLeft: 0 });
    expect(next).toEqual({ kind: "card", card: soon, pulledForward: true });
  });

  it("never pulls a review forward from a future day", () => {
    // Three days of earned spacing is not filler for an empty minute.
    const future = card("c1", "w1", new Date(NOW.getTime() + 72 * HOUR), State.Review);
    const next = pickNext({ cards: [future], words: [], now: NOW, allowanceLeft: 0 });
    expect(next).toEqual({ kind: "done" });
  });

  it("does not hand back the card just answered", () => {
    // Step 4 with one candidate left would otherwise be massing with extra steps.
    const soon = card("c1", "w1", new Date(NOW.getTime() + 8 * MINUTE), State.Learning);
    const next = pickNext({
      cards: [soon],
      words: [],
      now: NOW,
      allowanceLeft: 0,
      justShownId: "c1",
    });
    expect(next).toEqual({ kind: "done" });
  });

  it("pulls a different card forward when one is available", () => {
    const a = card("c1", "w1", new Date(NOW.getTime() + 8 * MINUTE), State.Learning);
    const b = card("c2", "w2", new Date(NOW.getTime() + 9 * MINUTE), State.Learning);
    const next = pickNext({
      cards: [a, b],
      words: [],
      now: NOW,
      allowanceLeft: 0,
      justShownId: "c1",
    });
    expect(next).toEqual({ kind: "card", card: b, pulledForward: true });
  });

  describe("an introduction left unfinished", () => {
    // A card is written when a word is introduced, so the guess attempt has
    // something to reference. Quit before answering and the card exists with no
    // rating — which is a word not yet introduced, not a card to schedule.
    const unrated = () => card("c1", "w1", NOW, State.New);

    it("is handed back to the introduction path, not scheduled", () => {
      const next = pickNext({
        cards: [unrated()],
        words: WORDS,
        now: NOW,
        allowanceLeft: 5,
      });
      expect(next).toEqual({
        kind: "introduce",
        word: expect.objectContaining({ id: "w1" }),
        existing: expect.objectContaining({ id: "c1" }),
      });
    });

    it("is resumed even when the allowance is spent", () => {
      // The allowance was already spent when the card was created.
      const next = pickNext({
        cards: [unrated()],
        words: WORDS,
        now: NOW,
        allowanceLeft: 0,
      });
      expect(next).toMatchObject({ kind: "introduce", existing: { id: "c1" } });
    });

    it("is finished before any new word is started", () => {
      const next = pickNext({
        cards: [unrated()],
        words: WORDS,
        now: NOW,
        allowanceLeft: 5,
      });
      expect(next).toMatchObject({ existing: { id: "c1" } });
    });

    it("is never pulled forward as filler", () => {
      const future = card("c1", "w1", new Date(NOW.getTime() + 8 * MINUTE), State.New);
      const next = pickNext({ cards: [future], words: [], now: NOW, allowanceLeft: 0 });
      // No word for it in the catalogue, so it cannot be introduced either.
      expect(next).toEqual({ kind: "done" });
    });
  });

  it("is done when nothing is left", () => {
    expect(pickNext({ cards: [], words: [], now: NOW, allowanceLeft: 5 })).toEqual({
      kind: "done",
    });
  });

  it("picks the earliest due among several", () => {
    const later = card("c1", "w1", new Date(NOW.getTime() - MINUTE), State.Learning);
    const earlier = card("c2", "w2", new Date(NOW.getTime() - 5 * MINUTE), State.Learning);
    const next = pickNext({
      cards: [later, earlier],
      words: WORDS,
      now: NOW,
      allowanceLeft: 0,
    });
    expect(next).toEqual({ kind: "card", card: earlier, pulledForward: false });
  });

  it("counts a review due later today as due", () => {
    const tonight = card("c1", "w1", new Date(NOW.getTime() + 10 * HOUR), State.Review);
    const next = pickNext({ cards: [tonight], words: [], now: NOW, allowanceLeft: 0 });
    expect(next).toEqual({ kind: "card", card: tonight, pulledForward: false });
  });
});
