import { describe, expect, it } from "bun:test";

import { createEmptyCard, fsrs, Rating } from "ts-fsrs";

import { evaluateAnswer, RevisionConflict } from "../src/evaluate-answer";
import type { AnswerCommand } from "../src/index";
import { RevisionConflict as SharedRevisionConflict } from "../src/review-scheduling";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const NOW = new Date("2026-08-10T09:00:00.000Z");
const scheduler = fsrs({ enable_short_term: true });
const ID = "e581fc23-29bd-48a2-a842-071f9eb9f406";

// Raw payloads intentionally include combinations that the schema must reject.
type HistoricalCommand = Exclude<AnswerCommand, { phase: "teach" }>;
type CommandOverrides = {
  [Key in keyof HistoricalCommand]?: HistoricalCommand[Key];
};

const recall = (overrides: CommandOverrides = {}) => ({
  expectedReps: 0,
  id: ID,
  latencyMs: 1200,
  phase: "recall",
  rating: Rating.Good,
  reviewedAt: NOW.toISOString(),
  typed: "chien",
  wordId: "chien",
  ...overrides,
});

const reviewedCard = () => {
  const first = scheduler.next(
    createEmptyCard(new Date("2026-08-01T09:00:00Z")),
    new Date("2026-08-01T09:00:00Z"),
    Rating.Good
  ).card;
  return scheduler.next(first, new Date("2026-08-02T09:00:00Z"), Rating.Good)
    .card;
};

const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;

