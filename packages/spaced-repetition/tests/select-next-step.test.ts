import { describe, expect, it } from "bun:test";

import { createEmptyCard, State } from "ts-fsrs";

import type { Word } from "../src/restore-progress";
import type { Card } from "../src/review-scheduling";
import { pickNext, stageOf } from "../src/select-next-step";
import type { Queue, Slot } from "../src/select-next-step";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const NOW = new Date("2026-08-10T09:00:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const word = (id: string, freqRank: number): Word => ({
  freqRank,
  gloss: `parola-${id}`,
  hint: null,
  id,
  image: null,
  kind: "word",
  text: `mot-${id}`,
});

const WORDS: [Word, Word, Word] = [word("w1", 1), word("w2", 2), word("w3", 3)];

// The builders below can only make cards the pipeline can actually produce.
// There is no "rated but never guessed", and since attempts were re-keyed by
// word there is no "written but never guessed" either — a card exists in the
// deck only from its guess onward.

/** Guessed and shown, waiting for FSRS's first rating. */
const awaiting = (wordId: string, createdAt = NOW): Card => ({
  fsrs: createEmptyCard(createdAt),
  wordId,
});

/** Rated at least once. FSRS owns it from here. */
const scheduled = (wordId: string, state: State, due: Date): Card => ({
  fsrs: { ...createEmptyCard(NOW), due, reps: 1, state },
  wordId,
});

const ask = (q: Partial<Queue> & Pick<Queue, "cards">): Slot =>
  pickNext({
    allowanceLeft: 0,
    exposed: new Set(),
    now: NOW,
    pulledForward: new Set(),
    words: WORDS,
    ...q,
  });

