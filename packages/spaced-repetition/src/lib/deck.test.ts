import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "bun:test";
import { buildDeck, reviveFsrsCard, toCard } from "./deck";
import type { StoredCard, Introduction } from "./deck";
import type { Word } from "../session/types";

const NOW = new Date("2026-08-10T09:00:00");

describe("reviving FSRS state from jsonb", () => {
  // The failure this guards against is silent: ts-fsrs would do date arithmetic
  // on strings and schedule wrongly without raising anything.
  it("turns date strings back into Dates", () => {
    const original = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    const roundTripped = reviveFsrsCard(JSON.parse(JSON.stringify(original)));

    expect(roundTripped.due).toBeInstanceOf(Date);
    expect(roundTripped.due.getTime()).toBe(original.due.getTime());
  });

  it("survives a full round trip through a card row", () => {
    const fsrs = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    const card = toCard({
      wordId: "w1",
      schedule: JSON.stringify(fsrs),
    });

    expect(card.fsrs.due).toBeInstanceOf(Date);
    expect(card.fsrs.state).toBe(fsrs.state);
    expect(card.fsrs.reps).toBe(fsrs.reps);
  });

  it("leaves last_review undefined when the card has never been reviewed", () => {
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(createEmptyCard(new Date()))));
    expect(revived.last_review).toBeUndefined();
  });

  it("revives last_review once it exists", () => {
    const reviewed = { ...createEmptyCard(new Date()), last_review: new Date() };
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(reviewed)));
    expect(revived.last_review).toBeInstanceOf(Date);
  });

  it("defaults learning_steps, which older rows predate", () => {
    const { learning_steps: _, ...withoutSteps } = createEmptyCard(NOW);
    expect(reviveFsrsCard(JSON.parse(JSON.stringify(withoutSteps))).learning_steps).toBe(0);
  });

  it("passes through fields it does not know, so an upstream addition survives", () => {
    // ts-fsrs added learning_steps once already. When it adds the next field,
    // stripping it here would quietly corrupt every card on every load.
    const withNewField = { ...JSON.parse(JSON.stringify(createEmptyCard(NOW))), decay: 0.2 };
    const revived = reviveFsrsCard(withNewField) as unknown as Record<string, unknown>;
    expect(revived.decay).toBe(0.2);
  });

  describe("refusing state it cannot read", () => {
    // Each of these used to pass straight through the cast and become a wrong
    // schedule that never raised anything.
    const valid = () => JSON.parse(JSON.stringify(createEmptyCard(NOW))) as Record<string, unknown>;

    it("rejects an unparseable due date", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" })).toThrow(/unreadable/i);
    });

    it("rejects a missing due date", () => {
      const { due: _, ...noDue } = valid();
      expect(() => reviveFsrsCard(noDue)).toThrow(/unreadable/i);
    });

    it("rejects a stability that arrived as a string", () => {
      expect(() => reviveFsrsCard({ ...valid(), stability: "3.4" })).toThrow(/unreadable/i);
    });

    it("rejects NaN, which JSON writes as null", () => {
      expect(() => reviveFsrsCard({ ...valid(), difficulty: null })).toThrow(/unreadable/i);
    });

    it("rejects a state outside the enum", () => {
      expect(() => reviveFsrsCard({ ...valid(), state: 7 })).toThrow(/unreadable/i);
    });

    it("rejects a negative reps count", () => {
      expect(() => reviveFsrsCard({ ...valid(), reps: -1 })).toThrow(/unreadable/i);
    });

    it("names the card, so the row can be found and rebuilt", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" }, "card-42")).toThrow(/card-42/);
    });
  });
});

