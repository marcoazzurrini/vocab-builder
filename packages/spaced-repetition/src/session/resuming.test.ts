import { describe, expect, it } from "bun:test";
import { catalogue, createLearner } from "./harness";
import {
  exposuresAfterAFirstRecall,
  recallsWithoutExposure,
  repeatsInARow,
  sittings,
  violations,
} from "./invariants";

const START = new Date("2026-08-10T09:00:00");

function learner(words = 6, newPerDay = 6, behaviour = {}) {
  return createLearner({ words: catalogue(words), newPerDay, start: START, behaviour });
}

/** The phases of a sitting, as a readable string for assertions. */
function shape(steps: readonly { at: string; word?: string }[]): string[] {
  return steps.filter((s) => s.at !== "closed").map((s) => `${s.at}:${s.word}`);
}

describe("a sitting that resumes an earlier one", () => {
  it("does not ask for a word straight after showing it", () => {
    // The bug: closing the app between an exposure and its recall left three
    // cards guessed-but-never-rated. On reopening, each one was shown and then
    // immediately asked for — the rating that sets initial difficulty measuring
    // the short-term buffer rather than the word.
    const l = learner();
    l.sit(6); // three guesses and three exposures, then the tab closes
    l.sit(); // reopen and finish

    expect(exposuresAfterAFirstRecall(l.trace)).toEqual([]);
    expect(repeatsInARow(l.trace)).toEqual([]);
  });

  it("shows every resumed word again before asking for any of them", () => {
    const l = learner(3, 3);
    l.sit(6); // guess+exposure for all three, then close
    const resumed = l.sit();

    // Three exposures, then three recalls — not three pairs. What follows is
    // the day's learning cards pulled forward, which is the session refusing to
    // wait rather than anything to do with the batch.
    expect(shape(resumed).slice(0, 6)).toEqual([
      "exposure:mot0",
      "exposure:mot1",
      "exposure:mot2",
      "recall:mot0",
      "recall:mot1",
      "recall:mot2",
    ]);
    expect(repeatsInARow(resumed)).toEqual([]);
  });

  it("never asks for a word it has not shown in this sitting", () => {
    const l = learner();
    for (let i = 0; i < 5; i++) l.sit(3);
    l.sit();

    expect(recallsWithoutExposure(l.trace)).toEqual([]);
  });

  it("holds every invariant when the app is closed at every possible point", () => {
    // Rather than guessing which cut is interesting, take them all.
    const failures: string[] = [];
    for (let cut = 1; cut <= 24; cut++) {
      const l = learner();
      l.sit(cut);
      l.sit();
      for (const v of violations(l.trace, l.attempts)) failures.push(`cut ${cut}: ${v}`);
    }
    expect(failures).toEqual([]);
  });

  it("still asks for a lone word it has just shown, because nothing else can fill the gap", () => {
    // The exception the rule has to keep: with one card and nothing else to do,
    // coming straight back is right. Excluding it would show a word and then
    // never ask for it — and next time, and the time after that.
    const l = learner(1, 1);
    l.sit(2); // guess, exposure, close
    const resumed = l.sit();

    expect(shape(resumed)).toEqual(["exposure:mot0", "recall:mot0"]);
  });
});

describe("a word that is never got right", () => {
  it("keeps coming back, so the session does not end on its own", () => {
    // Not a bug, and worth pinning so nobody 'fixes' it: Again schedules the
    // card a minute out, and a minute later it is genuinely due, so it is served
    // by the first rule rather than as filler. A card you keep failing keeps
    // coming back, which is the scheduler working.
    //
    // It does mean a learner who never gets three words right is never told the
    // session is over. Anki's answer is a leech threshold — suspend a card after
    // N lapses — which is a product decision rather than a scheduling one.
    const l = createLearner({
      words: catalogue(3),
      newPerDay: 3,
      start: START,
      behaviour: { correct: () => false },
    });

    const steps = l.sit(120);
    expect(steps.filter((s) => s.at === "recall").length).toBeGreaterThan(30);
    expect(steps.at(-1)).toMatchObject({ at: "closed", reason: "cut" });
  });

  it("still never repeats a card back to back while doing it", () => {
    const l = createLearner({
      words: catalogue(3),
      newPerDay: 3,
      start: START,
      behaviour: { correct: () => false },
    });
    l.sit(120);

    expect(repeatsInARow(l.trace)).toEqual([]);
  });
});

describe("a sitting that starts from nothing", () => {
  it("introduces the whole batch before asking for any of it", () => {
    const l = learner(5, 5);
    const only = l.sit();
    const upToFirstRecall = shape(only).slice(0, 10);

    expect(upToFirstRecall.filter((s) => s.startsWith("recall"))).toEqual([]);
    expect(shape(only)[10]).toMatch(/^recall/);
  });

  it("ends rather than padding, and reports what happened", () => {
    const l = learner(3, 3);
    const steps = l.sit();

    expect(steps.at(-1)).toMatchObject({ at: "closed", reason: "done", eligibleWordIds: [] });
    expect(sittings(l.trace)).toHaveLength(1);
    expect(violations(l.trace, l.attempts)).toEqual([]);
  });
});