describe("server answer transitions", () => {
  it("exports the shared revision conflict class", () => {
    expect(RevisionConflict).toBe(SharedRevisionConflict);
  });

  for (const [typed, correct] of [
    ["chien", true],
    ["chat", false],
  ] as const) {
    it(`records a ${correct ? "correct" : "wrong"} guess without creating a schedule`, () => {
      const result = evaluateAnswer(
        recall({ phase: "guess", rating: null, typed }),
        "chien",
        undefined,
        NOW
      );
      expect(result.correct).toBe(correct);
      expect(JSON.parse(result.previousSchedule)).toEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
        JSON.parse(JSON.stringify(createEmptyCard(NOW)))
      );
      expect(result.nextSchedule).toBeNull();
      expect(result.revision).toBe(0);
    });
  }

  for (const rating of ratings) {
    it(`handles first recall rating ${rating}`, () => {
      const command = recall({
        rating,
        typed: rating === Rating.Again ? "chat" : "chien",
      });
      if (rating === Rating.Easy) {
        expect(() => evaluateAnswer(command, "chien", undefined, NOW)).toThrow(
          "Easy is unavailable for a first recall."
        );
        return;
      }
      const before = createEmptyCard(NOW);
      // The independent oracle is the real scheduler, not the shared application transition.
      const expected = scheduler.next(before, NOW, rating).card;
      const result = evaluateAnswer(command, "chien", undefined, NOW);
      expect(result.correct).toBe(rating !== Rating.Again);
      expect(JSON.parse(result.previousSchedule)).toEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
        JSON.parse(JSON.stringify(before))
      );
      expect(result.revision).toBe(1);
      expect(result.nextSchedule).not.toBeNull();
      expect(JSON.parse(checkedFixture(result.nextSchedule))).toEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
        JSON.parse(JSON.stringify(expected))
      );
      expect(JSON.parse(checkedFixture(result.nextSchedule))).toMatchObject({
        last_review: NOW.toISOString(),
        reps: 1,
      });
    });

    it(`handles subsequent recall rating ${rating} and preserves previous schedule contents`, () => {
      const before = {
        ...reviewedCard(),
        upstream_extension: { values: [1, "retained"] },
      };
      expect(before.reps).toBe(2);
      const schedule = JSON.stringify(before, null, 2);
      const result = evaluateAnswer(
        recall({
          expectedReps: 2,
          rating,
          typed: rating === Rating.Again ? "chat" : "chien",
        }),
        "chien",
        schedule,
        NOW
      );
      expect(result.correct).toBe(rating !== Rating.Again);
      expect(JSON.parse(result.previousSchedule)).toEqual(JSON.parse(schedule));
      expect(JSON.parse(result.previousSchedule).upstream_extension).toEqual({
        values: [1, "retained"],
      });
      expect(result.revision).toBe(3);
      expect(result.nextSchedule).not.toBeNull();
      expect(JSON.parse(checkedFixture(result.nextSchedule))).toEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
        JSON.parse(JSON.stringify(scheduler.next(before, NOW, rating).card))
      );
      expect(JSON.parse(checkedFixture(result.nextSchedule))).toMatchObject({
        last_review: NOW.toISOString(),
        reps: 3,
      });
      expect(before.reps).toBe(2);
      expect(before.last_review?.toISOString()).toBe(
        "2026-08-02T09:00:00.000Z"
      );
    });

    for (const first of [true, false]) {
      it(`rejects rating ${rating} contradicting the answer on ${first ? "first" : "subsequent"} recall`, () => {
        expect(() =>
          evaluateAnswer(
            recall({
              expectedReps: first ? 0 : 2,
              rating,
              typed: rating === Rating.Again ? "chien" : "chat",
            }),
            "chien",
            first ? undefined : JSON.stringify(reviewedCard()),
            NOW
          )
        ).toThrow("Rating does not match the answer.");
      });
    }
  }

  it("grades normalized correct text rather than trusting a claimed flag", () => {
    const result = evaluateAnswer(
      recall({ typed: " CHIEN " }),
      "chien",
      undefined,
      NOW
    );
    expect(result.correct).toBe(true);
    expect(result.revision).toBe(1);
  });

  for (const expectedReps of [0, 1, 3]) {
    it(`rejects stale or advanced revision ${expectedReps} against revision 2`, () => {
      expect(() =>
        evaluateAnswer(
          recall({ expectedReps }),
          "chien",
          JSON.stringify(reviewedCard()),
          NOW
        )
      ).toThrow(RevisionConflict);
    });
  }

  it("rejects a nonzero revision without a stored card", () => {
    expect(() =>
      evaluateAnswer(recall({ expectedReps: 1 }), "chien", undefined, NOW)
    ).toThrow(RevisionConflict);
  });

  it("rejects a guess against an already reviewed card", () => {
    expect(() =>
      evaluateAnswer(
        recall({ phase: "guess", rating: null }),
        "chien",
        JSON.stringify(reviewedCard()),
        NOW
      )
    ).toThrow(RevisionConflict);
  });

  for (const rating of ratings) {
    it(`rejects a rated guess (${rating})`, () => {
      expect(() =>
        evaluateAnswer(
          recall({ phase: "guess", rating }),
          "chien",
          undefined,
          NOW
        )
      ).toThrow();
    });
  }

  it("rejects a guess carrying nonzero expectedReps", () => {
    expect(() =>
      evaluateAnswer(
        recall({ expectedReps: 2, phase: "guess", rating: null }),
        "chien",
        JSON.stringify(reviewedCard()),
        NOW
      )
    ).toThrow();
  });

  it("rejects an unrated recall", () => {
    expect(() =>
      evaluateAnswer(recall({ rating: null }), "chien", undefined, NOW)
    ).toThrow();
  });

  it("rejects a review one millisecond before last_review even with the correct revision", () => {
    const before = reviewedCard();
    expect(() =>
      evaluateAnswer(
        recall({ expectedReps: 2, reviewedAt: "2026-08-02T08:59:59.999Z" }),
        "chien",
        JSON.stringify(before),
        NOW
      )
    ).toThrow(RevisionConflict);
  });

  it("accepts a review at exactly last_review", () => {
    const before = reviewedCard();
    const at = new Date("2026-08-02T09:00:00.000Z");
    const result = evaluateAnswer(
      recall({ expectedReps: 2, reviewedAt: at.toISOString() }),
      "chien",
      JSON.stringify(before),
      NOW
    );
    expect(result.correct).toBe(true);
    expect(result.revision).toBe(3);
    expect(JSON.parse(checkedFixture(result.nextSchedule))).toEqual(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
      JSON.parse(JSON.stringify(scheduler.next(before, at, Rating.Good).card))
    );
  });

  for (const phase of ["guess", "recall"] as const) {
    it(`accepts ${phase} exactly 300000ms in the future`, () => {
      const result = evaluateAnswer(
        recall({
          phase,
          rating: phase === "guess" ? null : Rating.Good,
          reviewedAt: "2026-08-10T09:05:00.000Z",
        }),
        "chien",
        undefined,
        NOW
      );
      expect(result.correct).toBe(true);
      expect(result.revision).toBe(phase === "guess" ? 0 : 1);
      expect(JSON.parse(result.previousSchedule).due).toBe(
        "2026-08-10T09:05:00.000Z"
      );
    });

    it(`rejects ${phase} 300001ms in the future`, () => {
      expect(() =>
        evaluateAnswer(
          recall({
            phase,
            rating: phase === "guess" ? null : Rating.Good,
            reviewedAt: "2026-08-10T09:05:00.001Z",
          }),
          "chien",
          undefined,
          NOW
        )
      ).toThrow("Review time is in the future. Check your device clock.");
    });
  }

  for (const schedule of [
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...createEmptyCard(NOW), due: "tomorrow" }),
    JSON.stringify({ ...createEmptyCard(NOW), last_review: "never" }),
    JSON.stringify({ ...createEmptyCard(NOW), reps: -1 }),
  ]) {
    it(`rejects corrupt schedule ${schedule}`, () => {
      expect(() => evaluateAnswer(recall(), "chien", schedule, NOW)).toThrow();
    });
  }

  for (const raw of [
    null,
    undefined,
    [],
    "{}",
    42,
    {},
    { ...recall(), id: "not-a-uuid" },
    { ...recall(), reviewedAt: "yesterday" },
    { ...recall(), phase: "exposure" },
    { ...recall(), correct: true },
  ]) {
    it(`rejects malformed raw payload ${JSON.stringify(raw)}`, () => {
      expect(() => evaluateAnswer(raw, "chien", undefined, NOW)).toThrow();
    });
  }
});
