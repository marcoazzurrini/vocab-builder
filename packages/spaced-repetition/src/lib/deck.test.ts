import { describe, expect, it } from "bun:test";

import { createEmptyCard } from "ts-fsrs";
import * as v from "valibot";

import type { Word } from "../session/types";
import { buildDeck, reviveFsrsCard, toCard } from "./deck";
import type { StoredCard, Introduction } from "./deck";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const NOW = new Date("2026-08-10T09:00:00");

const parseUnreviewedSchedule = (serialized: string) =>
  v.parse(
    v.record(v.string(), v.union([v.string(), v.number()])),
    JSON.parse(serialized)
  );

const guess = (wordId: string, at: Date): Introduction => ({
  reviewedAt: at.toISOString(),
  wordId,
});

describe("reviving FSRS state from jsonb", () => {
  // The failure this guards against is silent: ts-fsrs would do date arithmetic
  // on strings and schedule wrongly without raising anything.
  it("turns date strings back into Dates", () => {
    const original = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    const roundTripped = reviveFsrsCard(JSON.parse(JSON.stringify(original)));

    expect(roundTripped.due).toBeInstanceOf(Date);
    expect(roundTripped.due.getTime()).toBe(original.due.getTime());
  });

  it("survives a full round trip through a card row", () => {
    const fsrs = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    const card = toCard({
      schedule: JSON.stringify(fsrs),
      wordId: "w1",
    });

    expect(card.fsrs.due).toBeInstanceOf(Date);
    expect(card.fsrs.state).toBe(fsrs.state);
    expect(card.fsrs.reps).toBe(fsrs.reps);
  });

  it("leaves last_review undefined when the card has never been reviewed", () => {
    const revived = reviveFsrsCard(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
      JSON.parse(JSON.stringify(createEmptyCard(new Date())))
    );
    expect(revived.last_review).toBeUndefined();
  });

  it("revives last_review once it exists", () => {
    const reviewed = {
      ...createEmptyCard(new Date()),
      last_review: new Date(),
    };
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(reviewed)));
    expect(revived.last_review).toBeInstanceOf(Date);
  });

  it("defaults learning_steps, which older rows predate", () => {
    const { learning_steps: _, ...withoutSteps } = createEmptyCard(NOW);
    expect(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
      reviveFsrsCard(JSON.parse(JSON.stringify(withoutSteps))).learning_steps
    ).toBe(0);
  });

  it("passes through fields it does not know, so an upstream addition survives", () => {
    // ts-fsrs added learning_steps once already. When it adds the next field,
    // stripping it here would quietly corrupt every card on every load.
    const withNewField = {
      ...parseUnreviewedSchedule(JSON.stringify(createEmptyCard(NOW))),
      decay: 0.2,
    };
    const revived = reviveFsrsCard(withNewField);
    expect(revived).toHaveProperty("decay", 0.2);
  });

  describe("refusing state it cannot read", () => {
    // Each of these used to pass straight through the cast and become a wrong
    // schedule that never raised anything.
    const valid = () =>
      parseUnreviewedSchedule(JSON.stringify(createEmptyCard(NOW)));

    it("rejects an unparseable due date", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a missing due date", () => {
      const { due: _, ...noDue } = valid();
      expect(() => reviveFsrsCard(noDue)).toThrow(/unreadable/iu);
    });

    it("rejects a stability that arrived as a string", () => {
      expect(() => reviveFsrsCard({ ...valid(), stability: "3.4" })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects NaN, which JSON writes as null", () => {
      expect(() => reviveFsrsCard({ ...valid(), difficulty: null })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a state outside the enum", () => {
      expect(() => reviveFsrsCard({ ...valid(), state: 7 })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a negative reps count", () => {
      expect(() => reviveFsrsCard({ ...valid(), reps: -1 })).toThrow(
        /unreadable/iu
      );
    });

    it("names the card, so the row can be found and rebuilt", () => {
      expect(() =>
        reviveFsrsCard({ ...valid(), due: "soon" }, "card-42")
      ).toThrow(/card-42/u);
    });
  });
});

