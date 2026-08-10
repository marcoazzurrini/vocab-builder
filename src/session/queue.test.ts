import { createEmptyCard, State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { pickNext, stageOf } from "./queue";
import type { Queue, Slot } from "./queue";
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

const WORDS = [word("w1", 1), word("w2", 2), word("w3", 3)];

// The builders below can only make cards the pipeline can actually produce.
// The previous helper took `state` and `guessed` independently, so most tests
// ran against a rated-but-never-guessed card — a combination that cannot exist,
// while the combination that *did* cause a bug appeared in one test.

/** A row written at introduction, abandoned before the guess. */
function unseen(id: string, wordId: string, createdAt = NOW): Card {
  return { id, wordId, fsrs: createEmptyCard(createdAt), guessed: false };
}

/** Guessed and shown, waiting for FSRS's first rating. */
function awaiting(id: string, wordId: string, createdAt = NOW): Card {
  return { id, wordId, fsrs: createEmptyCard(createdAt), guessed: true };
}

/**
 * Rated at least once. `guessed` is true because it has to be: a card cannot
 * reach a rating without passing through the guess that created its first
 * attempt.
 */
function scheduled(id: string, wordId: string, state: State, due: Date): Card {
  return {
    id,
    wordId,
    fsrs: { ...createEmptyCard(NOW), state, due, reps: 1 },
    guessed: true,
  };
}

function ask(q: Partial<Queue> & Pick<Queue, "cards">): Slot {
  return pickNext({
    words: WORDS,
    now: NOW,
    allowanceLeft: 0,
    exposed: new Set(),
    ...q,
  });
}

describe("a card's stage", () => {
  it("is unseen while no guess has been logged", () => {
    expect(stageOf(unseen("c1", "w1"))).toBe("unseen");
  });

  it("is awaiting once guessed, because FSRS has still never rated it", () => {
    expect(stageOf(awaiting("c1", "w1"))).toBe("awaiting");
  });

  it("is scheduled from the first rating onward", () => {
    expect(stageOf(scheduled("c1", "w1", State.Learning, NOW))).toBe("scheduled");
  });
});

describe("the next-card rule", () => {
  describe("1. a learning card that is due", () => {
    it("comes before everything else", () => {
      const due = scheduled("c1", "w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [due], allowanceLeft: 5 })).toEqual({ do: "recall", card: due });
    });

    it("picks the earliest among several", () => {
      const later = scheduled("c1", "w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      const earlier = scheduled("c2", "w2", State.Learning, new Date(NOW.getTime() - 5 * MINUTE));
      expect(ask({ cards: [later, earlier] })).toEqual({ do: "recall", card: earlier });
    });
  });

  describe("2. an introduction left unfinished", () => {
    it("is handed back to the introduction path, not scheduled", () => {
      // The bug this guards: the row came back as a recall, asking for a word
      // that had never been shown.
      const card = unseen("c1", "w1");
      expect(ask({ cards: [card], allowanceLeft: 5 })).toEqual({
        do: "introduce",
        word: WORDS[0],
        card,
      });
    });

    it("is resumed even with the allowance spent, having already paid for it", () => {
      expect(ask({ cards: [unseen("c1", "w1")], allowanceLeft: 0 })).toMatchObject({
        do: "introduce",
        card: { id: "c1" },
      });
    });

    it("comes before any new word", () => {
      expect(ask({ cards: [unseen("c1", "w1")], allowanceLeft: 5 })).toMatchObject({
        card: { id: "c1" },
      });
    });

    it("is never pulled forward as filler", () => {
      // No word for it in the catalogue, so it cannot be introduced either.
      expect(ask({ cards: [unseen("c1", "gone")], words: [] })).toEqual({ do: "done" });
    });
  });

  describe("3. a new word", () => {
    it("comes before the reviews, so its second recall lands inside them", () => {
      const review = scheduled("c1", "w1", State.Review, NOW);
      expect(ask({ cards: [review], allowanceLeft: 1 })).toEqual({
        do: "introduce",
        word: WORDS[1],
      });
    });

    it("is chosen in frequency order", () => {
      const shuffled = [word("w3", 3), word("w1", 1), word("w2", 2)];
      expect(ask({ cards: [], words: shuffled, allowanceLeft: 1 })).toMatchObject({
        word: { id: "w1" },
      });
    });

    it("is not introduced once the allowance is spent", () => {
      expect(ask({ cards: [], allowanceLeft: 0 })).toEqual({ do: "done" });
    });
  });

  describe("4. a review due today", () => {
    it("follows the new words", () => {
      const review = scheduled("c1", "w1", State.Review, NOW);
      expect(ask({ cards: [review], allowanceLeft: 0 })).toEqual({ do: "recall", card: review });
    });

    it("counts one due later tonight as due", () => {
      const tonight = scheduled("c1", "w1", State.Review, new Date(NOW.getTime() + 10 * HOUR));
      expect(ask({ cards: [tonight] })).toEqual({ do: "recall", card: tonight });
    });

    it("is never pulled forward from a future day", () => {
      // Three days of earned spacing is not filler for an empty minute.
      const future = scheduled("c1", "w1", State.Review, new Date(NOW.getTime() + 72 * HOUR));
      expect(ask({ cards: [future] })).toEqual({ do: "done" });
    });
  });

  describe("5. showing a word waiting for its first recall", () => {
    it("shows it when this sitting has not", () => {
      const card = awaiting("c1", "w1");
      expect(ask({ cards: [card] })).toEqual({ do: "expose", card });
    });

    it("shows the whole batch before asking for any of it", () => {
      // The shape a fresh sitting has, and the shape a resumed one must have.
      const a = awaiting("c1", "w1", NOW);
      const b = awaiting("c2", "w2", new Date(NOW.getTime() + 1000));
      expect(ask({ cards: [a, b], exposed: new Set(["c1"]), justShownId: "c1" })).toEqual({
        do: "expose",
        card: b,
      });
    });

    it("comes after the reviews", () => {
      const review = scheduled("c1", "w1", State.Review, NOW);
      const fresh = awaiting("c2", "w2");
      expect(ask({ cards: [fresh, review] })).toEqual({ do: "recall", card: review });
    });
  });

  describe("6. asking for a word that has been shown", () => {
    it("asks once the exposure has happened", () => {
      const card = awaiting("c1", "w1");
      expect(ask({ cards: [card], exposed: new Set(["c1"]) })).toEqual({ do: "recall", card });
    });

    it("does not ask for the card just shown when another is ready", () => {
      // Straight back to the same card is massing at its most extreme.
      const a = awaiting("c1", "w1", NOW);
      const b = awaiting("c2", "w2", new Date(NOW.getTime() + 1000));
      expect(ask({ cards: [a, b], exposed: new Set(["c1", "c2"]), justShownId: "c2" })).toEqual({
        do: "recall",
        card: a,
      });
    });

    it("prefers pulling a learning card forward over asking straight back", () => {
      // An early review costs a little stability once. A rating #1 taken from
      // the short-term buffer misprices the card for its whole life.
      const shown = awaiting("c1", "w1");
      const soon = scheduled("c2", "w2", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [shown, soon], exposed: new Set(["c1"]), justShownId: "c1" })).toEqual({
        do: "recall",
        card: soon,
      });
    });
  });

  describe("8. asking straight back, when there is nothing else at all", () => {
    it("does ask for it rather than never asking", () => {
      // Refusing outright would show a lone word and never ask for it — again on
      // the next sitting, and the one after that.
      const card = awaiting("c1", "w1");
      expect(ask({ cards: [card], exposed: new Set(["c1"]), justShownId: "c1" })).toEqual({
        do: "recall",
        card,
      });
    });
  });

  describe("7. pulling a learning card forward", () => {
    it("fills the gap rather than waiting", () => {
      const soon = scheduled("c1", "w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [soon], words: [] })).toEqual({ do: "recall", card: soon });
    });

    it("never hands back the card just answered", () => {
      // With one candidate left this would be massing with extra steps. Ending
      // is better: tomorrow will fill the gap properly.
      const soon = scheduled("c1", "w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [soon], words: [], justShownId: "c1" })).toEqual({ do: "done" });
    });

    it("takes a different card when one is available", () => {
      const a = scheduled("c1", "w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      const b = scheduled("c2", "w2", State.Learning, new Date(NOW.getTime() + 9 * MINUTE));
      expect(ask({ cards: [a, b], words: [], justShownId: "c1" })).toEqual({
        do: "recall",
        card: b,
      });
    });
  });

  it("is done when nothing is left", () => {
    expect(ask({ cards: [], words: [], allowanceLeft: 5 })).toEqual({ do: "done" });
  });
});
