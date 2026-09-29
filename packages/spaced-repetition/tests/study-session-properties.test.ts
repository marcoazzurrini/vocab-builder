import { describe, expect, it } from "bun:test";

import * as fc from "fast-check";

import type { Effort } from "../src/answer-grading";
import { catalogue, createLearner } from "./support/learner-simulator";
import type { Behaviour, Learner } from "./support/learner-simulator";
import {
  attemptMismatches,
  closureContradictions,
  teachingMismatches,
  violations,
} from "./support/trace-invariants";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

/**
 * The session's promises, checked against sequences nobody wrote down.
 *
 * The example tests next door cover the cases we thought of. Every bug this
 * module has shipped was a case we did not: a card written but never rated, a
 * word taught but never recalled, an exposure the rule could not see. Those are
 * reachable states rather than wrong arithmetic, and the way to find a reachable
 * state you have not imagined is to generate the ways of reaching it.
 *
 * So each run here is a whole history — open the app, answer some prompts, close
 * it mid-flow, come back minutes or days later — rebuilt each time from what the
 * previous sitting actually wrote.
 */

// Hundreds of complete histories can exceed Bun's five-second default on shared CI CPUs.
// Give these properties more time without reducing their run counts or other tests' limits.
const HISTORY_TIMEOUT_MS = 30_000;