describe("review spacing within a study day", () => {
  const start = new Date("2026-08-10T04:00:00");

  it.each([
    { expected: "recall", label: "missing review time", lastReview: undefined },
    {
      expected: "recall",
      label: "just before rollover",
      lastReview: new Date(start.getTime() - 1),
    },
    { expected: "done", label: "exactly at rollover", lastReview: start },
    {
      expected: "done",
      label: "later in this study day",
      lastReview: new Date(NOW.getTime() - MINUTE),
    },
  ])("handles a Review card rated $label", ({ expected, lastReview }) => {
    const card = scheduled("w1", State.Review, NOW);
    if (lastReview !== undefined) {
      card.fsrs.last_review = lastReview;
    }
    expect(ask({ cards: [card], dayRolloverHour: 4 })).toEqual(
      expected === "recall" ? { card, do: "recall" } : { do: "done" }
    );
  });

  it.each([State.Learning, State.Relearning, State.New])(
    "keeps genuine due-time service for state %s reviewed today",
    (state) => {
      const card = scheduled("w1", state, NOW);
      card.fsrs.last_review = new Date(NOW.getTime() - MINUTE);
      expect(ask({ cards: [card], dayRolloverHour: 4 })).toEqual({
        card,
        do: "recall",
      });
    }
  );
});

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
      const due = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() - MINUTE)
      );
      expect(ask({ allowanceLeft: 5, cards: [due] })).toEqual({
        card: due,
        do: "recall",
      });
    });

    it("picks the earliest among several", () => {
      const later = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() - MINUTE)
      );
      const earlier = scheduled(
        "w2",
        State.Learning,
        new Date(NOW.getTime() - 5 * MINUTE)
      );
      expect(ask({ cards: [later, earlier] })).toEqual({
        card: earlier,
        do: "recall",
      });
    });

    it("skips the card just answered while anything else can go between", () => {
      // Lingering on the feedback screen past the learning step makes the
      // failed card genuinely due at dismissal. Straight back is massing.
      const due = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() - MINUTE)
      );
      const shown = awaiting("w2");
      expect(
        ask({
          cards: [due, shown],
          exposed: new Set(["w2"]),
          justShownId: "w1",
        })
      ).toEqual({
        card: shown,
        do: "recall",
      });
    });
  });

  describe("2. a new word", () => {
    it("comes before the reviews, so its second recall lands inside them", () => {
      const review = scheduled("w1", State.Review, NOW);
      expect(ask({ allowanceLeft: 1, cards: [review] })).toEqual({
        do: "introduce",
        word: WORDS[1],
      });
    });

    it("is chosen in frequency order", () => {
      const shuffled = [word("w3", 3), word("w1", 1), word("w2", 2)];
      expect(
        ask({ allowanceLeft: 1, cards: [], words: shuffled })
      ).toMatchObject({
        word: { id: "w1" },
      });
    });

    it("is not introduced once the allowance is spent", () => {
      expect(ask({ allowanceLeft: 0, cards: [] })).toEqual({ do: "done" });
    });

    it("skips a word that is already carded, even unrated", () => {
      // An awaiting card is a word already introduced: its guess is on record
      // and the allowance was spent then. Rules 4 and 5 own it from here.
      expect(
        ask({
          allowanceLeft: 5,
          cards: [awaiting("w1")],
          words: [checkedFixture(WORDS[0])],
        })
      ).toEqual({
        card: awaiting("w1"),
        do: "expose",
      });
    });
  });

  describe("3. a review due today", () => {
    it("follows the new words", () => {
      const review = scheduled("w1", State.Review, NOW);
      expect(ask({ allowanceLeft: 0, cards: [review] })).toEqual({
        card: review,
        do: "recall",
      });
    });

    it("counts one due later tonight as due", () => {
      const tonight = scheduled(
        "w1",
        State.Review,
        new Date(NOW.getTime() + 10 * HOUR)
      );
      expect(ask({ cards: [tonight] })).toEqual({
        card: tonight,
        do: "recall",
      });
    });

    it("is never pulled forward from a future day", () => {
      // Three days of earned spacing is not filler for an empty minute.
      const future = scheduled(
        "w1",
        State.Review,
        new Date(NOW.getTime() + 72 * HOUR)
      );
      expect(ask({ cards: [future] })).toEqual({ do: "done" });
    });
  });

  describe("4. showing a word waiting for its first recall", () => {
    it("shows it when this sitting has not", () => {
      const card = awaiting("w1");
      expect(ask({ cards: [card] })).toEqual({ card, do: "expose" });
    });

    it("shows the whole batch before asking for any of it", () => {
      // The shape a fresh sitting has, and the shape a resumed one must have.
      const a = awaiting("w1", NOW);
      const b = awaiting("w2", new Date(NOW.getTime() + 1000));
      expect(
        ask({ cards: [a, b], exposed: new Set(["w1"]), justShownId: "w1" })
      ).toEqual({
        card: b,
        do: "expose",
      });
    });

    it("comes after the reviews", () => {
      const review = scheduled("w1", State.Review, NOW);
      const fresh = awaiting("w2");
      expect(ask({ cards: [fresh, review] })).toEqual({
        card: review,
        do: "recall",
      });
    });
  });

  describe("5. asking for a word that has been shown", () => {
    it("asks once the exposure has happened", () => {
      const card = awaiting("w1");
      expect(ask({ cards: [card], exposed: new Set(["w1"]) })).toEqual({
        card,
        do: "recall",
      });
    });

    it("does not ask for the card just shown when another is ready", () => {
      // Straight back to the same card is massing at its most extreme.
      const a = awaiting("w1", NOW);
      const b = awaiting("w2", new Date(NOW.getTime() + 1000));
      expect(
        ask({
          cards: [a, b],
          exposed: new Set(["w1", "w2"]),
          justShownId: "w2",
        })
      ).toEqual({
        card: a,
        do: "recall",
      });
    });

    it("prefers pulling a learning card forward over asking straight back", () => {
      // An early review costs a little stability once. A rating #1 taken from
      // the short-term buffer misprices the card for its whole life.
      const shown = awaiting("w1");
      const soon = scheduled(
        "w2",
        State.Learning,
        new Date(NOW.getTime() + 8 * MINUTE)
      );
      expect(
        ask({
          cards: [shown, soon],
          exposed: new Set(["w1"]),
          justShownId: "w1",
        })
      ).toEqual({
        card: soon,
        do: "recall",
        pulledForward: true,
      });
    });
  });

  describe("7. asking straight back, when there is nothing else at all", () => {
    it("does ask for it rather than never asking", () => {
      // Refusing outright would show a lone word and never ask for it — again on
      // the next sitting, and the one after that.
      const card = awaiting("w1");
      expect(
        ask({ cards: [card], exposed: new Set(["w1"]), justShownId: "w1" })
      ).toEqual({
        card,
        do: "recall",
      });
    });
  });

  describe("6. pulling a learning card forward", () => {
    it("fills the gap rather than waiting", () => {
      const soon = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() + 8 * MINUTE)
      );
      expect(ask({ cards: [soon], words: [] })).toEqual({
        card: soon,
        do: "recall",
        pulledForward: true,
      });
    });

    it("waits rather than handing back the card just answered", () => {
      // With one candidate left this would be massing with extra steps. Being
      // honestly caught up is better: the card will be served on time.
      const soon = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() + 8 * MINUTE)
      );
      expect(ask({ cards: [soon], justShownId: "w1", words: [] })).toEqual({
        do: "wait",
        until: soon.fsrs.due,
      });
    });

    it("takes a different card when one is available", () => {
      const a = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() + 8 * MINUTE)
      );
      const b = scheduled(
        "w2",
        State.Learning,
        new Date(NOW.getTime() + 9 * MINUTE)
      );
      expect(ask({ cards: [a, b], justShownId: "w1", words: [] })).toEqual({
        card: b,
        do: "recall",
        pulledForward: true,
      });
    });

    it("gives each card one free ride and no more", () => {
      // Otherwise the sitting never pauses: the answer schedules the card a
      // minute out, which is still today, so it is dragged forward again — and
      // with two cards they alternate forever. Spent rides mean caught up,
      // until the earliest of them genuinely comes due.
      const a = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() + 8 * MINUTE)
      );
      const b = scheduled(
        "w2",
        State.Learning,
        new Date(NOW.getTime() + 9 * MINUTE)
      );
      expect(
        ask({ cards: [a, b], pulledForward: new Set(["w1", "w2"]), words: [] })
      ).toEqual({
        do: "wait",
        until: a.fsrs.due,
      });
    });

    it("still serves a card that has genuinely come due", () => {
      // The first rule is not capped by the free ride: a card that earned its
      // place is not filler.
      const due = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() - MINUTE)
      );
      expect(
        ask({ cards: [due], pulledForward: new Set(["w1"]), words: [] })
      ).toEqual({
        card: due,
        do: "recall",
      });
    });
  });

  describe("8. the card just answered, come due again", () => {
    it("is asked again when there is genuinely nothing else", () => {
      // Refusing here would end the session with a card due — the session
      // never waits, in either direction.
      const due = scheduled(
        "w1",
        State.Learning,
        new Date(NOW.getTime() - MINUTE)
      );
      expect(ask({ cards: [due], justShownId: "w1", words: [] })).toEqual({
        card: due,
        do: "recall",
      });
    });
  });

  it("is done when nothing is left", () => {
    expect(ask({ allowanceLeft: 5, cards: [], words: [] })).toEqual({
      do: "done",
    });
  });
});

