import { describe, expect, it } from "bun:test";

import { State } from "ts-fsrs";

import type { Attempt } from "../../src/answer-command";
import { catalogue, createLearner } from "./learner-simulator";
import type { Step } from "./learner-simulator";
import {
  attemptMismatches,
  closureContradictions,
  exposuresAfterAFirstRecall,
  gradingContradictions,
  historiesNotStartingWithOneTeaching,
  firstRecallsTooSoon,
  teachingMismatches,
  recallsWithoutExposure,
  repeatsInARow,
  reviewsDraggedFromTheFuture,
  sittings,
  violations,
} from "./trace-invariants";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const history = () => {
  const learner = createLearner({
    newPerDay: 1,
    start: new Date("2026-08-10T09:00:00"),
    words: catalogue(1),
  });
  learner.sit();
  learner.wait(60_000);
  learner.sit();
  const exposure = checkedFixture(
    learner.trace.find((s) => s.at === "exposure")
  );
  const recall = checkedFixture(learner.trace.find((s) => s.at === "recall"));
  const closed = checkedFixture(learner.trace.find((s) => s.at === "closed"));
  return { closed, exposure, learner, recall };
};

describe("invariant checker negative controls", () => {
  it("accepts a real history and detects missing or late exposure across closes", () => {
    const { learner, exposure, recall, closed } = history();
    expect(
      violations(learner.trace, learner.attempts, 0, learner.teachings)
    ).toEqual([]);
    expect(recallsWithoutExposure([exposure, recall])).toEqual([]);
    expect(recallsWithoutExposure([recall])).toEqual([recall]);
    expect(recallsWithoutExposure([exposure, closed, recall])).toEqual([]);
    expect(exposuresAfterAFirstRecall([exposure, recall])).toEqual([]);
    expect(exposuresAfterAFirstRecall([recall, exposure])).toEqual([exposure]);
    expect(sittings([exposure, closed, recall])).toEqual([
      [exposure],
      [recall],
    ]);
  });

  it("permits conditional repeats only when no other eligible word exists", () => {
    const { exposure, recall } = history();
    const feedback: Step = { ...exposure, at: "feedback" };
    for (const previous of [exposure, feedback]) {
      expect(repeatsInARow([previous, recall])).toHaveLength(
        previous.at === "feedback" ? 0 : 1
      );
      const next = {
        ...recall,
        eligibleWordIds: [recall.wordId, "another-word"],
      };
      expect(repeatsInARow([previous, next])).toEqual([{ next, previous }]);
    }
    expect(repeatsInARow([recall, recall])).toHaveLength(1);
  });

  it("keeps only recall/feedback as an unconditional pipeline repeat", () => {
    const { exposure, recall } = history();
    const alternatives = { eligibleWordIds: ["w0", "w1"] };
    expect(
      repeatsInARow([recall, { ...exposure, at: "feedback", ...alternatives }])
    ).toEqual([]);
    expect(
      repeatsInARow([exposure, { ...recall, ...alternatives }])
    ).toHaveLength(1);
  });

  it("detects missing and duplicate teachings and contradictory grades", () => {
    const { learner } = history();
    expect(learner.attempts).toHaveLength(1);
    expect(learner.teachings).toHaveLength(1);
    const teaching = checkedFixture(learner.teachings[0]);
    const recall = checkedFixture(learner.attempts[0]);
    expect(
      historiesNotStartingWithOneTeaching(learner.attempts, learner.teachings)
    ).toEqual([]);
    expect(historiesNotStartingWithOneTeaching([recall], [])).toHaveLength(1);
    expect(
      historiesNotStartingWithOneTeaching([recall], [teaching, teaching])
    ).toHaveLength(1);
    expect(
      historiesNotStartingWithOneTeaching(
        [{ ...recall, phase: "guess" }],
        [teaching]
      )
    ).toHaveLength(1);
    expect(gradingContradictions(learner.attempts)).toEqual([]);
    for (const bad of [
      { ...recall, phase: "guess" as const, rating: 1 as const },
      { ...recall, rating: null },
      { ...recall, correct: true, rating: 1 as const },
      { ...recall, correct: false, rating: 3 as const },
    ]) {
      expect(gradingContradictions([bad])).toEqual([bad]);
    }
  });

  it("detects early first recalls and corrupt teaching events across closes", () => {
    const { learner, exposure, recall, closed } = history();
    expect(firstRecallsTooSoon(learner.trace)).toEqual([]);
    const early = { ...recall, shownAt: exposure.actedAt + 59_999 };
    expect(firstRecallsTooSoon([exposure, closed, early])).toEqual([early]);
    expect(
      firstRecallsTooSoon([
        exposure,
        closed,
        { ...recall, shownAt: exposure.actedAt + 60_000 },
      ])
    ).toEqual([]);
    expect(teachingMismatches(learner.trace, learner.teachings)).toEqual([]);
    expect(teachingMismatches(learner.trace, [])).not.toEqual([]);
    const teaching = checkedFixture(learner.teachings[0]);
    for (const change of [
      { wordId: "wrong" },
      { reviewedAt: new Date(0) },
      { latencyMs: 0 },
      { correct: false },
      { typed: "" },
      { rating: null },
    ]) {
      expect(
        teachingMismatches(learner.trace, [{ ...teaching, ...change }])
      ).not.toEqual([]);
    }
  });

  it("detects each corrupted attempt field even when row counts still match", () => {
    const { learner } = history();
    const changes: Partial<Attempt>[] = [
      { wordId: "wrong-word" },
      { phase: "guess" },
      { typed: "wrong text" },
      { correct: false },
      { rating: 4 },
      { latencyMs: 0 },
      { reviewedAt: new Date(0) },
      {
        stateBefore: {
          ...checkedFixture(learner.attempts[0]).stateBefore,
          reps: 99,
        },
      },
    ];
    for (const change of changes) {
      const altered = [{ ...checkedFixture(learner.attempts[0]), ...change }];
      expect(
        attemptMismatches(learner.trace, altered),
        JSON.stringify(change)
      ).not.toEqual([]);
    }
    expect(
      attemptMismatches(learner.trace, learner.attempts.slice(1))
    ).not.toEqual([]);
    expect(
      attemptMismatches(learner.trace, [
        ...learner.attempts,
        checkedFixture(learner.attempts[0]),
      ])
    ).not.toEqual([]);
  });

  it("detects premature done, false caughtUp, wrong due dates and an empty reopen", () => {
    const { closed } = history();
    expect(closureContradictions([closed])).toEqual([]);
    const corrupt: Step[] = [
      { ...closed, nextDueAt: null, reason: "done" },
      { ...closed, eligibleWordIds: ["w0"] },
      { ...closed, nextDueAt: checkedFixture(closed.nextDueAt) + 1 },
      { ...closed, remainingLearning: [] },
      {
        ...closed,
        nextDueAt: closed.atMs,
        remainingLearning: [{ due: closed.atMs, wordId: "w0" }],
      },
      { ...closed, reason: "cut" },
    ];
    for (const step of corrupt) {
      expect(closureContradictions([step])).not.toEqual([]);
    }
    const done: Step = {
      ...closed,
      nextDueAt: null,
      reason: "done",
      remainingLearning: [],
    };
    expect(closureContradictions([done])).toEqual([]);
    expect(
      closureContradictions([{ ...done, eligibleWordIds: ["w0"] }])
    ).not.toEqual([]);
    expect(
      closureContradictions([
        closed,
        { ...done, atMs: checkedFixture(closed.nextDueAt) },
      ])
    ).not.toEqual([]);
    expect(
      closureContradictions([
        { ...done, eligibleWordIds: ["w0"], reason: "cut" },
      ])
    ).toEqual([]);
  });

  it("rejects future-day reviews at a local rollover but permits today's last millisecond", () => {
    const { learner } = history();
    const boundary = new Date("2026-08-11T04:00:00").getTime();
    const recall: Attempt = {
      ...checkedFixture(learner.attempts[0]),
      latencyMs: 2000,
      reviewedAt: new Date(boundary + 1000),
      stateBefore: {
        ...checkedFixture(learner.attempts[0]).stateBefore,
        due: new Date(boundary),
        state: State.Review,
      },
    };
    // Selection happened before the rollover even though the answer happened after it.
    expect(reviewsDraggedFromTheFuture([recall], 4)).toEqual([recall]);
    const today = {
      ...recall,
      stateBefore: { ...recall.stateBefore, due: new Date(boundary - 1) },
    };
    expect(reviewsDraggedFromTheFuture([today], 4)).toEqual([]);
    expect(
      reviewsDraggedFromTheFuture(
        [
          {
            ...recall,
            stateBefore: { ...recall.stateBefore, state: State.Learning },
          },
        ],
        4
      )
    ).toEqual([]);
  });
});