const NINE_AM = new Date("2026-08-10T09:00:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Local wall-clock dates cover leap days, year ends, DST seasons and rollovers.
const startDates = fc.constantFrom(
  "2024-02-28T23:59:30",
  "2024-02-29T03:59:30",
  "2026-12-31T23:59:30",
  "2026-03-08T01:59:30",
  "2026-03-29T01:59:30",
  "2026-10-25T02:30:00",
  "2026-11-01T01:30:00",
  "2026-08-10T09:00:00",
  "2026-08-10T03:59:30"
);

interface Scenario {
  start: string;
  rollover: number;
  variedCatalogue: boolean;
  words: number;
  newPerDay: number;
  /** One entry per sitting: how many prompts before the app is closed. */
  cuts: number[];
  /** How long the learner stays away between sittings. */
  gaps: number[];
  answers: boolean[];
  efforts: Effort[];
  /**
   * How long each prompt takes, cycled. Up to five minutes, because a learner
   * who lingers on one screen lets cards come due mid-sitting — the shape that
   * made a failed card come straight back through its own feedback, which a
   * fixed 18s pace could never produce.
   */
  thinks: number[];
}

const scenario = (options: { maxGap: number }) =>
  fc.record({
    answers: fc.array(fc.boolean(), { maxLength: 20, minLength: 1 }),
    cuts: fc.array(fc.integer({ max: 15, min: 1 }), {
      maxLength: 8,
      minLength: 1,
    }),
    efforts: fc.array(fc.constantFrom<Effort>("hard", "good", "easy"), {
      maxLength: 8,
      minLength: 1,
    }),
    gaps: fc.array(fc.integer({ max: options.maxGap, min: 0 }), {
      maxLength: 8,
      minLength: 1,
    }),
    newPerDay: fc.integer({ max: 12, min: 0 }),
    rollover: fc.integer({ max: 23, min: 0 }),
    start: startDates,
    thinks: fc.array(fc.integer({ max: 5 * MINUTE, min: 1000 }), {
      maxLength: 10,
      minLength: 1,
    }),
    variedCatalogue: fc.boolean(),
    words: fc.integer({ max: 25, min: 1 }),
  });

const cycleFixture = <T>(values: readonly T[]) => {
  expect(values.length).toBeGreaterThan(0);
  let index = 0;
  return () => {
    const value = checkedFixture(values[index]);
    index = (index + 1) % values.length;
    return value;
  };
};

const behaviourFor = (s: Scenario): Behaviour => ({
  correct: cycleFixture(s.answers),
  effort: cycleFixture(s.efforts),
  msPerPrompt: cycleFixture(s.thinks),
});

/**
 * Play a whole history out.
 *
 * The final sitting is capped rather than run to exhaustion, because a learner
 * who is wrong every single time genuinely never finishes: each wrong answer is
 * rated Again and comes back due in a minute, which is correct — a card you keep
 * failing keeps coming back, exactly as it should. Termination is asserted
 * separately, against a learner who sometimes gets one right.
 */
const wordsFor = (s: Scenario) =>
  catalogue(s.words).map((word, i) =>
    s.variedCatalogue
      ? {
          ...word,
          freqRank: i % 3 === 0 ? null : Math.floor((s.words - i) / 2),
          text: i % 2 ? `l'été ${i}` : `être${i}`,
        }
      : word
  );

const live = (s: Scenario): Learner => {
  const learner = createLearner({
    behaviour: behaviourFor(s),
    dayRolloverHour: s.rollover,
    newPerDay: s.newPerDay,
    start: new Date(s.start),
    words: wordsFor(s),
  });

  for (const [i, cut] of s.cuts.entries()) {
    learner.sit(cut);
    learner.wait(checkedFixture(s.gaps[i % s.gaps.length]));
  }
  learner.sit(200);
  return learner;
};

describe("however the history goes", () => {
  it(
    "holds every invariant",
    () => {
      // The rollover hour is generated too: what "today" means shifts with it,
      // and the invariants must agree with the queue about the boundary at any
      // setting, not just midnight.
      fc.assert(
        fc.property(
          scenario({ maxGap: 3 * DAY }),
          fc.integer({ max: 23, min: 0 }),
          (s, rollover) => {
            const learner = createLearner({
              behaviour: behaviourFor(s),
              dayRolloverHour: rollover,
              newPerDay: s.newPerDay,
              start: new Date(s.start),
              words: wordsFor(s),
            });
            for (const [i, cut] of s.cuts.entries()) {
              learner.sit(cut);
              learner.wait(checkedFixture(s.gaps[i % s.gaps.length]));
            }
            learner.sit(200);
            expect(
              violations(
                learner.trace,
                learner.attempts,
                rollover,
                learner.teachings
              )
            ).toEqual([]);
          }
        ),
        { numRuns: 300 }
      );
    },
    HISTORY_TIMEOUT_MS
  );

  it(
    "ends for any learner who eventually gets each word right",
    () => {
      // A learner who keeps failing a word forever genuinely never finishes: the
      // card is rated Again and comes back due in a minute, which is the
      // scheduler working — that is the leech gap in the README, and a decision
      // rather than a bug. The promise this pins is the complement: stumble on
      // each word a bounded number of times and the session always ends. The
      // earlier form of this property ("one wrong answer in every N") was
      // quietly weaker — cycled across enough slow-paced cards it can pin every
      // wrong answer onto the same word, which is the forever-failing learner
      // again. `sit()` throws rather than hangs if the end never comes, so
      // reaching the assertion at all is most of the property.
      fc.assert(
        fc.property(
          fc.record({
            cuts: fc.array(fc.integer({ max: 15, min: 1 }), {
              maxLength: 8,
              minLength: 1,
            }),
            gaps: fc.array(fc.integer({ max: 7 * DAY, min: 0 }), {
              maxLength: 8,
              minLength: 1,
            }),
            newPerDay: fc.integer({ max: 12, min: 0 }),
            rollover: fc.integer({ max: 23, min: 0 }),
            start: startDates,
            stumbles: fc.array(fc.integer({ max: 3, min: 0 }), {
              maxLength: 25,
              minLength: 1,
            }),
            thinks: fc.array(fc.integer({ max: 5 * MINUTE, min: 1000 }), {
              maxLength: 10,
              minLength: 1,
            }),
            words: fc.integer({ max: 25, min: 1 }),
          }),
          (s) => {
            const nextThinkingTime = cycleFixture(s.thinks);
            const stumblesFor = (id: string) =>
              checkedFixture(
                s.stumbles[Number(id.slice(1)) % s.stumbles.length]
              );
            const learner = createLearner({
              behaviour: {
                correct: (word, n) => n > stumblesFor(word.id),
                msPerPrompt: nextThinkingTime,
              },
              dayRolloverHour: s.rollover,
              newPerDay: s.newPerDay,
              start: new Date(s.start),
              words: catalogue(s.words),
            });

            for (const [i, cut] of s.cuts.entries()) {
              learner.sit(cut);
              learner.wait(checkedFixture(s.gaps[i % s.gaps.length]));
            }
            learner.sit();

            const end = checkedFixture(learner.trace.at(-1));
            expect(end.at).toBe("closed");
            if (end.at !== "closed") {
              throw new Error("missing closed marker");
            }
            expect(end.reason).not.toBe("cut");
            expect(closureContradictions(learner.trace)).toEqual([]);
            expect(
              violations(
                learner.trace,
                learner.attempts,
                s.rollover,
                learner.teachings
              )
            ).toEqual([]);
          }
        ),
        { numRuns: 200 }
      );
    },
    HISTORY_TIMEOUT_MS
  );

  it(
    "reopens caught-up histories at the earliest remaining learning due",
    () => {
      fc.assert(
        fc.property(scenario({ maxGap: 3 * DAY }), (s) => {
          const learner = live(s);
          const end = checkedFixture(learner.trace.at(-1));
          if (end.at !== "closed" || end.reason !== "caughtUp") {
            return;
          }
          expect(closureContradictions(learner.trace)).toEqual([]);
          const due = checkedFixture(end.nextDueAt);
          learner.wait(due - learner.now.getTime());
          const reopened = checkedFixture(learner.sit(1)[0]);
          expect(reopened.at).toBe("recall");
          if (reopened.at !== "recall") {
            throw new Error("reopen did not serve due learning");
          }
          expect(reopened.shownAt).toBe(due);
          expect(
            end.remainingLearning.some(
              (c) => c.wordId === reopened.wordId && c.due === due
            )
          ).toBe(true);
          expect(
            violations(
              learner.trace,
              learner.attempts,
              s.rollover,
              learner.teachings
            )
          ).toEqual([]);
        }),
        { numRuns: 200 }
      );
    },
    HISTORY_TIMEOUT_MS
  );

  it(
    "never exceeds the day's new-word allowance",
    () => {
      // Gaps stay inside the day: the allowance is read once when the app opens,
      // so a sitting that runs past midnight is the UI's problem to solve by
      // reloading, not something the rule can see.
      fc.assert(
        fc.property(scenario({ maxGap: HOUR }), (s) => {
          const learner = createLearner({
            behaviour: behaviourFor(s),
            newPerDay: s.newPerDay,
            start: NINE_AM,
            words: catalogue(s.words),
          });

          for (const [i, cut] of s.cuts.entries()) {
            learner.sit(cut);
            expect(learner.introducedToday).toBeLessThanOrEqual(s.newPerDay);
            learner.wait(checkedFixture(s.gaps[i % s.gaps.length]));
          }
          learner.sit(200);
          expect(learner.introducedToday).toBeLessThanOrEqual(s.newPerDay);
        }),
        { numRuns: 300 }
      );
    },
    HISTORY_TIMEOUT_MS
  );

  it(
    "never shows a word it has not introduced",
    () => {
      // A completed exposure introduces a word durably across sittings.
      fc.assert(
        fc.property(scenario({ maxGap: 2 * DAY }), (s) => {
          const learner = live(s);
          const introduced = new Set<string>();

          for (const step of learner.trace) {
            if (step.at === "closed") {
              continue;
            }
            if (step.at === "exposure") {
              expect(
                introduced.has(step.word),
                "a taught word was re-exposed"
              ).toBe(false);
              introduced.add(step.word);
            } else {
              expect(
                introduced.has(step.word),
                `${step.at} of an unintroduced word`
              ).toBe(true);
            }
          }
        }),
        { numRuns: 200 }
      );
    },
    HISTORY_TIMEOUT_MS
  );

  it(
    "logs one attempt per prompt that takes an answer",
    () => {
      // Recall attempts train FSRS. Completed exposures have separate durable
      // teaching events; neither kind of history may vanish on reopening.
      fc.assert(
        fc.property(scenario({ maxGap: DAY }), (s) => {
          const learner = live(s);
          const answered = learner.trace.filter((step) => step.at === "recall");
          expect(learner.attempts).toHaveLength(answered.length);
          expect(attemptMismatches(learner.trace, learner.attempts)).toEqual(
            []
          );
          expect(teachingMismatches(learner.trace, learner.teachings)).toEqual(
            []
          );
          expect(learner.commands).toHaveLength(
            learner.attempts.length + learner.teachings.length
          );
          expect(learner.commands.map((c) => c.id).length).toBe(
            new Set(learner.commands.map((c) => c.id)).size
          );
        }),
        { numRuns: 200 }
      );
    },
    HISTORY_TIMEOUT_MS
  );
});
