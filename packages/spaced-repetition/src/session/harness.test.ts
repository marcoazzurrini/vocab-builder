import { describe, expect, it } from "bun:test";
import { catalogue, createLearner, studyBounds } from "./harness";
import { attemptMismatches, violations } from "./invariants";

const START = new Date("2026-08-10T09:00:00");

describe("public generated-history harness", () => {
  it("charges distinct thinking times to their own answers, including the first guess and reopen", () => {
    const thinks = [1_100, 2_300, 4_700, 8_900, 13_100, 17_300, 19_700, 23_900];
    let thought = 0;
    const learner = createLearner({
      words: catalogue(2),
      newPerDay: 2,
      start: START,
      behaviour: { msPerPrompt: () => thinks[thought++]! },
    });
    const first = learner.sit(5);
    expect(first.filter((s) => s.at !== "closed").map((s) => s.actedAt - s.shownAt)).toEqual(
      thinks.slice(0, 5),
    );
    expect(learner.attempts.map((a) => a.latencyMs)).toEqual([1_100, 4_700, 13_100]);
    expect(learner.attempts.map((a) => a.reviewedAt.getTime() - START.getTime())).toEqual([
      1_100, 8_100, 30_100,
    ]);
    learner.wait(60_000);
    const reopened = learner.sit(2);
    expect(reopened.filter((s) => s.at !== "closed").map((s) => s.actedAt - s.shownAt)).toEqual([
      17_300, 19_700,
    ]);
    expect(attemptMismatches(learner.trace, learner.attempts)).toEqual([]);
    expect(learner.attempts.every((a) => a.latencyMs > 0)).toBe(true);
  });

  it("persists JSON commands and server schedules, rebuilding rowless guesses without re-guessing", () => {
    const learner = createLearner({ words: catalogue(1), newPerDay: 1, start: START });
    learner.sit(1);
    expect(learner.commands).toHaveLength(1);
    expect(learner.commands[0]).toMatchObject({ phase: "guess", expectedReps: 0, rating: null });
    expect(learner.snapshot.cards).toEqual([]);
    expect(learner.snapshot.guesses).toEqual([
      { wordId: "w0", reviewedAt: learner.commands[0]!.reviewedAt },
    ]);
    const resumed = learner.sit(2);
    expect(resumed.slice(0, 2).map((s) => s.at)).toEqual(["exposure", "recall"]);
    expect(learner.snapshot.cards).toHaveLength(1);
    expect(learner.commands).toHaveLength(2);
    const stored = learner.snapshot.cards[0]!;
    const scheduled = JSON.parse(stored.schedule);
    expect(typeof scheduled.due).toBe("string");
    expect(scheduled.reps).toBe(1);
    expect(JSON.parse(JSON.stringify(learner.snapshot))).toEqual(learner.snapshot);
    expect(JSON.parse(JSON.stringify(learner.commands))).toEqual(learner.commands);
    const detached = learner.snapshot;
    detached.cards[0]!.schedule = "corrupted outside the database";
    expect(learner.snapshot.cards[0]).toEqual(stored);
    learner.wait(24 * 60 * 60_000);
    learner.sit(1);
    const before = learner.attempts.at(-1)!.stateBefore;
    expect(JSON.parse(JSON.stringify(before))).toEqual(scheduled);
    expect(violations(learner.trace, learner.attempts)).toEqual([]);
  });

  it("records caughtUp with the earliest remaining learning due and reopens at that time", () => {
    const learner = createLearner({ words: catalogue(1), newPerDay: 1, start: START });
    const end = learner.sit().at(-1)!;
    expect(end.at).toBe("closed");
    if (end.at !== "closed") throw new Error("missing closed marker");
    expect(end.reason).toBe("caughtUp");
    expect(end.eligibleWordIds).toEqual([]);
    expect(end.nextDueAt).toBe(Math.min(...end.remainingLearning.map((c) => c.due)));
    expect(end.nextDueAt!).toBeGreaterThan(learner.now.getTime());
    learner.wait(end.nextDueAt! - learner.now.getTime());
    const resumed = learner.sit(1);
    expect(resumed[0]).toMatchObject({ at: "recall", wordId: "w0", shownAt: end.nextDueAt });
    expect(violations(learner.trace, learner.attempts)).toEqual([]);
  });

  it("distinguishes a cut from done, including the last allowed action reaching an end screen", () => {
    const learner = createLearner({ words: catalogue(1), newPerDay: 1, start: START });
    expect(learner.sit(0).at(-1)).toMatchObject({ reason: "cut", eligibleWordIds: ["w0"] });
    expect(learner.commands).toEqual([]);
    expect(learner.sit(3).at(-1)).toMatchObject({ reason: "caughtUp" });
    const idle = createLearner({ words: catalogue(1), newPerDay: 0, start: START });
    expect(idle.sit(0).at(-1)).toMatchObject({
      reason: "done",
      eligibleWordIds: [],
      remainingLearning: [],
    });
  });

  it("does not carry a normalized DST rollover hour into adjacent days", () => {
    for (const day of ["2026-03-08", "2026-03-29", "2026-10-04"]) {
      const nominal = new Date(`${day}T12:00:00`);
      const previous = new Date(nominal);
      previous.setDate(previous.getDate() - 1);
      previous.setHours(2, 0, 0, 0);
      const next = new Date(nominal);
      next.setDate(next.getDate() + 1);
      next.setHours(2, 0, 0, 0);
      expect(studyBounds(new Date(`${day}T01:59:59`).getTime(), 2)).toEqual({
        start: previous.getTime(),
        end: new Date(`${day}T02:00:00`).getTime() - 1,
      });
      expect(studyBounds(new Date(`${day}T03:00:00`).getTime(), 2)).toEqual({
        start: new Date(`${day}T02:00:00`).getTime(),
        end: next.getTime() - 1,
      });
    }
  });

  it("uses local calendar boundaries across leap days and year ends", () => {
    for (const [at, start, next] of [
      ["2024-03-01T03:59:59", "2024-02-29T04:00:00", "2024-03-01T04:00:00"],
      ["2027-01-01T00:00:00", "2026-12-31T04:00:00", "2027-01-01T04:00:00"],
      ["2026-03-29T04:00:00", "2026-03-29T04:00:00", "2026-03-30T04:00:00"],
    ]) {
      expect(studyBounds(new Date(at!).getTime(), 4)).toEqual({
        start: new Date(start!).getTime(),
        end: new Date(next!).getTime() - 1,
      });
    }
  });
});
