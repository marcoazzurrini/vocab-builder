import { describe, expect, it } from "bun:test";

import { createEmptyCard } from "ts-fsrs";

import { restoreProgress, toCard } from "../src/restore-progress";
import type { Word, StoredCard, Introduction } from "../src/restore-progress";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const NOW = new Date("2026-08-10T09:00:00");

const guess = (wordId: string, at: Date): Introduction => ({
  reviewedAt: at.toISOString(),
  wordId,
});

describe("building the progress", () => {
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
    const progress = restoreProgress(words, [], [guess("w1", NOW)], NOW);
    expect(progress.cards).toHaveLength(1);
    expect(checkedFixture(progress.cards[0]).wordId).toBe("w1");
    expect(checkedFixture(progress.cards[0]).fsrs.reps).toBe(0);
  });

  it("does not double a word that has both a guess and a card row", () => {
    const progress = restoreProgress(
      words,
      [cardRow("w1")],
      [guess("w1", NOW)],
      NOW
    );
    expect(progress.cards).toHaveLength(1);
  });

  it("tolerates the same guess arriving from both queries", () => {
    // The awaiting query and the today query can overlap; one guess per word
    // makes deduplication exact.
    const progress = restoreProgress(
      words,
      [],
      [guess("w1", NOW), guess("w1", NOW)],
      NOW
    );
    expect(progress.cards).toHaveLength(1);
    expect(progress.introducedToday).toBe(1);
  });

  it("counts only words guessed since midnight toward the allowance", () => {
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const progress = restoreProgress(
      words,
      [],
      [guess("w1", yesterday), guess("w2", NOW)],
      NOW
    );
    expect(progress.introducedToday).toBe(1);
  });

  it("counts one guessed a minute after midnight", () => {
    const justAfterMidnight = new Date("2026-08-10T00:01:00");
    const progress = restoreProgress(
      words,
      [],
      [guess("w1", justAfterMidnight)],
      NOW
    );
    expect(progress.introducedToday).toBe(1);
  });

  it("counts a small-hours guess as yesterday's when the day rolls over at four", () => {
    // A 00:30 sitting is still yesterday's sitting: its guesses must not
    // come out of the new day's allowance.
    const halfPastMidnight = new Date("2026-08-10T00:30:00");
    const progress = restoreProgress(
      words,
      [],
      [guess("w1", halfPastMidnight)],
      NOW,
      4
    );
    expect(progress.introducedToday).toBe(0);
  });

  it("revives the dates jsonb threw away", () => {
    const progress = restoreProgress(words, [cardRow("w1")], [], NOW);
    expect(checkedFixture(progress.cards[0]).fsrs.due).toBeInstanceOf(Date);
  });
});

describe("progress reconstruction boundaries", () => {
  it("seeds awaiting cards at their exact introduction time, not rebuild time", () => {
    const introducedAt = "2026-08-09T18:23:45.678Z";
    const progress = restoreProgress(
      [],
      [],
      [{ reviewedAt: introducedAt, wordId: "old-guess" }],
      NOW
    );
    expect(progress.cards).toHaveLength(1);
    expect(checkedFixture(progress.cards[0]).wordId).toBe("old-guess");
    expect(checkedFixture(progress.cards[0]).fsrs.due.toISOString()).toBe(
      introducedAt
    );
    expect(checkedFixture(progress.cards[0]).fsrs.reps).toBe(0);
    expect(checkedFixture(progress.cards[0]).fsrs.last_review).toBeUndefined();
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
        const progress = restoreProgress(
          [],
          [],
          [{ reviewedAt: at.toISOString(), wordId: "edge" }],
          now,
          hour
        );
        expect(progress.introducedToday).toBe(count);
        expect(checkedFixture(progress.cards[0]).fsrs.due.getTime()).toBe(
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
    const progress = restoreProgress([], [stored], guesses, NOW);
    expect(progress.introducedToday).toBe(2);
    expect(progress.cards.map((card) => card.wordId)).toEqual([
      "stored",
      "outside-catalogue",
    ]);
    expect(checkedFixture(progress.cards[0]).fsrs.due.toISOString()).toBe(
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
          restoreProgress(
            [],
            rows,
            [{ reviewedAt, wordId: "bad-introduction" }],
            NOW
          )
        ).toThrow(/Unreadable introduction time.*bad-introduction/u);
      });
    }
  }

  it("validates every introduction before deduplicating", () => {
    expect(() =>
      restoreProgress(
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
      expect(() => restoreProgress([], [row], [], NOW)).toThrow(
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
          import { restoreProgress } from ${JSON.stringify(new URL("../src/restore-progress.ts", import.meta.url).href)};
          const start = new Date(${JSON.stringify(start)}).getTime();
          const nextStart = new Date(${JSON.stringify(nextStart)}).getTime();
          const now = new Date(start + 3600000);
          for (const [at, expected] of [[start - 1, 0], [start, 1], [nextStart - 1, 1], [nextStart, 0]]) {
            const progress = restoreProgress([], [], [{ wordId: "edge", reviewedAt: new Date(at).toISOString() }], now, 4);
            assert.equal(progress.introducedToday, expected, new Date(at).toISOString());
            assert.equal(progress.cards[0].fsrs.due.getTime(), at);
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

describe("restoring a stored card", () => {
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
});