describe("building the deck", () => {
  const words: Word[] = [
    {
      id: "w1",
      text: "chien",
      gloss: "cane",
      hint: null,
      image: "🐶",
      kind: "word",
      freqRank: 1,
    },
  ];

  function cardRow(wordId: string): StoredCard {
    return {
      wordId: wordId,
      schedule: JSON.stringify(createEmptyCard(NOW)),
    };
  }

  function guess(wordId: string, at: Date): Introduction {
    return { wordId: wordId, reviewedAt: at.toISOString() };
  }

  it("builds an awaiting card from a guess with no card row", () => {
    // A guess with no card is a word introduced but never rated — the app
    // closed between the exposure and the first recall. The card is rebuilt
    // from the attempt that defines the stage.
    const deck = buildDeck(words, [], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]!.wordId).toBe("w1");
    expect(deck.cards[0]!.fsrs.reps).toBe(0);
  });

  it("does not double a word that has both a guess and a card row", () => {
    const deck = buildDeck(words, [cardRow("w1")], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
  });

  it("tolerates the same guess arriving from both queries", () => {
    // The awaiting query and the today query can overlap; one guess per word
    // makes deduplication exact.
    const deck = buildDeck(words, [], [guess("w1", NOW), guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts only words guessed since midnight toward the allowance", () => {
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const deck = buildDeck(words, [], [guess("w1", yesterday), guess("w2", NOW)], NOW);
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
    expect(deck.cards[0]!.fsrs.due).toBeInstanceOf(Date);
  });
});

describe("deck reconstruction boundaries", () => {
  it("seeds awaiting cards at their exact introduction time, not rebuild time", () => {
    const introducedAt = "2026-08-09T18:23:45.678Z";
    const deck = buildDeck([], [], [{ wordId: "old-guess", reviewedAt: introducedAt }], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]!.wordId).toBe("old-guess");
    expect(deck.cards[0]!.fsrs.due.toISOString()).toBe(introducedAt);
    expect(deck.cards[0]!.fsrs.reps).toBe(0);
    expect(deck.cards[0]!.fsrs.last_review).toBeUndefined();
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
          [{ wordId: "edge", reviewedAt: at.toISOString() }],
          now,
          hour,
        );
        expect(deck.introducedToday).toBe(count);
        expect(deck.cards[0]!.fsrs.due.getTime()).toBe(at.getTime());
      }
    });
  }

  it("counts deduplicated introductions even for stored cards or words outside the current catalogue", () => {
    const guesses = [
      { wordId: "stored", reviewedAt: NOW.toISOString() },
      { wordId: "outside-catalogue", reviewedAt: NOW.toISOString() },
      { wordId: "stored", reviewedAt: NOW.toISOString() },
    ];
    const stored = {
      wordId: "stored",
      schedule: JSON.stringify(createEmptyCard(new Date("2026-08-01T00:00:00Z"))),
    };
    const before = JSON.stringify({ guesses, stored });
    const deck = buildDeck([], [stored], guesses, NOW);
    expect(deck.introducedToday).toBe(2);
    expect(deck.cards.map((card) => card.wordId)).toEqual(["stored", "outside-catalogue"]);
    expect(deck.cards[0]!.fsrs.due.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(JSON.stringify({ guesses, stored })).toBe(before);
  });

  for (const reviewedAt of ["", "not-a-date", "2026-99-99T00:00:00Z"]) {
    for (const carded of [false, true]) {
      it(`names invalid introduction ${JSON.stringify(reviewedAt)} even when carded=${carded}`, () => {
        const rows = carded
          ? [{ wordId: "bad-introduction", schedule: JSON.stringify(createEmptyCard(NOW)) }]
          : [];
        expect(() =>
          buildDeck([], rows, [{ wordId: "bad-introduction", reviewedAt }], NOW),
        ).toThrow(/Unreadable introduction time.*bad-introduction/);
      });
    }
  }

  it("validates every introduction before deduplicating", () => {
    expect(() =>
      buildDeck(
        [],
        [],
        [
          { wordId: "bad-first", reviewedAt: "invalid" },
          { wordId: "bad-first", reviewedAt: NOW.toISOString() },
        ],
        NOW,
      ),
    ).toThrow(/bad-first/);
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
      const row = { wordId: "broken-card-42", schedule };
      expect(() => toCard(row)).toThrow(/Unreadable scheduling state.*broken-card-42/);
      expect(() => buildDeck([], [row], [], NOW)).toThrow(
        /Unreadable scheduling state.*broken-card-42/,
      );
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
    it(`counts the calendar study day across ${timezone} ${start}`, () => {
      // Isolate TZ from other tests. The explicit offsets are independent of studyDay.
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
          import assert from "node:assert/strict";
          import { buildDeck } from ${JSON.stringify(new URL("./deck.ts", import.meta.url).href)};
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
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
