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
// There is no "rated but never guessed", and since attempts were re-keyed by
// word there is no "written but never guessed" either — a card exists in the
// deck only from its guess onward.

/** Guessed and shown, waiting for FSRS's first rating. */
function awaiting(wordId: string, createdAt = NOW): Card {
  return { wordId, fsrs: createEmptyCard(createdAt) };
}

/** Rated at least once. FSRS owns it from here. */
function scheduled(wordId: string, state: State, due: Date): Card {
  return { wordId, fsrs: { ...createEmptyCard(NOW), state, due, reps: 1 } };
}

function ask(q: Partial<Queue> & Pick<Queue, "cards">): Slot {
  return pickNext({
    words: WORDS,
    now: NOW,
    allowanceLeft: 0,
    exposed: new Set(),
    pulledForward: new Set(),
    parked: new Set(),
    ...q,
  });
}

describe("a card's stage", () => {
  it("is awaiting until FSRS has rated it", () => {
    expect(stageOf(awaiting("w1"))).toBe("awaiting");
  });

  it("is scheduled from the first rating onward", () => {
    expect(stageOf(scheduled("w1", State.Learning, NOW))).toBe("scheduled");
  });
});

describe("the next-card rule", () => {
  describe("1. a learning card that is due", () => {
    it("comes before everything else", () => {
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [due], allowanceLeft: 5 })).toEqual({ do: "recall", card: due });
    });

    it("picks the earliest among several", () => {
      const later = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      const earlier = scheduled("w2", State.Learning, new Date(NOW.getTime() - 5 * MINUTE));
      expect(ask({ cards: [later, earlier] })).toEqual({ do: "recall", card: earlier });
    });

    it("skips the card just answered while anything else can go between", () => {
      // Lingering on the feedback screen past the learning step makes the
      // failed card genuinely due at dismissal. Straight back is massing.
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      const shown = awaiting("w2");
      expect(ask({ cards: [due, shown], exposed: new Set(["w2"]), justShownId: "w1" })).toEqual({
        do: "recall",
        card: shown,
      });
    });
  });

  describe("2. a new word", () => {
    it("comes before the reviews, so its second recall lands inside them", () => {
      const review = scheduled("w1", State.Review, NOW);
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

    it("skips a word that is already carded, even unrated", () => {
      // An awaiting card is a word already introduced: its guess is on record
      // and the allowance was spent then. Rules 4 and 5 own it from here.
      expect(ask({ cards: [awaiting("w1")], words: [WORDS[0]!], allowanceLeft: 5 })).toEqual({
        do: "expose",
        card: awaiting("w1"),
      });
    });
  });

  describe("3. a review due today", () => {
    it("follows the new words", () => {
      const review = scheduled("w1", State.Review, NOW);
      expect(ask({ cards: [review], allowanceLeft: 0 })).toEqual({ do: "recall", card: review });
    });

    it("counts one due later tonight as due", () => {
      const tonight = scheduled("w1", State.Review, new Date(NOW.getTime() + 10 * HOUR));
      expect(ask({ cards: [tonight] })).toEqual({ do: "recall", card: tonight });
    });

    it("is never pulled forward from a future day", () => {
      // Three days of earned spacing is not filler for an empty minute.
      const future = scheduled("w1", State.Review, new Date(NOW.getTime() + 72 * HOUR));
      expect(ask({ cards: [future] })).toEqual({ do: "done" });
    });
  });

  describe("4. showing a word waiting for its first recall", () => {
    it("shows it when this sitting has not", () => {
      const card = awaiting("w1");
      expect(ask({ cards: [card] })).toEqual({ do: "expose", card });
    });

    it("shows the whole batch before asking for any of it", () => {
      // The shape a fresh sitting has, and the shape a resumed one must have.
      const a = awaiting("w1", NOW);
      const b = awaiting("w2", new Date(NOW.getTime() + 1000));
      expect(ask({ cards: [a, b], exposed: new Set(["w1"]), justShownId: "w1" })).toEqual({
        do: "expose",
        card: b,
      });
    });

    it("comes after the reviews", () => {
      const review = scheduled("w1", State.Review, NOW);
      const fresh = awaiting("w2");
      expect(ask({ cards: [fresh, review] })).toEqual({ do: "recall", card: review });
    });
  });

  describe("5. asking for a word that has been shown", () => {
    it("asks once the exposure has happened", () => {
      const card = awaiting("w1");
      expect(ask({ cards: [card], exposed: new Set(["w1"]) })).toEqual({ do: "recall", card });
    });

    it("does not ask for the card just shown when another is ready", () => {
      // Straight back to the same card is massing at its most extreme.
      const a = awaiting("w1", NOW);
      const b = awaiting("w2", new Date(NOW.getTime() + 1000));
      expect(ask({ cards: [a, b], exposed: new Set(["w1", "w2"]), justShownId: "w2" })).toEqual({
        do: "recall",
        card: a,
      });
    });

    it("prefers pulling a learning card forward over asking straight back", () => {
      // An early review costs a little stability once. A rating #1 taken from
      // the short-term buffer misprices the card for its whole life.
      const shown = awaiting("w1");
      const soon = scheduled("w2", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [shown, soon], exposed: new Set(["w1"]), justShownId: "w1" })).toEqual({
        do: "recall",
        card: soon,
        pulledForward: true,
      });
    });
  });

  describe("7. asking straight back, when there is nothing else at all", () => {
    it("does ask for it rather than never asking", () => {
      // Refusing outright would show a lone word and never ask for it — again on
      // the next sitting, and the one after that.
      const card = awaiting("w1");
      expect(ask({ cards: [card], exposed: new Set(["w1"]), justShownId: "w1" })).toEqual({
        do: "recall",
        card,
      });
    });
  });

  describe("6. pulling a learning card forward", () => {
    it("fills the gap rather than waiting", () => {
      const soon = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [soon], words: [] })).toEqual({
        do: "recall",
        card: soon,
        pulledForward: true,
      });
    });

    it("never hands back the card just answered", () => {
      // With one candidate left this would be massing with extra steps. Ending
      // is better: tomorrow will fill the gap properly.
      const soon = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [soon], words: [], justShownId: "w1" })).toEqual({ do: "done" });
    });

    it("takes a different card when one is available", () => {
      const a = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      const b = scheduled("w2", State.Learning, new Date(NOW.getTime() + 9 * MINUTE));
      expect(ask({ cards: [a, b], words: [], justShownId: "w1" })).toEqual({
        do: "recall",
        card: b,
        pulledForward: true,
      });
    });

    it("gives each card one free ride and no more", () => {
      // Otherwise the session cannot end: the answer schedules the card a minute
      // out, which is still today, so it is dragged forward again — and with two
      // cards they alternate forever, never repeating and never finishing.
      const a = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      const b = scheduled("w2", State.Learning, new Date(NOW.getTime() + 9 * MINUTE));
      expect(ask({ cards: [a, b], words: [], pulledForward: new Set(["w1", "w2"]) })).toEqual({
        do: "done",
      });
    });

    it("still serves a card that has genuinely come due", () => {
      // The first rule is not capped by the free ride: a card that earned its
      // place is not filler.
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [due], words: [], pulledForward: new Set(["w1"]) })).toEqual({
        do: "recall",
        card: due,
      });
    });
  });

  describe("8. the card just answered, come due again", () => {
    it("is asked again when there is genuinely nothing else", () => {
      // Refusing here would end the session with a card due — the session
      // never waits, in either direction.
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [due], words: [], justShownId: "w1" })).toEqual({
        do: "recall",
        card: due,
      });
    });
  });

  it("is done when nothing is left", () => {
    expect(ask({ cards: [], words: [], allowanceLeft: 5 })).toEqual({ do: "done" });
  });

  describe("a parked word", () => {
    it("is invisible to every rule, even genuinely due", () => {
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [due], words: [], parked: new Set(["w1"]) })).toEqual({ do: "done" });
    });

    it("is not reintroduced as a new word", () => {
      // The bug the parking invariant caught on its first run: hiding parked
      // cards from the whole queue made rule 2 read the word as never
      // introduced, reintroducing it and logging the second guess the schema
      // forbids. Parked means unpickable, not uncarded.
      const due = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(
        ask({ cards: [due], words: [WORDS[0]!], allowanceLeft: 5, parked: new Set(["w1"]) }),
      ).toEqual({ do: "done" });
    });

    it("does not park the rest of the deck with it", () => {
      const parked = scheduled("w1", State.Learning, new Date(NOW.getTime() - MINUTE));
      const fine = scheduled("w2", State.Learning, new Date(NOW.getTime() - MINUTE));
      expect(ask({ cards: [parked, fine], parked: new Set(["w1"]) })).toEqual({
        do: "recall",
        card: fine,
      });
    });
  });
});