describe("queue edge cases", () => {
  for (const state of [State.Learning, State.Relearning, State.New]) {
    it(`serves rated state ${state} due exactly now before introducing words`, () => {
      const card = scheduled("w1", state, NOW);
      expect(stageOf(card)).toBe("scheduled");
      expect(
        ask({ allowanceLeft: 1, cards: [card], pulledForward: new Set(["w1"]) })
      ).toEqual({
        card,
        do: "recall",
      });
    });

    it(`pulls rated state ${state} forward once, then waits`, () => {
      const card = scheduled("w1", state, new Date(NOW.getTime() + MINUTE));
      expect(ask({ cards: [card] })).toEqual({
        card,
        do: "recall",
        pulledForward: true,
      });
      expect(ask({ cards: [card], pulledForward: new Set(["w1"]) })).toEqual({
        do: "wait",
        until: card.fsrs.due,
      });
    });

    it(`serves spent state ${state} at its due time even if it was just shown`, () => {
      const card = scheduled("w1", state, NOW);
      const later = scheduled("w2", state, new Date(NOW.getTime() + MINUTE));
      expect(
        ask({
          cards: [later, card],
          justShownId: "w1",
          pulledForward: new Set(["w1", "w2"]),
        })
      ).toEqual({ card, do: "recall" });
    });

    it(`does not let spent learn-ahead block genuinely due state ${state}`, () => {
      const future = scheduled("w1", state, new Date(NOW.getTime() + MINUTE));
      const due = scheduled("w2", state, NOW);
      expect(
        ask({
          allowanceLeft: 1,
          cards: [future, due],
          pulledForward: new Set(["w1", "w2"]),
        })
      ).toEqual({ card: due, do: "recall" });
    });
  }

  for (const state of [
    State.Learning,
    State.Relearning,
    State.New,
    State.Review,
  ]) {
    for (const hour of [0, 4]) {
      it(`excludes rated state ${state} at the next study day, rollover ${hour}`, () => {
        const nextStart = new Date(
          `2026-08-11T${String(hour).padStart(2, "0")}:00:00`
        );
        const edge = scheduled("w1", state, nextStart);
        expect(ask({ cards: [edge], dayRolloverHour: hour })).toEqual({
          do: "done",
        });
        expect(
          ask({
            cards: [edge],
            dayRolloverHour: hour,
            justShownId: "w1",
            pulledForward: new Set(["w1"]),
          })
        ).toEqual({ do: "done" });
        const last = scheduled("w1", state, new Date(nextStart.getTime() - 1));
        expect(ask({ cards: [last], dayRolloverHour: hour })).toEqual(
          state === State.Review
            ? { card: last, do: "recall" }
            : { card: last, do: "recall", pulledForward: true }
        );
        if (state !== State.Review) {
          expect(
            ask({
              cards: [last],
              dayRolloverHour: hour,
              pulledForward: new Set(["w1"]),
            })
          ).toEqual({ do: "wait", until: last.fsrs.due });
        }
      });
    }
  }

  it("orders reviews by due date rather than input or frequency rank", () => {
    const later = scheduled("w1", State.Review, NOW);
    const earlier = scheduled(
      "w3",
      State.Review,
      new Date(NOW.getTime() - HOUR)
    );
    expect(ask({ cards: [later, earlier] })).toEqual({
      card: earlier,
      do: "recall",
    });
  });

  it("preserves input order for equal due dates without sorting the caller's cards", () => {
    const first = scheduled("w2", State.Learning, NOW);
    const second = scheduled("w1", State.Learning, NOW);
    const cards = [first, second];
    expect(ask({ cards })).toEqual({ card: first, do: "recall" });
    expect(cards).toEqual([first, second]);
    expect(ask({ cards: [second, first] })).toEqual({
      card: second,
      do: "recall",
    });
  });

  it("preserves introduction order when awaiting cards have equal timestamps", () => {
    const first = awaiting("w2");
    const second = awaiting("w1");
    expect(ask({ cards: [first, second] })).toEqual({
      card: first,
      do: "expose",
    });
    expect(
      ask({ cards: [first, second], exposed: new Set(["w1", "w2"]) })
    ).toEqual({
      card: first,
      do: "recall",
    });
  });

  it("puts null frequency ranks after every ranked word without mutating the catalogue", () => {
    const unranked: Word = { ...word("unranked", 1), freqRank: null };
    const ranked = word("ranked", 999_999);
    const words = [unranked, ranked];
    expect(ask({ allowanceLeft: 1, cards: [], words })).toEqual({
      do: "introduce",
      word: ranked,
    });
    expect(words).toEqual([unranked, ranked]);
    expect(
      ask({ allowanceLeft: 1, cards: [awaiting("ranked")], words })
    ).toEqual({
      do: "introduce",
      word: unranked,
    });
  });

  for (const freqRank of [10, null]) {
    it(`preserves catalogue order for tied frequency rank ${freqRank}`, () => {
      const first: Word = { ...word("z", 1), freqRank };
      const second: Word = { ...word("a", 1), freqRank };
      expect(
        ask({ allowanceLeft: 1, cards: [], words: [first, second] })
      ).toEqual({
        do: "introduce",
        word: first,
      });
      expect(
        ask({ allowanceLeft: 1, cards: [], words: [second, first] })
      ).toEqual({
        do: "introduce",
        word: second,
      });
    });
  }

  for (const { timezone, start, nextStart } of [
    {
      nextStart: "2026-03-29T04:00:00+02:00",
      start: "2026-03-28T04:00:00+01:00",
      timezone: "Europe/Rome",
    },
    {
      nextStart: "2026-10-25T04:00:00+01:00",
      start: "2026-10-24T04:00:00+02:00",
      timezone: "Europe/Rome",
    },
    {
      nextStart: "2026-03-08T04:00:00-04:00",
      start: "2026-03-07T04:00:00-05:00",
      timezone: "America/New_York",
    },
    {
      nextStart: "2026-11-01T04:00:00-05:00",
      start: "2026-10-31T04:00:00-04:00",
      timezone: "America/New_York",
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
          import { pickNext } from ${JSON.stringify(new URL("../src/select-next-step.ts", import.meta.url).href)};
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
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
