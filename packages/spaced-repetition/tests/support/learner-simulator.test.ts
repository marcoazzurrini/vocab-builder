import { describe, expect, it } from "bun:test";

import * as v from "valibot";

import { catalogue, createLearner, studyBounds } from "./learner-simulator";
import { attemptMismatches, violations } from "./trace-invariants";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const START = new Date("2026-08-10T09:00:00");

const parseStoredSchedule = (serialized: string) =>
  v.parse(
    v.looseObject({ due: v.string(), reps: v.number() }),
    JSON.parse(serialized)
  );

describe("public generated-history harness", () => {
  it("keeps a saved Review graduation for the next study day after clocks fall back", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
        import assert from "node:assert/strict";
        import { catalogue, createLearner } from ${JSON.stringify(new URL("learner-simulator.ts", import.meta.url).href)};
        import { violations } from ${JSON.stringify(new URL("trace-invariants.ts", import.meta.url).href)};
        const cycle = (values) => { let i = 0; return () => values[i++ % values.length]; };
        const learner = createLearner({
          behaviour: {
            correct: cycle([true, false]),
            effort: () => "easy", msPerPrompt: 1000,
          },
          dayRolloverHour: 2, newPerDay: 1,
          start: new Date("2026-10-25T02:30:00"), words: catalogue(1),
        });
        learner.sit(3);
        learner.wait(60_000);
        learner.sit(1);
        learner.wait(60_000);
        learner.sit(2);
        learner.wait(60_000);
        assert.equal(learner.sit(200).at(-1).reason, "done");
        assert.deepEqual(violations(learner.trace, learner.attempts, 2, learner.teachings), []);
        assert.equal(learner.attempts.length, 3);
        assert.equal(learner.sit(1)[0].reason, "done");
        const nextDay = new Date("2026-10-26T02:00:00+01:00").getTime();
        learner.wait(nextDay - learner.now.getTime() - 1);
        // Even after its elapsed 24-hour interval, Review follows study days.
        assert.equal(learner.sit(1)[0].reason, "done");
        assert.equal(learner.attempts.length, 3);
        learner.wait(1);
        const reopened = learner.sit(1)[0];
        assert.equal(reopened.at, "recall");
        assert.equal(reopened.expectedReps, 3);
        assert.equal(reopened.wordId, "w0");
        assert.deepEqual(violations(learner.trace, learner.attempts, 2, learner.teachings), []);
      `,
      ],
      env: { ...process.env, TZ: "Europe/Rome" },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("charges distinct thinking times to teaching and recalls, including reopen", () => {
    const thinks = [1100, 2300, 4700, 8900];
    let thought = 0;
    const learner = createLearner({
      behaviour: {
        msPerPrompt: () => {
          const duration = checkedFixture(thinks[thought]);
          thought += 1;
          return duration;
        },
      },
      newPerDay: 2,
      start: START,
      words: catalogue(2),
    });
    const first = learner.sit();
    expect(
      first.filter((s) => s.at !== "closed").map((s) => s.actedAt - s.shownAt)
    ).toEqual([1100, 2300]);
    expect(learner.teachings.map((a) => a.latencyMs)).toEqual([1100, 2300]);
    expect(
      learner.teachings.map((a) => a.reviewedAt.getTime() - START.getTime())
    ).toEqual([1100, 3400]);
    expect(learner.attempts).toEqual([]);
    learner.wait(60_000);
    const reopened = learner.sit(2);
    expect(
      reopened
        .filter((s) => s.at !== "closed")
        .map((s) => s.actedAt - s.shownAt)
    ).toEqual([4700, 8900]);
    expect(learner.attempts.map((a) => a.latencyMs)).toEqual([4700, 8900]);
    expect(
      learner.attempts.map((a) => a.reviewedAt.getTime() - START.getTime())
    ).toEqual([68_100, 77_000]);
    expect(attemptMismatches(learner.trace, learner.attempts)).toEqual([]);
    expect(
      violations(learner.trace, learner.attempts, 0, learner.teachings)
    ).toEqual([]);
  });

  it("persists JSON commands and server schedules, restoring completed teaching without repetition", () => {
    const learner = createLearner({
      newPerDay: 1,
      start: START,
      words: catalogue(1),
    });
    learner.sit(1);
    expect(learner.commands).toHaveLength(1);
    expect(learner.commands[0]).toMatchObject({
      expectedReps: 0,
      phase: "teach",
    });
    expect(learner.commands[0]).not.toHaveProperty("rating");
    expect(learner.snapshot.cards).toEqual([]);
    expect(learner.snapshot.guesses).toEqual([]);
    const { reviewedAt } = checkedFixture(learner.commands[0]);
    expect(learner.snapshot.teachings).toEqual([
      {
        initialRecallAt: new Date(
          new Date(reviewedAt).getTime() + 60_000
        ).toISOString(),
        reviewedAt,
        wordId: "w0",
      },
    ]);
    expect(learner.sit(2).map((s) => s.at)).toEqual(["closed"]);
    learner.wait(60_000);
    const resumed = learner.sit(1);
    expect(resumed[0]?.at).toBe("recall");
    expect(learner.snapshot.cards).toHaveLength(1);
    expect(learner.commands).toHaveLength(2);
    const stored = checkedFixture(learner.snapshot.cards[0]);
    const scheduled = parseStoredSchedule(stored.schedule);
    expect(scheduled.due).toBeString();
    expect(scheduled.reps).toBe(1);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    expect(JSON.parse(JSON.stringify(learner.snapshot))).toEqual(
      learner.snapshot
    );
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    expect(JSON.parse(JSON.stringify(learner.commands))).toEqual(
      learner.commands
    );
    const detached = learner.snapshot;
    checkedFixture(detached.cards[0]).schedule =
      "corrupted outside the database";
    expect(learner.snapshot.cards[0]).toEqual(stored);
    learner.wait(24 * 60 * 60_000);
    learner.sit(1);
    const before = checkedFixture(learner.attempts.at(-1)).stateBefore;
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    expect(JSON.parse(JSON.stringify(before))).toEqual(scheduled);
    expect(
      violations(learner.trace, learner.attempts, 0, learner.teachings)
    ).toEqual([]);
  });

  it("records caughtUp with the earliest remaining learning due and reopens at that time", () => {
    const learner = createLearner({
      newPerDay: 1,
      start: START,
      words: catalogue(1),
    });
    const end = checkedFixture(learner.sit().at(-1));
    expect(end.at).toBe("closed");
    if (end.at !== "closed") {
      throw new Error("missing closed marker");
    }
    expect(end.reason).toBe("caughtUp");
    expect(end.eligibleWordIds).toEqual([]);
    expect(end.nextDueAt).toBe(
      Math.min(...end.remainingLearning.map((c) => c.due))
    );
    expect(checkedFixture(end.nextDueAt)).toBeGreaterThan(
      learner.now.getTime()
    );
    learner.wait(checkedFixture(end.nextDueAt) - learner.now.getTime());
    const resumed = learner.sit(1);
    expect(resumed[0]).toMatchObject({
      at: "recall",
      shownAt: end.nextDueAt,
      wordId: "w0",
    });
    expect(
      violations(learner.trace, learner.attempts, 0, learner.teachings)
    ).toEqual([]);
  });

  it("distinguishes a cut from done, including the last allowed action reaching an end screen", () => {
    const learner = createLearner({
      newPerDay: 1,
      start: START,
      words: catalogue(1),
    });
    expect(learner.sit(0).at(-1)).toMatchObject({
      eligibleWordIds: ["w0"],
      reason: "cut",
    });
    expect(learner.commands).toEqual([]);
    expect(learner.sit(3).at(-1)).toMatchObject({ reason: "caughtUp" });
    const idle = createLearner({
      newPerDay: 0,
      start: START,
      words: catalogue(1),
    });
    expect(idle.sit(0).at(-1)).toMatchObject({
      eligibleWordIds: [],
      reason: "done",
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
        end: new Date(`${day}T02:00:00`).getTime() - 1,
        start: previous.getTime(),
      });
      expect(studyBounds(new Date(`${day}T03:00:00`).getTime(), 2)).toEqual({
        end: next.getTime() - 1,
        start: new Date(`${day}T02:00:00`).getTime(),
      });
    }
  });

  it("uses local calendar boundaries across leap days and year ends", () => {
    for (const [at, start, next] of [
      ["2024-03-01T03:59:59", "2024-02-29T04:00:00", "2024-03-01T04:00:00"],
      ["2027-01-01T00:00:00", "2026-12-31T04:00:00", "2027-01-01T04:00:00"],
      ["2026-03-29T04:00:00", "2026-03-29T04:00:00", "2026-03-30T04:00:00"],
    ]) {
      expect(studyBounds(new Date(checkedFixture(at)).getTime(), 4)).toEqual({
        end: new Date(checkedFixture(next)).getTime() - 1,
        start: new Date(checkedFixture(start)).getTime(),
      });
    }
  });
});
