import { describe, expect, it } from "bun:test";

import { createSession } from "../src/index";
import { catalogue, createLearner } from "./support/learner-simulator";
import {
  exposuresAfterAFirstRecall,
  firstRecallsTooSoon,
  recallsWithoutExposure,
  repeatsInARow,
  sittings,
  violations,
} from "./support/trace-invariants";

const START = new Date("2026-08-10T09:00:00");

const learner = (words = 6, newPerDay = 6, behaviour = {}) =>
  createLearner({
    behaviour,
    newPerDay,
    start: START,
    words: catalogue(words),
  });

/** The phases of a sitting, as a readable string for assertions. */
const promptSequence = (
  steps: readonly { at: string; word?: string }[]
): string[] =>
  steps.filter((s) => s.at !== "closed").map((s) => `${s.at}:${s.word}`);

describe("a sitting that resumes an earlier one", () => {
  it("does not ask for a word straight after showing it", () => {
    const l = learner();
    // Complete three teachings, then close before any recall.
    l.sit(3);
    l.sit();

    expect(exposuresAfterAFirstRecall(l.trace)).toEqual([]);
    expect(repeatsInARow(l.trace)).toEqual([]);
    expect(firstRecallsTooSoon(l.trace)).toEqual([]);
  });

  it("resumes taught words without exposing them again", () => {
    const l = learner(3, 3);
    l.sit(3);
    expect(promptSequence(l.sit())).toEqual([]);
    expect(l.teachings).toHaveLength(3);
    expect(l.attempts).toEqual([]);
    l.wait(60_000);
    const resumed = l.sit();

    expect(promptSequence(resumed).slice(0, 3)).toEqual([
      "recall:mot0",
      "recall:mot1",
      "recall:mot2",
    ]);
    expect(resumed.some((s) => s.at === "exposure")).toBe(false);
    expect(repeatsInARow(resumed)).toEqual([]);
    expect(l.teachings).toHaveLength(3);
  });

  it("never asks for a word without a completed teaching in some sitting", () => {
    const l = learner();
    for (let i = 0; i < 5; i += 1) {
      l.sit(3);
      l.wait(60_000);
    }
    l.sit();

    expect(recallsWithoutExposure(l.trace)).toEqual([]);
    expect(firstRecallsTooSoon(l.trace)).toEqual([]);
    expect(new Set(l.teachings.map((t) => t.wordId)).size).toBe(
      l.teachings.length
    );
  });

  it("holds every invariant when the app is closed at every possible point", () => {
    const failures: string[] = [];
    for (let cut = 1; cut <= 24; cut += 1) {
      const l = learner();
      l.sit(cut);
      l.sit();
      l.wait(60_000);
      l.sit();
      for (const v of violations(l.trace, l.attempts, 0, l.teachings)) {
        failures.push(`cut ${cut}: ${v}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("waits the full minute for a lone word, then recalls it without re-exposure", () => {
    const l = learner(1, 1);
    const taught = l.sit(1);
    const due = START.getTime() + 18_000 + 60_000;
    expect(promptSequence(taught)).toEqual(["exposure:mot0"]);
    expect(taught.at(-1)).toMatchObject({ nextDueAt: due, reason: "caughtUp" });
    l.wait(59_999);
    expect(promptSequence(l.sit())).toEqual([]);
    expect(l.attempts).toEqual([]);
    expect(l.teachings).toHaveLength(1);
    l.wait(1);
    const resumed = l.sit(1);
    expect(promptSequence(resumed)).toEqual(["recall:mot0"]);
    expect(resumed[0]).toMatchObject({ first: true, shownAt: due });
    expect(l.attempts[0]?.stateBefore.reps).toBe(0);
    expect(violations(l.trace, l.attempts, 0, l.teachings)).toEqual([]);
  });

  it("exposes legacy rowless guesses without charging allowance again", () => {
    const accepted: string[] = [];
    const session = createSession({
      acceptAnswer: (command) => {
        accepted.push(command.phase);
      },
      clock: () => START,
      settings: { dayRolloverHour: 0, lang: "fr", newPerDay: 1 },
      snapshot: {
        cards: [],
        guesses: [{ reviewedAt: START.toISOString(), wordId: "w0" }],
        words: catalogue(2),
      },
    });
    expect(session.view.phase).toBe("exposure");
    session.exposureDone();
    expect(accepted).toEqual(["teach"]);
    expect(session.view).toMatchObject({
      phase: "caughtUp",
      stats: { introduced: 0, recalls: 0 },
    });
  });
});

describe("a word that is never got right", () => {
  it("keeps coming back when answers take long enough for the next recall to become due", () => {
    // Again schedules a minute out. Slow feedback makes the card genuinely due,
    // rather than allowing an endless sequence of premature learning reviews.
    const l = learner(3, 3, { correct: () => false, msPerPrompt: 60_000 });
    const steps = l.sit(120);
    expect(steps.filter((s) => s.at === "recall").length).toBeGreaterThan(30);
    expect(steps.at(-1)).toMatchObject({ at: "closed", reason: "cut" });
  });

  it("still never repeats a card back to back while doing it", () => {
    const l = learner(3, 3, { correct: () => false, msPerPrompt: 60_000 });
    l.sit(120);
    expect(repeatsInARow(l.trace)).toEqual([]);
    expect(firstRecallsTooSoon(l.trace)).toEqual([]);
  });
});

describe("a sitting that starts from nothing", () => {
  it("teaches the whole batch before asking for any of it", () => {
    const l = learner(5, 5);
    const only = l.sit();
    expect(promptSequence(only).slice(0, 5)).toEqual([
      "exposure:mot0",
      "exposure:mot1",
      "exposure:mot2",
      "exposure:mot3",
      "exposure:mot4",
    ]);
    expect(promptSequence(only)[5]).toMatch(/^recall/u);
    expect(firstRecallsTooSoon(l.trace)).toEqual([]);
  });

  it("pauses for spacing, then finishes rather than padding", () => {
    const l = learner(3, 3);
    const first = l.sit();
    expect(first.at(-1)).toMatchObject({
      at: "closed",
      eligibleWordIds: [],
      reason: "caughtUp",
    });
    expect(sittings(l.trace)).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) {
      const end = l.trace.at(-1);
      if (
        end?.at !== "closed" ||
        end.reason !== "caughtUp" ||
        end.nextDueAt === null
      ) {
        break;
      }
      l.wait(end.nextDueAt - l.now.getTime());
      l.sit();
    }
    expect(l.trace.at(-1)).toMatchObject({
      at: "closed",
      eligibleWordIds: [],
      reason: "done",
      remainingLearning: [],
    });
    expect(l.teachings).toHaveLength(3);
    expect(l.attempts.length).toBeGreaterThanOrEqual(3);
    expect(violations(l.trace, l.attempts, 0, l.teachings)).toEqual([]);
  });
});
