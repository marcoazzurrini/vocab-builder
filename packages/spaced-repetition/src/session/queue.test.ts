import { createEmptyCard, State } from "ts-fsrs";
import { describe, expect, it } from "bun:test";
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

const WORDS: [Word, Word, Word] = [word("w1", 1), word("w2", 2), word("w3", 3)];

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

    it("waits rather than handing back the card just answered", () => {
      // With one candidate left this would be massing with extra steps. Being
      // honestly caught up is better: the card will be served on time.
      const soon = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      expect(ask({ cards: [soon], words: [], justShownId: "w1" })).toEqual({
        do: "wait",
        until: soon.fsrs.due,
      });
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
      // Otherwise the sitting never pauses: the answer schedules the card a
      // minute out, which is still today, so it is dragged forward again — and
      // with two cards they alternate forever. Spent rides mean caught up,
      // until the earliest of them genuinely comes due.
      const a = scheduled("w1", State.Learning, new Date(NOW.getTime() + 8 * MINUTE));
      const b = scheduled("w2", State.Learning, new Date(NOW.getTime() + 9 * MINUTE));
      expect(ask({ cards: [a, b], words: [], pulledForward: new Set(["w1", "w2"]) })).toEqual({
        do: "wait",
        until: a.fsrs.due,
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
});

describe("queue edge cases", () => {
  for (const state of [State.Learning, State.Relearning, State.New]) {
    it(`serves rated state ${state} due exactly now before introducing words`, () => {
      const card = scheduled("w1", state, NOW);
      expect(stageOf(card)).toBe("scheduled");
      expect(ask({ cards: [card], allowanceLeft: 1, pulledForward: new Set(["w1"]) })).toEqual({
        do: "recall",
        card,
      });
    });

    it(`pulls rated state ${state} forward once, then waits`, () => {
      const card = scheduled("w1", state, new Date(NOW.getTime() + MINUTE));
      expect(ask({ cards: [card] })).toEqual({ do: "recall", card, pulledForward: true });
      expect(ask({ cards: [card], pulledForward: new Set(["w1"]) })).toEqual({
        do: "wait",
        until: card.fsrs.due,
      });
    });

    it(`serves spent state ${state} at its due time even if it was just shown`, () => {
      const card = scheduled("w1", state, NOW);
      const later = scheduled("w2", state, new Date(NOW.getTime() + MINUTE));
      expect(
        ask({ cards: [later, card], justShownId: "w1", pulledForward: new Set(["w1", "w2"]) }),
      ).toEqual({ do: "recall", card });
    });

    it(`does not let spent learn-ahead block genuinely due state ${state}`, () => {
      const future = scheduled("w1", state, new Date(NOW.getTime() + MINUTE));
      const due = scheduled("w2", state, NOW);
      expect(
        ask({ cards: [future, due], pulledForward: new Set(["w1", "w2"]), allowanceLeft: 1 }),
      ).toEqual({ do: "recall", card: due });
    });
  }

  for (const state of [State.Learning, State.Relearning, State.New, State.Review]) {
    for (const hour of [0, 4]) {
      it(`excludes rated state ${state} at the next study day, rollover ${hour}`, () => {
        const nextStart = new Date(`2026-08-11T${String(hour).padStart(2, "0")}:00:00`);
        const edge = scheduled("w1", state, nextStart);
        expect(ask({ cards: [edge], dayRolloverHour: hour })).toEqual({ do: "done" });
        expect(
          ask({
            cards: [edge],
            dayRolloverHour: hour,
            justShownId: "w1",
            pulledForward: new Set(["w1"]),
          }),
        ).toEqual({ do: "done" });
        const last = scheduled("w1", state, new Date(nextStart.getTime() - 1));
        expect(ask({ cards: [last], dayRolloverHour: hour })).toEqual(
          state === State.Review
            ? { do: "recall", card: last }
            : { do: "recall", card: last, pulledForward: true },
        );
        if (state !== State.Review) {
          expect(
            ask({ cards: [last], dayRolloverHour: hour, pulledForward: new Set(["w1"]) }),
          ).toEqual({ do: "wait", until: last.fsrs.due });
        }
      });
    }
  }

  it("orders reviews by due date rather than input or frequency rank", () => {
    const later = scheduled("w1", State.Review, NOW);
    const earlier = scheduled("w3", State.Review, new Date(NOW.getTime() - HOUR));
    expect(ask({ cards: [later, earlier] })).toEqual({ do: "recall", card: earlier });
  });

  it("preserves input order for equal due dates without sorting the caller's cards", () => {
    const first = scheduled("w2", State.Learning, NOW);
    const second = scheduled("w1", State.Learning, NOW);
    const cards = [first, second];
    expect(ask({ cards })).toEqual({ do: "recall", card: first });
    expect(cards).toEqual([first, second]);
    expect(ask({ cards: [second, first] })).toEqual({ do: "recall", card: second });
  });

  it("preserves introduction order when awaiting cards have equal timestamps", () => {
    const first = awaiting("w2");
    const second = awaiting("w1");
    expect(ask({ cards: [first, second] })).toEqual({ do: "expose", card: first });
    expect(ask({ cards: [first, second], exposed: new Set(["w1", "w2"]) })).toEqual({
      do: "recall",
      card: first,
    });
  });

  it("puts null frequency ranks after every ranked word without mutating the catalogue", () => {
    const unranked: Word = { ...word("unranked", 1), freqRank: null };
    const ranked = word("ranked", 999_999);
    const words = [unranked, ranked];
    expect(ask({ cards: [], words, allowanceLeft: 1 })).toEqual({ do: "introduce", word: ranked });
    expect(words).toEqual([unranked, ranked]);
    expect(ask({ cards: [awaiting("ranked")], words, allowanceLeft: 1 })).toEqual({
      do: "introduce",
      word: unranked,
    });
  });

  for (const freqRank of [10, null]) {
    it(`preserves catalogue order for tied frequency rank ${freqRank}`, () => {
      const first: Word = { ...word("z", 1), freqRank };
      const second: Word = { ...word("a", 1), freqRank };
      expect(ask({ cards: [], words: [first, second], allowanceLeft: 1 })).toEqual({
        do: "introduce",
        word: first,
      });
      expect(ask({ cards: [], words: [second, first], allowanceLeft: 1 })).toEqual({
        do: "introduce",
        word: second,
      });
    });
  }

  for (const { timezone, start, nextStart } of [
    {
      timezone: "Europe/Rome",
      start: "2026-03-28T04:00:00+01:00",
      nextStart: "2026-03-29T04:00:00+02:00",
    },
    {
      timezone: "Europe/Rome",
      start: "2026-10-24T04:00:00+02:00",
      nextStart: "2026-10-25T04:00:00+01:00",
    },
    {
      timezone: "America/New_York",
      start: "2026-03-07T04:00:00-05:00",
      nextStart: "2026-03-08T04:00:00-04:00",
    },
    {
      timezone: "America/New_York",
      start: "2026-10-31T04:00:00-04:00",
      nextStart: "2026-11-01T04:00:00-05:00",
    },
  ]) {
    it(`uses calendar rather than 24-hour review and learn-ahead boundaries in ${timezone} ${start}`, () => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
          import assert from "node:assert/strict";
          import { createEmptyCard, State } from ${JSON.stringify(import.meta.resolve("ts-fsrs"))};
          import { pickNext } from ${JSON.stringify(new URL("./queue.ts", import.meta.url).href)};
          const now = new Date(new Date(${JSON.stringify(start)}).getTime() + 3600000);
          const nextStart = new Date(${JSON.stringify(nextStart)}).getTime();
          for (const state of [State.Learning, State.Relearning, State.New, State.Review]) {
            const cardAt = (at) => ({ wordId: "edge", fsrs: { ...createEmptyCard(now), reps: 1, state, due: new Date(at) } });
            const ask = (card, spent = false) => pickNext({
              cards: [card], words: [], now, dayRolloverHour: 4, allowanceLeft: 0,
              exposed: new Set(), pulledForward: new Set(spent ? ["edge"] : []),
            });
            const edge = cardAt(nextStart);
            assert.deepEqual(ask(edge), { do: "done" });
            assert.deepEqual(ask(edge, true), { do: "done" });
            const last = cardAt(nextStart - 1);
            assert.deepEqual(ask(last), state === State.Review
              ? { do: "recall", card: last }
              : { do: "recall", card: last, pulledForward: true });
            assert.deepEqual(ask(last, true), state === State.Review
              ? { do: "recall", card: last }
              : { do: "wait", until: last.fsrs.due });
          }
        `,
        ],
        env: { ...process.env, TZ: timezone },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
