import { describe, expect, it } from "bun:test";
import { State } from "ts-fsrs";
import { catalogue, createLearner } from "./harness";
import type { Step } from "./harness";
import {
  attemptMismatches,
  closureContradictions,
  exposuresAfterAFirstRecall,
  gradingContradictions,
  historiesNotStartingWithOneGuess,
  recallsWithoutExposure,
  repeatsInARow,
  reviewsDraggedFromTheFuture,
  sittings,
  violations,
} from "./invariants";
import type { Attempt } from "./types";

function history() {
  const learner = createLearner({
    words: catalogue(1),
    newPerDay: 1,
    start: new Date("2026-08-10T09:00:00"),
  });
  learner.sit();
  const exposure = learner.trace.find((s) => s.at === "exposure")!;
  const recall = learner.trace.find((s) => s.at === "recall")!;
  const closed = learner.trace.find((s) => s.at === "closed")!;
  return { learner, exposure, recall, closed };
}

describe("invariant checker negative controls", () => {
  it("accepts a real history and detects missing or late exposure across closes", () => {
    const { learner, exposure, recall, closed } = history();
    expect(violations(learner.trace, learner.attempts)).toEqual([]);
    expect(recallsWithoutExposure([exposure, recall])).toEqual([]);
    expect(recallsWithoutExposure([recall])).toEqual([recall]);
    expect(recallsWithoutExposure([exposure, closed, recall])).toEqual([recall]);
    expect(exposuresAfterAFirstRecall([exposure, recall])).toEqual([]);
    expect(exposuresAfterAFirstRecall([recall, exposure])).toEqual([exposure]);
    expect(sittings([exposure, closed, recall])).toEqual([[exposure], [recall]]);
  });

  it("permits conditional repeats only when no other eligible word exists", () => {
    const { exposure, recall } = history();
    const feedback: Step = { ...exposure, at: "feedback" };
    for (const previous of [exposure, feedback]) {
      expect(repeatsInARow([previous, recall])).toEqual([]);
      const next = { ...recall, eligibleWordIds: [recall.wordId, "another-word"] };
      expect(repeatsInARow([previous, next])).toEqual([{ previous, next }]);
    }
    expect(repeatsInARow([recall, recall])).toHaveLength(1);
  });

  it("keeps only guess/exposure and recall/feedback as unconditional pipeline repeats", () => {
    const { learner, exposure, recall } = history();
    const guess = learner.trace.find((s) => s.at === "guess")!;
    const alternatives = { eligibleWordIds: ["w0", "w1"] };
    expect(repeatsInARow([guess, { ...exposure, ...alternatives }])).toEqual([]);
    expect(repeatsInARow([recall, { ...exposure, at: "feedback", ...alternatives }])).toEqual([]);
  });

  it("detects missing and duplicate guesses and contradictory grades", () => {
    const { learner } = history();
    const [guess, recall] = learner.attempts as readonly [Attempt, Attempt];
    expect(historiesNotStartingWithOneGuess(learner.attempts)).toEqual([]);
    expect(historiesNotStartingWithOneGuess([recall])).toHaveLength(1);
    expect(historiesNotStartingWithOneGuess([guess, guess, recall])).toHaveLength(1);
    expect(gradingContradictions(learner.attempts)).toEqual([]);
    for (const bad of [
      { ...guess, rating: 1 as const },
      { ...recall, rating: null },
      { ...recall, correct: true, rating: 1 as const },
      { ...recall, correct: false, rating: 3 as const },
    ])
      expect(gradingContradictions([bad])).toEqual([bad]);
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
      { stateBefore: { ...learner.attempts[1]!.stateBefore, reps: 99 } },
    ];
    for (const change of changes) {
      const altered = [learner.attempts[0]!, { ...learner.attempts[1]!, ...change }];
      expect(attemptMismatches(learner.trace, altered), JSON.stringify(change)).not.toEqual([]);
    }
    expect(attemptMismatches(learner.trace, learner.attempts.slice(1))).not.toEqual([]);
    expect(
      attemptMismatches(learner.trace, [...learner.attempts, learner.attempts[1]!]),
    ).not.toEqual([]);
  });

  it("detects premature done, false caughtUp, wrong due dates and an empty reopen", () => {
    const { closed } = history();
    expect(closureContradictions([closed])).toEqual([]);
    const corrupt: Step[] = [
      { ...closed, reason: "done", nextDueAt: null },
      { ...closed, eligibleWordIds: ["w0"] },
      { ...closed, nextDueAt: closed.nextDueAt! + 1 },
      { ...closed, remainingLearning: [] },
      {
        ...closed,
        nextDueAt: closed.atMs,
        remainingLearning: [{ wordId: "w0", due: closed.atMs }],
      },
      { ...closed, reason: "cut" },
    ];
    for (const step of corrupt) expect(closureContradictions([step])).not.toEqual([]);
    const done: Step = { ...closed, reason: "done", nextDueAt: null, remainingLearning: [] };
    expect(closureContradictions([done])).toEqual([]);
    expect(closureContradictions([{ ...done, eligibleWordIds: ["w0"] }])).not.toEqual([]);
    expect(closureContradictions([closed, { ...done, atMs: closed.nextDueAt! }])).not.toEqual([]);
    expect(closureContradictions([{ ...done, reason: "cut", eligibleWordIds: ["w0"] }])).toEqual(
      [],
    );
  });

  it("rejects future-day reviews at a local rollover but permits today's last millisecond", () => {
    const { learner } = history();
    const boundary = new Date("2026-08-11T04:00:00").getTime();
    const recall: Attempt = {
      ...learner.attempts[1]!,
      reviewedAt: new Date(boundary + 1_000),
      latencyMs: 2_000,
      stateBefore: {
        ...learner.attempts[1]!.stateBefore,
        state: State.Review,
        due: new Date(boundary),
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
        [{ ...recall, stateBefore: { ...recall.stateBefore, state: State.Learning } }],
        4,
      ),
    ).toEqual([]);
  });
});