describe("building the deck", () => {
  const words: Word[] = [
    {
      freqRank: 1,
      gloss: "cane",
      hint: null,
      id: "w1",
      image: "🐶",
      kind: "word",
      text: "chien",
    },
  ];

  const cardRow = (wordId: string): StoredCard => ({
    schedule: JSON.stringify(createEmptyCard(NOW)),
    wordId,
  });

  it("builds an awaiting card from a guess with no card row", () => {
    // A guess with no card is a word introduced but never rated — the app
    // closed between the exposure and the first recall. The card is rebuilt
    // from the attempt that defines the stage.
    const deck = buildDeck(words, [], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(checkedFixture(deck.cards[0]).wordId).toBe("w1");
    expect(checkedFixture(deck.cards[0]).fsrs.reps).toBe(0);
  });

  it("does not double a word that has both a guess and a card row", () => {
    const deck = buildDeck(words, [cardRow("w1")], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
  });

  it("tolerates the same guess arriving from both queries", () => {
    // The awaiting query and the today query can overlap; one guess per word
    // makes deduplication exact.
    const deck = buildDeck(
      words,
      [],
      [guess("w1", NOW), guess("w1", NOW)],
      NOW
    );
    expect(deck.cards).toHaveLength(1);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts only words guessed since midnight toward the allowance", () => {
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const deck = buildDeck(
      words,
      [],
      [guess("w1", yesterday), guess("w2", NOW)],
      NOW
    );
    expect(deck.introducedToday).toBe(1);
  });

  it("counts one guessed a minute after midnight", () => {
    const justAfterMidnight = new Date("2026-08-10T00:01:00");
    const deck = buildDeck(words, [], [guess("w1", justAfterMidnight)], NOW);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts a small-hours guess as yesterday's when the day rolls over at four", () => {
    // A 00:30 sitting is still yesterday's sitting: its guesses must not
    // come out of the new day's allowance.
    const halfPastMidnight = new Date("2026-08-10T00:30:00");
    const deck = buildDeck(words, [], [guess("w1", halfPastMidnight)], NOW, 4);
    expect(deck.introducedToday).toBe(0);
  });

  it("revives the dates jsonb threw away", () => {
    const deck = buildDeck(words, [cardRow("w1")], [], NOW);
    expect(checkedFixture(deck.cards[0]).fsrs.due).toBeInstanceOf(Date);
  });
});

describe("deck reconstruction boundaries", () => {
  it("seeds awaiting cards at their exact introduction time, not rebuild time", () => {
    const introducedAt = "2026-08-09T18:23:45.678Z";
    const deck = buildDeck(
      [],
      [],
      [{ reviewedAt: introducedAt, wordId: "old-guess" }],
      NOW
    );
    expect(deck.cards).toHaveLength(1);
    expect(checkedFixture(deck.cards[0]).wordId).toBe("old-guess");
    expect(checkedFixture(deck.cards[0]).fsrs.due.toISOString()).toBe(
      introducedAt
    );
    expect(checkedFixture(deck.cards[0]).fsrs.reps).toBe(0);
    expect(checkedFixture(deck.cards[0]).fsrs.last_review).toBeUndefined();
  });

  for (const hour of [0, 4, 23]) {
    it(`counts start inclusively and next start exclusively at rollover ${hour}`, () => {
      const clock = String(hour).padStart(2, "0");
      const start = new Date(`2026-08-10T${clock}:00:00`);
      const nextStart = new Date(`2026-08-11T${clock}:00:00`);
      const now = new Date(`2026-08-10T${clock}:30:00`);
      const cases = [
        { at: new Date(start.getTime() - 1), count: 0 },
        { at: start, count: 1 },
        { at: new Date(nextStart.getTime() - 1), count: 1 },
        { at: nextStart, count: 0 },
        { at: new Date(nextStart.getTime() + 1), count: 0 },
      ];
      for (const { at, count } of cases) {
        const deck = buildDeck(
          [],
          [],
          [{ reviewedAt: at.toISOString(), wordId: "edge" }],
          now,
          hour
        );
        expect(deck.introducedToday).toBe(count);
        expect(checkedFixture(deck.cards[0]).fsrs.due.getTime()).toBe(
          at.getTime()
        );
      }
    });
  }

  it("counts deduplicated introductions even for stored cards or words outside the current catalogue", () => {
    const guesses = [
      { reviewedAt: NOW.toISOString(), wordId: "stored" },
      { reviewedAt: NOW.toISOString(), wordId: "outside-catalogue" },
      { reviewedAt: NOW.toISOString(), wordId: "stored" },
    ];
    const stored = {
      schedule: JSON.stringify(
        createEmptyCard(new Date("2026-08-01T00:00:00Z"))
      ),
      wordId: "stored",
    };
    const before = JSON.stringify({ guesses, stored });
    const deck = buildDeck([], [stored], guesses, NOW);
    expect(deck.introducedToday).toBe(2);
    expect(deck.cards.map((card) => card.wordId)).toEqual([
      "stored",
      "outside-catalogue",
    ]);
    expect(checkedFixture(deck.cards[0]).fsrs.due.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(JSON.stringify({ guesses, stored })).toBe(before);
  });

  for (const reviewedAt of ["", "not-a-date", "2026-99-99T00:00:00Z"]) {
    for (const carded of [false, true]) {
      it(`names invalid introduction ${JSON.stringify(reviewedAt)} even when carded=${carded}`, () => {
        const rows = carded
          ? [
              {
                schedule: JSON.stringify(createEmptyCard(NOW)),
                wordId: "bad-introduction",
              },
            ]
          : [];
        expect(() =>
          buildDeck([], rows, [{ reviewedAt, wordId: "bad-introduction" }], NOW)
        ).toThrow(/Unreadable introduction time.*bad-introduction/u);
      });
    }
  }

  it("validates every introduction before deduplicating", () => {
    expect(() =>
      buildDeck(
        [],
        [],
        [
          { reviewedAt: "invalid", wordId: "bad-first" },
          { reviewedAt: NOW.toISOString(), wordId: "bad-first" },
        ],
        NOW
      )
    ).toThrow(/bad-first/u);
  });

  for (const schedule of [
    "{",
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...createEmptyCard(NOW), last_review: "never" }),
    JSON.stringify({ ...createEmptyCard(NOW), due: "soon" }),
  ]) {
    it(`names the card for unreadable schedule ${schedule}`, () => {
      const row = { schedule, wordId: "broken-card-42" };
      expect(() => toCard(row)).toThrow(
        /Unreadable scheduling state.*broken-card-42/u
      );
      expect(() => buildDeck([], [row], [], NOW)).toThrow(
        /Unreadable scheduling state.*broken-card-42/u
      );
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
    it(`counts the calendar study day across ${timezone} ${start}`, () => {
      // Isolate TZ from other tests. The explicit offsets are independent of studyDay.
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
          import assert from "node:assert/strict";
          import { buildDeck } from ${JSON.stringify(new URL("deck.ts", import.meta.url).href)};
          const start = new Date(${JSON.stringify(start)}).getTime();
          const nextStart = new Date(${JSON.stringify(nextStart)}).getTime();
          const now = new Date(start + 3600000);
          for (const [at, expected] of [[start - 1, 0], [start, 1], [nextStart - 1, 1], [nextStart, 0]]) {
            const deck = buildDeck([], [], [{ wordId: "edge", reviewedAt: new Date(at).toISOString() }], now, 4);
            assert.equal(deck.introducedToday, expected, new Date(at).toISOString());
            assert.equal(deck.cards[0].fsrs.due.getTime(), at);
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
